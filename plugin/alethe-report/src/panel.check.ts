// `orca plugin check` renders the panel once per scenario, each with the worker on a fresh
// host. Seed `list-reports` so each state the panel draws is rendered, not just the first one.
import { defineCheck, hostError } from 'orca/testing'

export default defineCheck({
  empty: { requests: { 'list-reports': () => ({ reports: [] }) } },
  listed: {
    requests: {
      'list-reports': () => ({
        reports: [{ path: '/home/u/.config/alethe/orchestrations/2026-11-24-1/wave-2/report.html' }]
      })
    }
  },
  failed: {
    requests: {
      'list-reports': () => {
        throw hostError('unavailable', 'worker off')
      }
    }
  }
})
