// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
import type { OpenResult, ReportList } from './reports'

export {}

declare module 'orca' {
  interface PluginRequests {
    /** Finds report.html under ~/.config/alethe/orchestrations (newest first, at most 50). */
    'list-reports': { output: ReportList }
    /** Opens one report.html in a browser tab; `via` names how (`editor-tab` is RESERVED and unused: Task 4 decided browser-tab works). */
    'open-report': { input: { path: string }; output: OpenResult }
  }
}
