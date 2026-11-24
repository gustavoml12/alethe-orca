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

/** `open-report`' answer; `via` says how it opened (Task 4 may add an editor tab to it). */
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
 * Opens one report.html in a browser tab through `orca tab create --url file://…`.
 * No `editor.open` fallback here: the manifest has no workspace:write, so that call would be
 * `capability_denied` at runtime; when the terminal reports failure the answer carries what it
 * said and `via` stays 'none' (plan Task 4 decides on a fallback).
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
      command: `orca tab create --url "file://${path}"`
    })) as { terminalId: string }
    terminalId = created.terminalId
    await sleep(1200)
    const read = (await host.call('terminal.read', {
      terminalId,
      maxLines: 50
    })) as { lines: string[] }
    const out = read.lines.join('\n')
    if (/error|refused|invalid/i.test(out)) {
      return { opened: false, via: 'none', error: out }
    }
    return { opened: true, via: 'browser-tab' }
  } catch (err) {
    return { opened: false, via: 'none', error: String(err) }
  } finally {
    await closeQuietly(host, terminalId)
  }
}
