// Discovery and opening of Alethe's report.html files. Pure helpers plus orchestration over an
// injected host, so every path — including a failing one — is testable without a live Orca.
// The manifest grants only workspace:read, terminal:send and terminal:read: every host call
// below stays inside those three, and every terminal opened here is closed in a `finally`.

/** What the workers' host calls look like: a method name and its params, unknown until answered. */
export type Host = {
  call(method: string, params: Record<string, unknown>): Promise<unknown>
}

/** `list-reports`' answer: the paths found (newest first, at most 50), or why there are none. */
export type ReportList = { reports: Array<{ path: string }>; error?: string }

/** `open-report`' answer; `via` says how it opened (Task 4's `editor-tab` arm is RESERVED and unused: Task 4 decided the browser-tab works). */
export type OpenResult = {
  opened: boolean
  via: 'browser-tab' | 'editor-tab' | 'none'
  error?: string
}

/** `setup-report`'s answer: one click's whole outcome, as data — never an exception. */
export type SetupResult = {
  status: 'generated' | 'no-runs' | 'failed'
  /** Whether THIS call installed alethe (a pre-existing install answers `false`). */
  installed: boolean
  /** Human message for the panel's inline note. */
  detail: string
  /** Absolute report.html path, only when `status` is `generated`. */
  path?: string
}

/** Where Alethe's orchestrations (and each wave's report.html) live. */
const ORCHESTRATIONS = '~/.config/alethe/orchestrations'

/** Where the alethe skill is installed (or cloned to), relative to the home directory. */
const ALETHE_SKILL = '~/.agents/skills/alethe'

/**
 * `ls -t` sorts its arguments newest-first; `{} +` batches so the sort stays global across
 * batches at our scale. Portable: works with BSD/macOS and GNU find alike.
 */
export function findCommand(): string {
  return `find ${ORCHESTRATIONS} -name report.html -type f -exec ls -t {} + 2>/dev/null`
}

export function isReportPath(p: string): boolean {
  return p.endsWith('/report.html')
}

export function parseFindOutput(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(isReportPath)
}

/** Bounded waits: a local `find` and `orca tab create` settle well inside these. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Wraps `value` in single quotes for the shell, escaping any embedded single quote as `'\''`.
 * Interpolating a path unquoted lets `"`, `$` or backticks run arbitrary commands, so every
 * value that reaches a command line goes through this helper.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Best effort: a failed close must not mask the result the caller already has. */
async function closeQuietly(host: Host, terminalId: string | undefined): Promise<void> {
  if (!terminalId) return
  try {
    await host.call('terminal.close', { terminalId })
  } catch {
    /* best effort */
  }
}

/** Runs `find` for report.html in a throwaway terminal and answers with its paths, newest
 *  first (`ls -t`), at most 50. */
export async function listReports(host: Host): Promise<ReportList> {
  let terminalId: string | undefined
  try {
    const ctx = (await host.call('workspace.readContext', {})) as { workspaceId?: string } | null
    const workspaceId = ctx?.workspaceId
    if (!workspaceId) return { reports: [], error: 'nenhum workspace focado' }
    const created = (await host.call('terminal.create', {
      workspaceId,
      title: 'alethe-report: find',
      command: findCommand()
    })) as { terminalId: string }
    terminalId = created.terminalId
    await sleep(1500)
    const read = (await host.call('terminal.read', {
      terminalId,
      maxLines: 500
    })) as { lines: string[] }
    const paths = parseFindOutput(read.lines.join('\n')).slice(0, 50)
    return { reports: paths.map((path) => ({ path })) }
  } catch (err) {
    return { reports: [], error: String(err) }
  } finally {
    await closeQuietly(host, terminalId)
  }
}

/**
 * Decides from `orca tab create --json` output whether the tab opened. Success is ONLY a
 * literal `"ok": true`; empty output, `command not found` and `"ok": false` all fail, and the
 * failure carries the trimmed output so the panel can show what the terminal actually said.
 */
export function judgeTabCreate(output: string): { ok: boolean; error?: string } {
  if (/"ok"\s*:\s*true\b/.test(output)) return { ok: true }
  return { ok: false, error: output.trim() }
}

/**
 * Opens one report.html in a browser tab through `orca tab create --url file://… --json`.
 * The path is shell-quoted (a name with spaces, `"` or `$` must never become shell syntax) and
 * success is judged only from the command's JSON, polled until it answers or 5s elapse — an
 * empty read on a slow machine, or `command not found` when orca is off PATH, is a failure.
 * No `editor.open` fallback here: the manifest has no workspace:write, so that call would be
 * `capability_denied` at runtime; when the terminal reports failure the answer carries what it
 * said and `via` stays 'none' (the `editor-tab` arm of `via` is RESERVED and unused: Task 4
 * decided the browser-tab works).
 */
export async function openReport(host: Host, path: string): Promise<OpenResult> {
  let terminalId: string | undefined
  try {
    const ctx = (await host.call('workspace.readContext', {})) as { workspaceId?: string } | null
    const workspaceId = ctx?.workspaceId
    if (!workspaceId) return { opened: false, via: 'none', error: 'nenhum workspace focado' }
    const created = (await host.call('terminal.create', {
      workspaceId,
      title: 'alethe-report: open',
      command: `orca tab create --url ${shellQuote(`file://${path}`)} --json`
    })) as { terminalId: string }
    terminalId = created.terminalId
    // Poll instead of a fixed sleep: slow machines need longer than one shot, and a read that
    // is still empty when the deadline passes is "no answer", never success.
    const deadline = Date.now() + 5000
    let out = ''
    for (;;) {
      await sleep(400)
      const read = (await host.call('terminal.read', {
        terminalId,
        maxLines: 50
      })) as { lines: string[] }
      out = read.lines.join('\n')
      if (out.trim() !== '' || Date.now() >= deadline) break
    }
    if (out.trim() === '') {
      return { opened: false, via: 'none', error: 'sem resposta do orca tab create' }
    }
    const verdict = judgeTabCreate(out)
    if (!verdict.ok) return { opened: false, via: 'none', error: verdict.error }
    return { opened: true, via: 'browser-tab' }
  } catch (err) {
    return { opened: false, via: 'none', error: String(err) }
  } finally {
    await closeQuietly(host, terminalId)
  }
}

// --- One-click setup: install the skill when it is missing, then generate the report. ---
//
// Every marker below is BROKEN INSIDE the command itself with empty quotes (`echo MISS""ING`):
// a terminal echoes what it ran back into its own output, and a complete token in the command
// line would match before the command had produced anything. `""` splits the word in the
// echoed SOURCE (so the echo can never carry a whole marker) while the shell prints the clean
// word: `MISS""ING` prints `MISSING`. The old `MISS"_"ING` was WRONG — the `_` inside quotes
// is literal, so the shell printed `MISS_ING`, the first poll always ran to its deadline and
// the whole button died on "Não foi possível verificar…". The same `X"_"Y` pattern also left
// complete tokens (a literal `INSTALLED`) in the echoed source, which is why the install step
// is parsed by `parseInstallOutput` below and never by the bare word.

/** Step 1: is the skill's orchestrate.py already installed? */
export function checkCommand(): string {
  return `test -f ${ALETHE_SKILL}/scripts/orchestrate.py && echo INSTAL""LED || echo MISS""ING`
}

/**
 * Step 1's install: clone the (private) repo with the machine's own git/gh credentials — the
 * only portable source once the plugin runs away from this repository — and copy the skill
 * into place. Success and failure are told apart by the two markers at the end.
 */
export function installCommand(): string {
  return (
    'rm -rf /tmp/alethe-setup-$$ && git clone --depth 1 https://github.com/gustavoml12/alethe-orca /tmp/alethe-setup-$$ >/dev/null 2>&1 && ' +
    `mkdir -p ~/.agents/skills && rm -rf ${ALETHE_SKILL} && cp -r /tmp/alethe-setup-$$/skill/skills/alethe ${ALETHE_SKILL} && ` +
    'rm -rf /tmp/alethe-setup-$$ && echo INSTAL""LED_OK || echo INSTALL""_FAILED'
  )
}

/** Step 2: the newest orchestration folder, and whether it holds a run yet. */
export function folderCommand(): string {
  return (
    `f=$(ls -td ${ORCHESTRATIONS}/*/ 2>/dev/null | head -1); ` +
    'if [ -z "$f" ]; then echo NO""_ORCH; elif [ -f "$f/state.json" ] || ls "$f"*/state.json >/dev/null 2>&1; then echo FOLDER""=$f; else echo NO""_RUNS; fi'
  )
}

/**
 * Step 3: render the report next to its run. `--no-open` because the PANEL opens it in Orca's
 * embedded browser through `open-report`, not in the external default browser. The folder is
 * shell-quoted even though it comes from our own find output — same discipline as every other
 * value that reaches a command line here.
 */
export function writeCommand(folder: string): string {
  const report = `${folder}/report.html`
  return (
    `python3 ${ALETHE_SKILL}/scripts/orchestrate.py report ${shellQuote(folder)} --format html ` +
    `--write ${shellQuote(report)} --no-open >/dev/null 2>&1 && test -f ${shellQuote(report)} ` +
    '&& echo WROTE""_OK || echo WROTE""_FAIL'
  )
}

/**
 * The marker whose LAST occurrence in `text` sits latest, longest first on a tie. A terminal
 * that echoes its command would otherwise decide the parse: the result line always comes after
 * the echo, so the real answer wins.
 */
function lastMarker(text: string, markers: readonly string[]): string | undefined {
  let best: string | undefined
  let bestAt = -1
  for (const marker of markers) {
    const at = text.lastIndexOf(marker)
    if (at > bestAt || (at === bestAt && best !== undefined && marker.length > best.length)) {
      best = marker
      bestAt = at
    }
  }
  return bestAt === -1 ? undefined : best
}

/** What step 1's output says: already there, missing (install it), or unreadable. */
export type SetupCheck = 'installed' | 'missing' | 'failed'

export function parseSetupCheck(output: string): SetupCheck {
  const marker = lastMarker(output, ['INSTALLED_OK', 'INSTALLED', 'MISSING', 'INSTALL_FAILED'])
  if (marker === 'MISSING') return 'missing'
  if (marker === 'INSTALLED_OK' || marker === 'INSTALLED') return 'installed'
  return 'failed'
}

/**
 * Step 1's install verdict — stricter than `parseSetupCheck` on purpose. Only the two markers
 * the install command itself prints count: a bare `INSTALLED` (the echo of a command, or the
 * tail of a timed-out clone) is never an install, so an echo-only read can't false-positive.
 */
export function parseInstallOutput(output: string): 'ok' | 'failed' {
  return lastMarker(output, ['INSTALLED_OK', 'INSTALL_FAILED']) === 'INSTALLED_OK' ? 'ok' : 'failed'
}

/** What step 2's output says: no folder at all, a folder without a run, or the folder to use. */
export type SetupFolder = { kind: 'no-orch' } | { kind: 'no-runs' } | { kind: 'found'; folder: string }

export function parseSetupFolder(output: string): SetupFolder {
  const marker = lastMarker(output, ['FOLDER=', 'NO_ORCH', 'NO_RUNS'])
  if (marker === 'NO_ORCH') return { kind: 'no-orch' }
  if (marker !== 'FOLDER=') return { kind: 'no-runs' }
  // The result line is the last one carrying the marker; `lastIndexOf` also survives a PTY that
  // merged echo and result onto one line. A trailing `/` (from the folder glob) is trimmed so
  // `${folder}/report.html` never holds a double slash.
  const line = output
    .split('\n')
    .reverse()
    .find((candidate) => candidate.includes('FOLDER=')) ?? ''
  const folder = line
    .slice(line.lastIndexOf('FOLDER=') + 'FOLDER='.length)
    .trim()
    .replace(/\/+$/, '')
  return folder === '' ? { kind: 'no-runs' } : { kind: 'found', folder }
}

/** Step 3's verdict: only a literal `WROTE_OK` after the command counts as written. */
export function parseSetupWrite(output: string): boolean {
  return lastMarker(output, ['WROTE_OK', 'WROTE_FAIL']) === 'WROTE_OK'
}

/** What the panel shows when there is nothing to report yet, installed or not. */
const NO_TASKS = 'Inicie uma tarefa com /alethe no terminal do projeto e o relatório aparecerá aqui.'
const INSTALLED_NO_TASKS = `Alethe instalado ✓ — nenhuma tarefa orquestrada ainda. ${NO_TASKS}`
const INSTALL_FAILED_DETAIL =
  'Falha ao instalar o alethe (git clone). Confira sua autenticação GitHub (gh auth login) e tente de novo.'

/** Bounded polls per step: a local `test` answers at once, a clone and a render take longer. */
const STEP_DEADLINES = { check: 15_000, install: 120_000, folder: 15_000, write: 180_000 }

/**
 * Runs one step's command in its own ephemeral terminal and returns its output, polling until
 * one of `markers` shows up or the deadline passes. The terminal is closed in the `finally`
 * even when the read or the create fails; a failure propagates to `setupReport`, which answers
 * it as data.
 */
async function runStep(
  host: Host,
  title: string,
  command: string,
  markers: readonly string[],
  deadlineMs: number
): Promise<string> {
  let terminalId: string | undefined
  try {
    const ctx = (await host.call('workspace.readContext', {})) as { workspaceId?: string } | null
    const workspaceId = ctx?.workspaceId
    if (!workspaceId) throw new Error('nenhum workspace focado')
    const created = (await host.call('terminal.create', {
      workspaceId,
      title,
      command
    })) as { terminalId: string }
    terminalId = created.terminalId
    const deadline = Date.now() + deadlineMs
    for (;;) {
      const read = (await host.call('terminal.read', {
        terminalId,
        maxLines: 200
      })) as { lines: string[] }
      const out = read.lines.join('\n')
      if (lastMarker(out, markers) !== undefined || Date.now() >= deadline) return out
      await sleep(400)
    }
  } finally {
    await closeQuietly(host, terminalId)
  }
}

/**
 * The whole one-click flow: check/install the skill, find a folder with a run, generate its
 * report. Three (or four) ephemeral terminals, each closed in its own `finally`, and every
 * failure — no workspace, a refused create, a failed clone — coming back as a `SetupResult`
 * the panel can draw, never as a thrown exception.
 */
export async function setupReport(host: Host): Promise<SetupResult> {
  let installed = false
  try {
    const checked = await runStep(
      host,
      'alethe-report: check',
      checkCommand(),
      ['INSTALLED', 'MISSING'],
      STEP_DEADLINES.check
    )
    const check = parseSetupCheck(checked)
    if (check === 'failed') {
      return {
        status: 'failed',
        installed,
        detail: 'Não foi possível verificar se o alethe está instalado.'
      }
    }
    if (check === 'missing') {
      const installOutput = await runStep(
        host,
        'alethe-report: install',
        installCommand(),
        ['INSTALLED_OK', 'INSTALL_FAILED'],
        STEP_DEADLINES.install
      )
      if (parseInstallOutput(installOutput) !== 'ok') {
        return { status: 'failed', installed, detail: INSTALL_FAILED_DETAIL }
      }
      installed = true
    }
    const folderOutput = await runStep(
      host,
      'alethe-report: runs',
      folderCommand(),
      ['FOLDER=', 'NO_ORCH', 'NO_RUNS'],
      STEP_DEADLINES.folder
    )
    const found = parseSetupFolder(folderOutput)
    if (found.kind !== 'found') {
      return {
        status: 'no-runs',
        installed,
        detail: installed ? INSTALLED_NO_TASKS : NO_TASKS
      }
    }
    const folder = found.folder
    const writeOutput = await runStep(
      host,
      'alethe-report: report',
      writeCommand(folder),
      ['WROTE_OK', 'WROTE_FAIL'],
      STEP_DEADLINES.write
    )
    if (parseSetupWrite(writeOutput)) {
      return {
        status: 'generated',
        installed,
        path: `${folder}/report.html`,
        detail: 'Relatório gerado ✓'
      }
    }
    return { status: 'failed', installed, detail: `orchestrate.py report falhou em ${folder}` }
  } catch (err) {
    return { status: 'failed', installed, detail: String(err) }
  }
}
