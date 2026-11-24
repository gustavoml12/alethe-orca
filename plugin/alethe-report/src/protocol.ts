// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
import type { OpenResult, ReportList } from './reports'

export {}

declare module 'orca' {
  interface PluginRequests {
    /** Finds report.html under ~/.config/alethe/orchestrations (find order, at most 50). */
    'list-reports': { output: ReportList }
    /** Opens one report.html in a browser tab; `via` names how (Task 4 may extend it). */
    'open-report': { input: { path: string }; output: OpenResult }
    // Scaffold demo contract, still read by src/panel.tsx: drop these together with the counter
    // UI when the panel is rewritten (plan Task 3).
    /** The total the worker keeps in storage. */
    'counter.get': { output: { total: number } }
    /** Adds `by` to the stored total and answers the new total. */
    'counter.add': { input: { by: number }; output: { total: number } }
  }
  interface PluginPanelEvents {
    /** Posted to every open panel after the total changes. */
    'counter.changed': { total: number }
  }
}
