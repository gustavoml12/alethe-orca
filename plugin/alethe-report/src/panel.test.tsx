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

const SETUP_BUTTON = /Preparar e gerar relatório/

describe('runSetup (lógica do botão)', () => {
  test('request rejeitada vira failed como dado, nunca exceção', async () => {
    const result = await panel.runSetup(async () => {
      throw new Error('worker off')
    })
    assert.equal(result.status, 'failed')
    assert.match(result.detail, /worker off/)
  })

  test('resposta do worker passa adiante como está', async () => {
    const result = await panel.runSetup(async () => ({
      status: 'no-runs' as const,
      installed: false,
      detail: 'Inicie uma tarefa com /alethe'
    }))
    assert.equal(result.status, 'no-runs')
    assert.equal(result.detail, 'Inicie uma tarefa com /alethe')
  })
})

describe('botão preparar-e-gerar', () => {
  test('empty → o botão aparece acima da instrução, sem erros nem recusas', async () => {
    const host = mockHost({ requests: { 'list-reports': () => ({ reports: [] }) } })
    const view = await mount(panel, { host })
    assert.ok(view.find({ text: SETUP_BUTTON }), 'botão visível no estado vazio')
    assert.ok(view.find({ text: INSTRUCTION }), 'instrução continua visível')
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
    await view.unmount()
  })

  test('ready → o botão fica ao lado de Recarregar', async () => {
    const host = mockHost({
      requests: { 'list-reports': () => ({ reports: [{ path: '/o1/report.html' }] }) }
    })
    const view = await mount(panel, { host })
    assert.ok(view.find({ text: SETUP_BUTTON }), 'botão visível com a lista')
    assert.ok(view.find({ text: 'Recarregar' }), 'Recarregar continua visível')
    assert.deepEqual(view.errors, [])
    await view.unmount()
  })

  test('generated → abre o path devolvido, recarrega a lista e mostra a nota de sucesso', async () => {
    const sequence: string[] = []
    let lists = 0
    const host = mockHost({
      requests: {
        'list-reports': () => {
          sequence.push('list-reports')
          lists += 1
          return lists === 1
            ? { reports: [] }
            : { reports: [{ path: '/o1/report.html' }] }
        },
        'setup-report': () => {
          sequence.push('setup-report')
          return {
            status: 'generated' as const,
            installed: true,
            detail: 'Relatório gerado ✓',
            path: '/o1/report.html'
          }
        },
        'open-report': ({ path }) => {
          sequence.push(`open-report:${path}`)
          return { opened: true, via: 'browser-tab' as const }
        }
      }
    })
    const view = await mount(panel, { host })
    await view.press({ text: SETUP_BUTTON })
    assert.deepEqual(
      sequence,
      ['list-reports', 'setup-report', 'open-report:/o1/report.html', 'list-reports'],
      'um clique: setup → abre → recarrega'
    )
    assert.ok(view.find({ text: /Relatório gerado e aberto ✓/ }), 'nota de sucesso visível')
    assert.deepEqual(view.errors, [], 'nunca exceção no frame')
    await view.unmount()
  })

  test('generated mas o open falha → nota com o erro do open, lista recarregada', async () => {
    let lists = 0
    const host = mockHost({
      requests: {
        'list-reports': () => {
          lists += 1
          return lists === 1 ? { reports: [] } : { reports: [{ path: '/o1/report.html' }] }
        },
        'setup-report': () => ({
          status: 'generated' as const,
          installed: false,
          detail: 'Relatório gerado ✓',
          path: '/o1/report.html'
        }),
        'open-report': () => ({ opened: false, via: 'none' as const, error: 'sem workspace focado' })
      }
    })
    const view = await mount(panel, { host })
    await view.press({ text: SETUP_BUTTON })
    assert.ok(view.find({ text: /Relatório gerado/ }), 'gerado continua dito')
    assert.ok(view.find({ text: /sem workspace focado/ }), 'erro do open anexado à nota')
    assert.equal(lists, 2, 'lista recarregada mesmo com o open falhando')
    assert.deepEqual(view.errors, [])
    await view.unmount()
  })

  test('no-runs → nota informativa com o passo a passo do /alethe', async () => {
    const host = mockHost({
      requests: {
        'list-reports': () => ({ reports: [] }),
        'setup-report': () => ({
          status: 'no-runs' as const,
          installed: true,
          detail:
            'Alethe instalado ✓ — nenhuma tarefa orquestrada ainda. Inicie uma tarefa com /alethe no terminal do projeto e o relatório aparecerá aqui.'
        })
      }
    })
    const view = await mount(panel, { host })
    await view.press({ text: SETUP_BUTTON })
    assert.ok(view.find({ text: /Inicie uma tarefa com \/alethe/ }), 'instrução do /alethe visível')
    assert.ok(view.find({ text: /Nenhum relatório/ }), 'estado vazio segue desenhado')
    assert.deepEqual(view.errors, [])
    await view.unmount()
  })

  test('failed → nota destrutiva com o detalhe, sem exceção', async () => {
    const host = mockHost({
      requests: {
        'list-reports': () => ({ reports: [] }),
        'setup-report': () => ({
          status: 'failed' as const,
          installed: false,
          detail: 'Falha ao instalar o alethe (git clone). Confira sua autenticação GitHub (gh auth login) e tente de novo.'
        })
      }
    })
    const view = await mount(panel, { host })
    await view.press({ text: SETUP_BUTTON })
    assert.ok(view.find({ text: /gh auth login/ }), 'detalhe da falha visível')
    assert.deepEqual(view.errors, [], 'nunca exceção no frame')
    await view.unmount()
  })
})

// --- Campo "Qual tarefa?" + botão de orquestrar: o primeiro passo sem atrito. ---

const START_BUTTON = /Orquestrar tarefa/
const TASK_LABEL = 'Qual tarefa?'

describe('runStart (lógica do botão de orquestrar)', () => {
  test('request rejeitada vira failed como dado, nunca exceção', async () => {
    const result = await panel.runStart(async () => {
      throw new Error('worker off')
    })
    assert.equal(result.status, 'failed')
    assert.match(result.detail, /worker off/)
  })

  test('resposta do worker passa adiante como está', async () => {
    const result = await panel.runStart(async () => ({
      status: 'started' as const,
      detail: 'Agente iniciado ✓'
    }))
    assert.equal(result.status, 'started')
    assert.equal(result.detail, 'Agente iniciado ✓')
  })
})

describe('campo de tarefa no estado vazio', () => {
  test('input "Qual tarefa?" + botão visíveis; desabilitado enquanto o campo estiver vazio', async () => {
    const starts: string[] = []
    const host = mockHost({
      requests: {
        'list-reports': () => ({ reports: [] }),
        'start-task': ({ task }) => {
          starts.push(task)
          return { status: 'started' as const, detail: 'Agente iniciado ✓' }
        }
      }
    })
    const view = await mount(panel, { host })
    assert.ok(view.find({ label: TASK_LABEL }), 'campo visível no estado vazio')
    const button = view.find({ text: START_BUTTON })
    assert.ok(button, 'botão de orquestrar visível')
    assert.equal(button.disabled, true, 'sem texto não dispara')
    try {
      await view.press({ text: START_BUTTON })
    } catch {
      /* Orca recusa a pressão em botão desabilitado — os dois casos têm que manter o worker intacto */
    }
    assert.deepEqual(starts, [], 'botão desabilitado nunca chama o worker')
    await view.type({ label: TASK_LABEL }, 'escrever o plano de testes')
    const enabled = view.find({ text: START_BUTTON })
    assert.ok(enabled, 'botão continua visível')
    assert.equal(enabled.disabled, false, 'com texto habilita')
    assert.deepEqual(view.errors, [])
    await view.unmount()
  })

  test('started → nota de sucesso, campo limpo e nenhum erro no frame', async () => {
    const sent: string[] = []
    const host = mockHost({
      requests: {
        'list-reports': () => ({ reports: [] }),
        'start-task': ({ task }) => {
          sent.push(task)
          return {
            status: 'started' as const,
            detail:
              'Agente iniciado ✓ — acompanhe o terminal; o relatório aparecerá aqui quando as waves concluírem.'
          }
        }
      }
    })
    const view = await mount(panel, { host })
    await view.type({ label: TASK_LABEL }, 'refatorar o setup')
    await view.press({ text: START_BUTTON })
    assert.deepEqual(sent, ['refatorar o setup'], 'a tarefa digitada chega ao worker')
    assert.ok(view.find({ text: /Agente iniciado ✓/ }), 'nota de sucesso visível')
    assert.equal(view.valueOf({ label: TASK_LABEL }), '', 'campo limpo após iniciar')
    assert.deepEqual(view.errors, [], 'nunca exceção no frame')
    await view.unmount()
  })

  test('failed → nota destrutiva com o detalhe e o campo preservado', async () => {
    const host = mockHost({
      requests: {
        'list-reports': () => ({ reports: [] }),
        'start-task': () => ({ status: 'failed' as const, detail: 'nenhum workspace focado' })
      }
    })
    const view = await mount(panel, { host })
    await view.type({ label: TASK_LABEL }, 'refatorar o setup')
    await view.press({ text: START_BUTTON })
    const note = view.find({ text: /nenhum workspace focado/ })
    assert.ok(note, 'nota de falha visível')
    assert.equal(note.props.tone, 'danger', 'tom destrutivo')
    assert.equal(view.valueOf({ label: TASK_LABEL }), 'refatorar o setup', 'campo preservado na falha')
    assert.deepEqual(view.errors, [], 'nunca exceção no frame')
    await view.unmount()
  })

  test('request rejeitada → nota destrutiva, sem exceção no frame', async () => {
    const host = mockHost({
      requests: {
        'list-reports': () => ({ reports: [] }),
        'start-task': () => {
          throw hostError('unavailable', 'worker off')
        }
      }
    })
    const view = await mount(panel, { host })
    await view.type({ label: TASK_LABEL }, 'qualquer coisa')
    await view.press({ text: START_BUTTON })
    assert.ok(view.find({ text: /worker off/ }), 'falha da request vira nota, não exceção')
    assert.deepEqual(view.errors, [], 'nunca exceção no frame')
    await view.unmount()
  })

  test('a nota do clique anterior some no clique seguinte (mesma disciplina do setup)', async () => {
    let press = 0
    const host = mockHost({
      requests: {
        'list-reports': () => ({ reports: [] }),
        'start-task': () => {
          press += 1
          return press === 1
            ? { status: 'failed' as const, detail: 'worker off' }
            : { status: 'started' as const, detail: 'Agente iniciado ✓' }
        }
      }
    })
    const view = await mount(panel, { host })
    await view.type({ label: TASK_LABEL }, 'uma tarefa')
    await view.press({ text: START_BUTTON })
    assert.ok(view.find({ text: /worker off/ }), 'primeira resposta: falha')
    await view.press({ text: START_BUTTON })
    assert.equal(view.find({ text: /worker off/ }), null, 'nota antiga resetada no novo clique')
    assert.ok(view.find({ text: /Agente iniciado ✓/ }), 'nota nova no lugar')
    assert.deepEqual(view.errors, [])
    await view.unmount()
  })
})
