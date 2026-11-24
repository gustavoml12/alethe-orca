// `orca plugin test` runs this in Node with the same runtime and checks Orca uses. The panel's
// logic is `load(req)`: one injectable list request mapped to the state the component draws; the
// render cases inject the worker's answers (and its failures) through `mockHost`'s `requests`.
import { assert, describe, hostError, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'

const INSTRUCTION = /Rode `\/alethe report html` no terminal do projeto/

describe('load (lógica do painel)', () => {
  test('empty list → estado vazio com a instrução da spec', async () => {
    const state = await panel.load(async () => ({ reports: [] }))
    assert.equal(state.kind, 'empty')
    assert.match(state.instruction ?? '', INSTRUCTION)
  })

  test('worker request failure → estado de erro amigável, nunca exceção (Focus 4)', async () => {
    const state = await panel.load(async () => {
      throw new Error('worker off')
    })
    assert.equal(state.kind, 'error')
    assert.match(state.message ?? '', /worker off/)
  })

  test('worker responde o erro como dado → mesmo estado de erro', async () => {
    const state = await panel.load(async () => ({
      reports: [],
      error: 'nenhum workspace focado'
    }))
    assert.equal(state.kind, 'error')
    assert.match(state.message ?? '', /nenhum workspace focado/)
  })

  test('list with items → ready com os paths na ordem do worker', async () => {
    const state = await panel.load(async () => ({
      reports: [{ path: '/x/report.html' }, { path: '/y/report.html' }]
    }))
    assert.equal(state.kind, 'ready')
    assert.deepEqual(state.reports, [{ path: '/x/report.html' }, { path: '/y/report.html' }])
  })
})

describe('panel render', () => {
  test('empty → instrução da spec e Recarregar visíveis, sem erros nem recusas', async () => {
    const host = mockHost({ requests: { 'list-reports': () => ({ reports: [] }) } })
    const view = await mount(panel, { host })
    assert.ok(view.find({ text: INSTRUCTION }), 'instrução visível')
    assert.ok(view.find({ text: 'Recarregar' }), 'Recarregar sempre visível')
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
    await view.unmount()
  })

  // The transient loading state ("Carregando relatórios…") is not mount-observable: `mount`
  // settles the panel, and settling waits for the in-flight `list-reports` request, so a
  // pending request would deadlock the mount (verified). It stays covered by the implementation:
  // the atom starts at `loading` and `reload` returns to it before every refresh.

  test('ready → uma linha por relatório na ordem do worker', async () => {
    const host = mockHost({
      requests: {
        'list-reports': () => ({
          reports: [{ path: '/o1/wave-2/report.html' }, { path: '/o2/wave-3/report.html' }]
        })
      }
    })
    const view = await mount(panel, { host })
    const names = view.findAll({ text: 'wave-2/report.html' }).concat(view.findAll({ text: 'wave-3/report.html' }))
    assert.equal(names.length, 2, 'uma linha por relatório')
    const order = view.findAll({ text: /report\.html$/ }).map((row) => row.text)
    assert.deepEqual(order, ['wave-2/report.html', 'wave-3/report.html'], 'ordem do worker preservada')
    assert.ok(view.find({ text: '/o1' }), 'pasta acima do arquivo visível')
    assert.deepEqual(view.errors, [])
    await view.unmount()
  })

  test('ready → Abrir abre na aba com feedback inline', async () => {
    const opened: string[] = []
    const host = mockHost({
      requests: {
        'list-reports': () => ({ reports: [{ path: '/o1/wave-2/report.html' }] }),
        'open-report': ({ path }) => {
          opened.push(path)
          return { opened: true, via: 'browser-tab' }
        }
      }
    })
    const view = await mount(panel, { host })
    await view.press({ text: 'Abrir' })
    assert.deepEqual(opened, ['/o1/wave-2/report.html'], 'open-report recebe o path da linha')
    assert.ok(view.find({ text: /aberto na aba/i }), 'feedback inline de sucesso')
    assert.deepEqual(view.errors, [])
    await view.unmount()
  })

  test('ready → falha do open-report respondida vira feedback inline, sem exceção', async () => {
    const host = mockHost({
      requests: {
        'list-reports': () => ({ reports: [{ path: '/x/report.html' }] }),
        'open-report': () => ({ opened: false, via: 'none', error: 'sem workspace focado' })
      }
    })
    const view = await mount(panel, { host })
    await view.press({ text: 'Abrir' })
    assert.ok(view.find({ text: 'sem workspace focado' }), 'erro do worker visível na linha')
    assert.deepEqual(view.errors, [], 'frame nunca vê exceção')
    await view.unmount()
  })

  test('falha da request → linha de erro + mesma UI do empty, sem exceção no frame', async () => {
    const host = mockHost({
      requests: {
        'list-reports': () => {
          throw hostError('unavailable', 'worker off')
        }
      }
    })
    const view = await mount(panel, { host })
    assert.ok(view.find({ text: /worker off/ }), 'linha de erro visível')
    assert.ok(view.find({ text: INSTRUCTION }), 'mesma UI do empty')
    assert.ok(view.find({ text: 'Recarregar' }), 'Recarregar segue visível')
    assert.deepEqual(view.errors, [], 'nunca exceção no frame')
    await view.unmount()
  })

  test('Recarregar pede a lista de novo e desenha a nova resposta', async () => {
    let calls = 0
    const host = mockHost({
      requests: {
        'list-reports': () => {
          calls += 1
          return calls === 1 ? { reports: [] } : { reports: [{ path: '/x/report.html' }] }
        }
      }
    })
    const view = await mount(panel, { host })
    assert.ok(view.find({ text: INSTRUCTION }), 'começa vazio')
    await view.press({ text: 'Recarregar' })
    assert.equal(calls, 2, 'segunda chamada ao worker')
    assert.ok(view.find({ text: 'x/report.html' }), 'segunda resposta desenhada')
    assert.deepEqual(view.errors, [])
    await view.unmount()
  })
})
