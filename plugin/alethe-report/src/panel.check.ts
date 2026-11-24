// `orca plugin check` renders the panel once per scenario, each with the worker on a fresh
// host. Seed `list-reports` AND `list-issues` so each state the panel draws is rendered, not
// just the first one.
import { defineCheck, hostError } from 'orca/testing'

export default defineCheck({
  empty: {
    requests: {
      'list-reports': () => ({ reports: [] }),
      'list-issues': () => ({ issues: [] })
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
      })
    }
  },
  failed: {
    requests: {
      'list-reports': () => {
        throw hostError('unavailable', 'worker off')
      },
      'list-issues': () => ({ issues: [] })
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
      }
    }
  }
})
