// The plugin's own worker. Orca starts it on the panel's first plugin.request and transpiles
// this file when it loads: no build step. Its handlers run the discovery/opening logic of
// src/reports.ts over ephemeral terminals, so each function closes its own terminal in a
// `finally` and answers failures as data (never as an exception the panel would choke on) —
// except `start-task`, whose agent terminal is the live session the user watches and is
// deliberately left open.
import type { OrcaWorkerApi } from 'orca/worker'
import {
  isReportPath,
  listReports,
  openReport,
  setupReport,
  startTask,
  type Host,
  type OpenResult,
  type ReportList,
  type SetupResult,
  type StartResult
} from './reports'

export default function activate(orca: OrcaWorkerApi): void {
  // The pure module takes a plain host; the worker's API is typed per method, hence the cast.
  const host: Host = {
    call: (method, params) => orca.host.call(method as never, params as never)
  }

  orca.panels.handle('list-reports', async (): Promise<ReportList> => {
    const result = await listReports(host)
    if (result.error) orca.log(`list-reports: ${result.error}`)
    return result
  })

  orca.panels.handle('open-report', async (input): Promise<OpenResult> => {
    const path = String(input?.path ?? '')
    // Defense in depth: only a report.html path ever reaches the shell command below.
    if (!isReportPath(path)) {
      return { opened: false, via: 'none', error: 'caminho não é um report.html' }
    }
    const result = await openReport(host, path)
    if (result.error) orca.log(`open-report: ${result.error}`)
    return result
  })

  // One click: install alethe when missing, find the newest folder with runs, render the
  // report. Every failure arrives as `status: 'failed'` data, logged for the panel's note.
  orca.panels.handle('setup-report', async (): Promise<SetupResult> => {
    const result = await setupReport(host)
    if (result.status === 'failed') orca.log(`setup-report: ${result.detail}`)
    return result
  })

  // The panel's "Qual tarefa?" field: ensure the skill, then open the LIVE agent terminal with
  // the alethe kickoff. That terminal is never closed — it is the session the user watches —
  // so only the ephemeral check/install terminals of `ensureAlethe` follow the `finally` rule.
  orca.panels.handle('start-task', async (input): Promise<StartResult> => {
    const task = String(input?.task ?? '')
    const result = await startTask(host, task)
    if (result.status === 'failed') orca.log(`start-task: ${result.detail}`)
    return result
  })
}
