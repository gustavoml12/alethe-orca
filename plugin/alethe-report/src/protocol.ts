// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
import type { IssueList, OpenResult, ReportList, SetupResult, StartResult } from './reports'

export {}

declare module 'orca' {
  interface PluginRequests {
    /** Finds report.html under ~/.config/alethe/orchestrations (newest first, at most 50). */
    'list-reports': { output: ReportList }
    /** Opens one report.html in a browser tab; `via` names how (`editor-tab` is RESERVED and unused: Task 4 decided browser-tab works). */
    'open-report': { input: { path: string }; output: OpenResult }
    /** Installs alethe when missing, finds the newest folder with runs and writes report.html there. */
    'setup-report': { output: SetupResult }
    /** Dispatches the alethe agent for one task: a live agent terminal with the kickoff (never closed). */
    'start-task': { input: { task: string }; output: StartResult }
    /** Lists the project's open issues (at most 20) from gh or glab, chosen by the git remote. */
    'list-issues': { output: IssueList }
    /** Dispatches the alethe agent for one issue row: kickoff with dry-run + approval hold (terminal never closed). */
    'start-issue': { input: { number: number; title: string; url: string }; output: StartResult }
  }
}
