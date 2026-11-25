// `orca plugin check` renders the panel once per scenario, each with the worker on a fresh
// host. Seed `list-reports`, `list-issues` AND `list-waves` so each state the panel draws is
// rendered, not just the first one.
import { defineCheck, hostError } from 'orca/testing'

/** A saved proposal, so the "Proposta de waves" section draws in the `waves` scenario. */
const WAVES = {
  waves: [
    { id: 1, title: 'Corrigir o dual-forge', issues: [58, 57], playbook: 'bugfix', estimate: '2h' },
    { id: 2, title: 'Fechar o plano', issues: [42] }
  ]
}

export default defineCheck({
  empty: {
    requests: {
      'list-reports': () => ({ reports: [] }),
      'list-issues': () => ({ issues: [] }),
      'list-waves': () => ({ waves: [] })
    }
  },
  listed: {
    requests: {
      'list-reports': () => ({
        reports: [{ path: '/home/u/.config/alethe/orchestrations/2026-11-24-1/wave-2/report.html' }]
      }),
      'list-issues': () => ({
        issues: [
          {
            number: 42,
            title: 'Corrigir o write-back dual-forge',
            url: 'https://gitlab.com/grp/proj/-/issues/42',
            labels: ['bug']
          }
        ]
      }),
      'list-waves': () => WAVES
    }
  },
  failed: {
    requests: {
      'list-reports': () => {
        throw hostError('unavailable', 'worker off')
      },
      'list-issues': () => ({ issues: [] }),
      'list-waves': () => ({ waves: [] })
    }
  },
  // The issues fetch failing is a small non-destructive note: the reports list keeps working.
  'issues-failed': {
    requests: {
      'list-reports': () => ({
        reports: [{ path: '/home/u/.config/alethe/orchestrations/2026-11-24-1/wave-2/report.html' }]
      }),
      'list-issues': () => {
        throw hostError('unavailable', 'worker off')
      },
      'list-waves': () => ({ waves: [] })
    }
  },
  // A proposal saved + open issues: the waves section renders its rows and play buttons, in
  // order between the assessment and the issues.
  waves: {
    requests: {
      'list-reports': () => ({
        reports: [{ path: '/home/u/.config/alethe/orchestrations/2026-11-24-1/wave-2/report.html' }]
      }),
      'list-issues': () => ({
        issues: [
          {
            number: 58,
            title: 'Normalizar a saída do doctor',
            url: 'https://github.com/grp/proj/issues/58',
            labels: ['enhancement']
          }
        ]
      }),
      'list-waves': () => WAVES
    }
  },
  // The proposal file exists but cannot be parsed: a small muted note, never a broken panel.
  'waves-unreadable': {
    requests: {
      'list-reports': () => ({ reports: [] }),
      'list-issues': () => ({ issues: [] }),
      'list-waves': () => ({ waves: [], error: 'não consegui ler a proposta de waves' })
    }
  }
})
