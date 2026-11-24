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

/** Where Alethe's orchestrations (and each wave's report.html) live. */
const ORCHESTRATIONS = '~/.config/alethe/orchestrations'

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
