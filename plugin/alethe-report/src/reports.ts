// Discovery and opening of Alethe's report.html files. Pure helpers plus orchestration over an
// injected host, so every path — including a failing one — is testable without a live Orca.
// The manifest grants only workspace:read, terminal:send and terminal:read: every host call
// below stays inside those three, and every ephemeral terminal opened here is closed in a
// `finally`. The one exception is `startTask`'s agent terminal: it is the live session the user
// watches, so it is created and deliberately left open.

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

/** `start-task`'s answer: the agent terminal was opened (or why it was not), as data. */
export type StartResult = {
  status: 'started' | 'failed'
  detail: string
}

/** One open issue of the project, as the panel draws it. */
export type IssueItem = { number: number; title: string; url: string; labels: string[] }

/** `list-issues`' answer: the open issues (at most 20), or why there are none. */
export type IssueList = { issues: IssueItem[]; error?: string }

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

/** What the panel shows when there is nothing to report yet — the NEW flow's first step, never
 *  a shell hint: base sentence for a machine without the skill yet… */
const NO_TASKS =
  'Nenhuma tarefa orquestrada ainda — escreva uma tarefa no campo e clique em 🚀 Orquestrar tarefa. (O comando /alethe roda dentro da conversa de um agente, não no shell.)'
/** …and the same sentence after this very call installed the skill (prefix stays verbatim). */
const INSTALLED_NO_TASKS = `Alethe instalado ✓ — ${NO_TASKS}`
const INSTALL_FAILED_DETAIL =
  'Falha ao instalar o alethe (git clone). Confira sua autenticação GitHub (gh auth login) e tente de novo.'
/** The check itself could not be read — a different failure from a clone that refused. */
const CHECK_FAILED_DETAIL = 'Não foi possível verificar se o alethe está instalado.'

/** Bounded polls per step: a local `test` answers at once, a clone and a render take longer. */
const STEP_DEADLINES = { check: 15_000, install: 120_000, folder: 15_000, write: 180_000, issues: 30_000 }

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

/** What `ensureAlethe` answers: the skill is ready (and whether THIS call cloned it), or why not. */
export type EnsureResult =
  | { ok: true; installed: boolean }
  | { ok: false; detail: string }

/**
 * The shared first step of `setupReport` and `startTask`: one check terminal (is the skill's
 * orchestrate.py in place?) and, when it is missing, one install terminal (clone + copy) — the
 * same two commands and their markers for both flows, never a copy of them. `installed` says
 * whether THIS call cloned the skill; `detail` names which step refused, so an unreadable check
 * never reads as a failed clone. A refused create or a missing workspace still throws: the
 * caller answers it as data, exactly as `setupReport` always has.
 */
export async function ensureAlethe(host: Host): Promise<EnsureResult> {
  const checked = await runStep(
    host,
    'alethe-report: check',
    checkCommand(),
    ['INSTALLED', 'MISSING'],
    STEP_DEADLINES.check
  )
  const check = parseSetupCheck(checked)
  if (check === 'failed') return { ok: false, detail: CHECK_FAILED_DETAIL }
  if (check === 'missing') {
    const installOutput = await runStep(
      host,
      'alethe-report: install',
      installCommand(),
      ['INSTALLED_OK', 'INSTALL_FAILED'],
      STEP_DEADLINES.install
    )
    if (parseInstallOutput(installOutput) !== 'ok') {
      return { ok: false, detail: INSTALL_FAILED_DETAIL }
    }
    return { ok: true, installed: true }
  }
  return { ok: true, installed: false }
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
    const ensured = await ensureAlethe(host)
    if (!ensured.ok) return { status: 'failed', installed, detail: ensured.detail }
    installed = ensured.installed
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

// --- list-issues: as issues abertas do projeto, de qualquer forge. ---
//
// Um só comando efêmero decide o CLI pelo remote do repositório: glab no GitLab,
// gh no GitHub. Os marcadores seguem a mesma disciplina do setup — quebrados com
// aspas vazias (`NO""_REPO`), nunca `"_"`, e nenhum marcador completo na fonte,
// para o eco do comando no PTY não casar com o resultado.

/** One ephemeral command: the remote picks the forge, then the list, then the marker. */
export function issuesCommand(): string {
  // `tr -d '\n'` em AMBOS os braços: em TTY o gh/glab imprime JSON PRETTY (29 issues →
  // 1000+ linhas), mas o terminal.read do Orca devolve só as 200 mais NOVAS — o `[`
  // inicial é cortado e o parse cai no meio do array. Pretty-print newlines são whitespace
  // de JSON; newlines reais dentro de strings já vêm escapadas como `\n` (2 bytes), então
  // apagá-las é seguro e o payload vira UMA linha que o corte nunca alcança.
  return (
    'url=$(git remote get-url origin 2>/dev/null); ' +
    'if [ -z "$url" ]; then echo NO""_REPO; ' +
    'elif echo "$url" | grep -qi gitlab; then glab issue list -O json | tr -d \'\\n\'; ' +
    'else gh issue list --limit 20 --json number,title,url,labels --state open | tr -d \'\\n\'; fi; ' +
    'echo ISSUES""_DONE'
  )
}

/** The panel's cap: `list-issues` answers with at most 20 open issues. */
const MAX_ISSUES = 20

/**
 * Normalizes ONE issue of either forge's shape: gh's `{number, url, labels:[{name}]}` and
 * glab's `{iid, web_url|url, labels:[string]}`. Anything without a usable number is dropped
 * (a row the panel could not label `#<n>` is not an issue to show).
 */
export function normalizeIssue(raw: unknown): IssueItem | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const rawNumber = record.number ?? record.iid
  const number = typeof rawNumber === 'number' ? rawNumber : Number(rawNumber)
  if (!Number.isFinite(number)) return undefined
  const rawLabels = Array.isArray(record.labels) ? record.labels : []
  const labels = rawLabels
    .map((label) =>
      typeof label === 'string' ? label : typeof (label as { name?: unknown })?.name === 'string'
        ? String((label as { name: string }).name)
        : ''
    )
    .filter((label) => label !== '')
  return {
    number,
    title: String(record.title ?? ''),
    url: String(record.web_url ?? record.url ?? ''),
    labels
  }
}

/**
 * Reads `issuesCommand`'s output: `NO_REPO` → no remote; otherwise the JSON array
 * between the markers. The terminal ECHOES the command (whose source carries `[` and `]`
 * from `if [ -z "$url" ]`), so "first `[` to last `]`" over the raw text would swallow the
 * echo and fail — instead every `[` position is tried as a start until `JSON.parse`
 * accepts an array. A failure is data (`error`), never a throw.
 */
export function parseIssuesOutput(output: string): IssueList {
  if (lastMarker(output, ['NO_REPO']) !== undefined) {
    return { issues: [], error: 'workspace sem remote git' }
  }
  const end = output.lastIndexOf(']')
  if (end !== -1) {
    for (let at = output.indexOf('['); at !== -1 && at < end; at = output.indexOf('[', at + 1)) {
      try {
        const parsed: unknown = JSON.parse(output.slice(at, end + 1))
        if (Array.isArray(parsed)) {
          const issues = parsed
            .map(normalizeIssue)
            .filter((issue): issue is IssueItem => issue !== undefined)
            .slice(0, MAX_ISSUES)
          return { issues }
        }
      } catch {
        /* este `[` não abre o array real; tenta o próximo */
      }
    }
  }
  return { issues: [], error: 'não consegui ler as issues (gh/glab ausente?)' }
}

/**
 * Lists the project's open issues in ONE ephemeral terminal (closed in `runStep`'s
 * `finally`), parsing the forge's JSON. Every failure — no workspace, a refused create,
 * gh/glab missing — comes back as an `IssueList` with `error`, never thrown.
 */
export async function listIssues(host: Host): Promise<IssueList> {
  try {
    const output = await runStep(
      host,
      'alethe-report: issues',
      issuesCommand(),
      ['ISSUES_DONE'],
      STEP_DEADLINES.issues
    )
    return parseIssuesOutput(output)
  } catch (err) {
    return { issues: [], error: err instanceof Error ? err.message : String(err) }
  }
}

// --- start-task: the first step without friction — the panel dispatches the agent itself. ---

/** The kickoff one task runs: the alethe skill, the NDS runbook and the task, in one line. */
function kickoffOf(task: string): string {
  return (
    'Use a skill alethe para orquestrar a tarefa seguindo o runbook NDS em ' +
    '~/.agents/skills/alethe/references/nds-runbook.md. ' +
    `TAREFA: ${task}`
  )
}

/** The kickoff one ISSUE runs: the issue (number, title, url), the runbook, the dry-run gate. */
function issueKickoffOf(issue: { number: number; title: string; url: string }): string {
  return (
    `Use a skill alethe para orquestrar a tarefa da issue #${issue.number}: "${issue.title}" — ${issue.url}. ` +
    'Leia a issue com gh (ou glab) e siga o runbook NDS em ' +
    '~/.agents/skills/alethe/references/nds-runbook.md. ' +
    'Após analisar, MOSTRE o dry-run (playbook, waves, modelos e estimativa) e ' +
    'AGUARDE minha aprovação antes de executar qualquer wave.'
  )
}

/**
 * The shared dispatcher behind `start-task` and `start-issue`: ensure the skill, read the
 * workspace and open the AGENT terminal carrying `kickoff` under `title`. Unlike every other
 * terminal in this file this one is NOT ephemeral and is never closed — it is the live session
 * the user watches while the waves run, so closing it would kill the orchestration it just
 * started (runStep's `finally` is exactly the anti-pattern this function must not inherit;
 * that is why there is no `finally` here at all). The kickoff goes through `shellQuote`, so
 * `"`, `$()` or backticks stay data and never become shell syntax. Every failure comes back
 * as a `StartResult`, never thrown.
 */
export async function dispatchAgent(
  host: Host,
  kickoff: string,
  title: string
): Promise<StartResult> {
  try {
    const ensured = await ensureAlethe(host)
    if (!ensured.ok) return { status: 'failed', detail: ensured.detail }
    const ctx = (await host.call('workspace.readContext', {})) as { workspaceId?: string } | null
    const workspaceId = ctx?.workspaceId
    if (!workspaceId) return { status: 'failed', detail: 'nenhum workspace focado' }
    await host.call('terminal.create', {
      workspaceId,
      title,
      command: `opencode run ${shellQuote(kickoff)}`
    })
    return {
      status: 'started',
      detail:
        'Agente iniciado ✓ — acompanhe o terminal; o relatório aparecerá aqui quando as waves concluírem.'
    }
  } catch (err) {
    // `err.message` rather than `String(err)`, so "nenhum workspace focado" reaches the panel
    // verbatim instead of wearing an `Error: ` prefix.
    return { status: 'failed', detail: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Dispatches the alethe agent for one task: validate the field, then the shared
 * `dispatchAgent` (ensure → workspace → agent terminal with the task's kickoff).
 */
export async function startTask(host: Host, task: string): Promise<StartResult> {
  const trimmed = task.trim()
  if (trimmed === '') {
    // Before ANY host call: an empty field must not reach a terminal at all.
    return { status: 'failed', detail: 'Escreva a tarefa antes de orquestrar.' }
  }
  return dispatchAgent(host, kickoffOf(trimmed), `alethe: ${trimmed.slice(0, 40)}`)
}

/**
 * Dispatches the alethe agent for one ISSUE (the panel's "Issues abertas" 🚀): validate the
 * row, then the same `dispatchAgent` as `start-task` — no duplicated command strings. The
 * kickoff asks for the dry-run and holds for approval, the flow the user chose: alethe
 * previews the waves and "goal alone is not approval". The agent terminal is NEVER closed.
 */
export async function startIssue(
  host: Host,
  issue: { number: number; title: string; url: string }
): Promise<StartResult> {
  if (!Number.isFinite(issue?.number) || issue.number <= 0 || String(issue.title ?? '').trim() === '') {
    // Before ANY host call: a missing row must not reach a terminal at all.
    return { status: 'failed', detail: 'Escolha uma issue primeiro.' }
  }
  const title = `alethe #${issue.number} ${issue.title.slice(0, 30)}`
  return dispatchAgent(host, issueKickoffOf(issue), title)
}
