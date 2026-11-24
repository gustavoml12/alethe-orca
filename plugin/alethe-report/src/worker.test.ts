// Runs src/worker.ts's activate(orca) with the orca object Orca passes, over a mock host, and
// exercises the pure helpers of src/reports.ts directly.
import { assert, describe, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'
import { findCommand, isReportPath, listReports, parseFindOutput, type Host } from './reports'

/** What the mock host needs for `workspace.readContext`: the full host API shape. */
const CONTEXT = {
  workspaceId: 'w1',
  branch: 'main',
  displayName: 'w1',
  terminals: []
}

describe('parseFindOutput', () => {
  test('keeps only report.html paths, order preserved', () => {
    const text = [
      '/home/u/.config/alethe/orchestrations/2026-11-24-1/wave-2/report.html',
      '/home/u/.config/alethe/orchestrations/2026-11-24-1/not-report.txt',
      ''
    ].join('\n')
    assert.deepEqual(parseFindOutput(text), [
      '/home/u/.config/alethe/orchestrations/2026-11-24-1/wave-2/report.html'
    ])
  })

  test('returns [] on empty output', () => {
    assert.deepEqual(parseFindOutput(''), [])
  })
})

describe('isReportPath', () => {
  test('accepts report.html anywhere, rejects other names', () => {
    assert.equal(isReportPath('/a/b/report.html'), true)
    assert.equal(isReportPath('/a/b/report.htmlx'), false)
    assert.equal(isReportPath('/a/b/Report.html'), false)
  })
})

describe('findCommand', () => {
  test('find command sorts newest-first via ls -t', () => {
    assert.match(findCommand(), /ls -t/)
  })
})

describe('listReports over an injected host', () => {
  test('returns empty + error when host.call rejects', async () => {
    const host: Host = {
      call: async () => {
        throw new Error('boom')
      }
    }
    const res = await listReports(host)
    assert.deepEqual(res.reports, [])
    assert.match(res.error ?? '', /boom/)
  })

  test('closes the terminal even when read fails', async () => {
    const calls: string[] = []
    const host: Host = {
      call: async (method: string) => {
        calls.push(method)
        if (method === 'workspace.readContext') return { workspaceId: 'w1' }
        if (method === 'terminal.create') return { terminalId: 't1' }
        if (method === 'terminal.read') throw new Error('read failed')
        return {}
      }
    }
    await listReports(host)
    assert.ok(calls.includes('terminal.close'))
  })
})

describe('list-reports handler', () => {
  test('finds report.html through the host and closes its terminal', async () => {
    const tw = await mountWorker(main)
    tw.host.respond('workspace.readContext', CONTEXT)
    tw.host.respond('terminal.create', { terminalId: 't1' })
    tw.host.respond('terminal.read', { lines: ['/x/report.html', '/x/other.txt'], truncated: false })
    tw.host.respond('terminal.close', { closed: true })
    const res = await tw.request('list-reports')
    assert.deepEqual(res.reports, [{ path: '/x/report.html' }])
    assert.equal(tw.host.callsOf('terminal.close').length, 1)
    await tw.deactivate()
  })

  test('answers with the error (not an exception) when a capability is missing', async () => {
    const host = mockHost({ capabilities: ['workspace:read'] })
    const tw = await mountWorker(main, { host })
    tw.host.respond('workspace.readContext', CONTEXT)
    const res = await tw.request('list-reports')
    assert.deepEqual(res.reports, [])
    assert.ok(res.error, 'erro propagado como resposta, não como exceção')
    assert.ok(
      tw.host.refusals.some(
        (refusal) => refusal.method === 'terminal.create' && refusal.code === 'capability_denied'
      ),
      'o mock recusa como o Orca: capability ausente no manifesto'
    )
    assert.ok(tw.logs.some((line) => line.includes('list-reports')), 'erro também vai para o log')
    await tw.deactivate()
  })
})

describe('open-report handler', () => {
  test('opens a browser tab and closes its terminal', async () => {
    const tw = await mountWorker(main)
    tw.host.respond('workspace.readContext', CONTEXT)
    tw.host.respond('terminal.create', { terminalId: 't1' })
    tw.host.respond('terminal.read', { lines: ['opened file:///x/report.html'], truncated: false })
    tw.host.respond('terminal.close', { closed: true })
    const res = await tw.request('open-report', { path: '/x/report.html' })
    assert.equal(res.opened, true)
    assert.equal(res.via, 'browser-tab')
    const create = tw.host.callsOf('terminal.create')[0] as { command: string }
    assert.equal(create.command, 'orca tab create --url "file:///x/report.html"')
    assert.equal(tw.host.callsOf('terminal.close').length, 1)
    await tw.deactivate()
  })

  test('reports what the terminal said and never tries editor.open', async () => {
    const tw = await mountWorker(main)
    tw.host.respond('workspace.readContext', CONTEXT)
    tw.host.respond('terminal.create', { terminalId: 't1' })
    tw.host.respond('terminal.read', { lines: ['Error: tab create refused'], truncated: false })
    tw.host.respond('terminal.close', { closed: true })
    const res = await tw.request('open-report', { path: '/x/report.html' })
    assert.equal(res.opened, false)
    assert.equal(res.via, 'none')
    assert.match(res.error ?? '', /tab create refused/)
    assert.deepEqual(tw.host.callsOf('editor.open'), [], 'sem workspace:write não há fallback')
    assert.equal(tw.host.callsOf('terminal.close').length, 1)
    await tw.deactivate()
  })
})
