// `orca plugin test` runs this in Node with the same runtime and checks Orca uses. The panel's
// logic is `load(req)`: one injectable list request mapped to the state the component draws; the
// render cases inject the worker's answers (and its failures) through `mockHost`'s `requests`.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { assert, describe, hostError, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'

const INSTRUCTION = /Sem relatórios ainda — escreva a tarefa acima e clique em Orquestrar tarefa/

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
      detail: 'Nenhuma tarefa orquestrada ainda — escreva uma tarefa no campo'
    }))
    assert.equal(result.status, 'no-runs')
    assert.equal(result.detail, 'Nenhuma tarefa orquestrada ainda — escreva uma tarefa no campo')
  })
})

describe('botão preparar-e-gerar', () => {
  test('empty → o botão preparar-e-gerar continua visível junto da instrução', async () => {
    const host = mockHost({ requests: { 'list-reports': () => ({ reports: [] }) } })
    const view = await mount(panel, { host })
    assert.ok(view.find({ text: SETUP_BUTTON }), 'botão visível no estado vazio')
    assert.ok(view.find({ text: INSTRUCTION }), 'instrução continua visível')
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
    await view.unmount()
  })

  test('ready → o botão preparar-e-gerar segue visível com a lista', async () => {
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
            detail: 'Relatório gerado',
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
    assert.ok(view.find({ text: /Relatório gerado e aberto/ }), 'nota de sucesso visível')
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
          detail: 'Relatório gerado',
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

  test('no-runs → nota informativa com o passo a passo do novo fluxo', async () => {
    const host = mockHost({
      requests: {
        'list-reports': () => ({ reports: [] }),
        'setup-report': () => ({
          status: 'no-runs' as const,
          installed: true,
          detail:
            'Alethe instalado — Nenhuma tarefa orquestrada ainda — escreva uma tarefa no campo e clique em Orquestrar tarefa. (O comando /alethe roda dentro da conversa de um agente, não no shell.)'
        })
      }
    })
    const view = await mount(panel, { host })
    await view.press({ text: SETUP_BUTTON })
    assert.ok(
      view.find({ text: /escreva uma tarefa no campo/ }),
      'instrução do novo fluxo visível'
    )
    assert.ok(view.find({ text: /conversa de um agente, não no shell/ }), 'não sugere shell')
    assert.equal(view.find({ text: /no terminal do projeto/ }), null, 'cópia antiga some')
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

/**
 * O botão de orquestrar, como QUERY e não só como texto: a instrução do estado vazio agora
 * também cita o botão, e `find` devolve o match mais interno — sem o `role` o teste poderia
 * "achar" a frase da instrução no lugar do botão.
 */
const START_BUTTON = { role: 'button', text: /Orquestrar tarefa/ }
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
      detail: 'Agente iniciado'
    }))
    assert.equal(result.status, 'started')
    assert.equal(result.detail, 'Agente iniciado')
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
          return { status: 'started' as const, detail: 'Agente iniciado' }
        }
      }
    })
    const view = await mount(panel, { host })
    assert.ok(view.find({ label: TASK_LABEL }), 'campo visível no estado vazio')
    const button = view.find(START_BUTTON)
    assert.ok(button, 'botão de orquestrar visível')
    assert.equal(button.disabled, true, 'sem texto não dispara')
    try {
      await view.press(START_BUTTON)
    } catch {
      /* Orca recusa a pressão em botão desabilitado — os dois casos têm que manter o worker intacto */
    }
    assert.deepEqual(starts, [], 'botão desabilitado nunca chama o worker')
    await view.type({ label: TASK_LABEL }, 'escrever o plano de testes')
    const enabled = view.find(START_BUTTON)
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
              'Agente iniciado — acompanhe o terminal; o relatório aparecerá aqui quando as waves concluírem.'
          }
        }
      }
    })
    const view = await mount(panel, { host })
    await view.type({ label: TASK_LABEL }, 'refatorar o setup')
    await view.press(START_BUTTON)
    assert.deepEqual(sent, ['refatorar o setup'], 'a tarefa digitada chega ao worker')
    assert.ok(view.find({ text: /Agente iniciado/ }), 'nota de sucesso visível')
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
    await view.press(START_BUTTON)
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
    await view.press(START_BUTTON)
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
            : { status: 'started' as const, detail: 'Agente iniciado' }
        }
      }
    })
    const view = await mount(panel, { host })
    await view.type({ label: TASK_LABEL }, 'uma tarefa')
    await view.press(START_BUTTON)
    assert.ok(view.find({ text: /worker off/ }), 'primeira resposta: falha')
    await view.press(START_BUTTON)
    assert.equal(view.find({ text: /worker off/ }), null, 'nota antiga resetada no novo clique')
    assert.ok(view.find({ text: /Agente iniciado/ }), 'nota nova no lugar')
    assert.deepEqual(view.errors, [])
    await view.unmount()
  })
})

// --- Seção "Issues abertas": as issues do projeto disparam a orquestração com dry-run. ---

const ISSUES_HEADING = 'Issues abertas'
/** O botão de despacho de UMA linha de issue (o da tarefa é "Orquestrar tarefa", texto diferente). */
const ISSUE_BUTTON = { label: 'Orquestrar issue #42' }
/** Qualquer linha de issue: o rótulo carrega o número de cada uma. */
const ANY_ISSUE_BUTTON = { label: /^Orquestrar issue #/ }

/** Uma issue qualquer para os testes da seção. */
const ISSUE = {
  number: 42,
  title: 'Corrigir o write-back dual-forge',
  url: 'https://gitlab.com/grp/proj/-/issues/42',
  labels: [] as string[]
}

describe('loadIssues (lógica da seção de issues)', () => {
  test('resposta do worker passa adiante como está', async () => {
    const state = await panel.loadIssues(async () => ({ issues: [ISSUE] }))
    assert.deepEqual(state.issues, [ISSUE])
    assert.equal(state.error, undefined)
  })

  test('resposta com error do worker → error como dado, nunca exceção', async () => {
    const state = await panel.loadIssues(async () => ({ issues: [], error: 'workspace sem remote git' }))
    assert.deepEqual(state.issues, [])
    assert.match(state.error ?? '', /workspace sem remote git/)
  })

  test('request rejeitada → error como dado, nunca exceção (Focus 4)', async () => {
    const state = await panel.loadIssues(async () => {
      throw new Error('worker off')
    })
    assert.deepEqual(state.issues, [])
    assert.match(state.error ?? '', /worker off/)
  })
})

describe('seção Issues abertas no painel', () => {
  test('issues renderizadas como #n título [labels] com o botão de orquestrar por linha', async () => {
    const host = mockHost({
      requests: {
        'list-reports': () => ({ reports: [{ path: '/o1/report.html' }] }),
        'list-issues': () => ({ issues: [ISSUE, { ...ISSUE, number: 7, title: 'Outra', labels: ['bug'] }] })
      }
    })
    const view = await mount(panel, { host })
    assert.ok(view.find({ text: ISSUES_HEADING }), 'título da seção visível')
    assert.ok(view.find({ text: '#42 Corrigir o write-back dual-forge' }), 'linha da issue')
    assert.ok(view.find({ text: '#7 Outra [bug]' }), 'linha com labels')
    assert.equal(view.findAll(ANY_ISSUE_BUTTON).length, 2, 'um botão por issue')
    assert.deepEqual(view.errors, [])
    await view.unmount()
  })

  test('zero issues → a seção some, sem erros nem notas', async () => {
    const host = mockHost({
      requests: {
        'list-reports': () => ({ reports: [] }),
        'list-issues': () => ({ issues: [] })
      }
    })
    const view = await mount(panel, { host })
    assert.equal(view.find({ text: ISSUES_HEADING }), null, 'sem issues não há seção')
    assert.equal(view.find(ISSUE_BUTTON), null)
    assert.deepEqual(view.errors, [])
    await view.unmount()
  })

  test('botão da issue → start-issue com number/title/url + nota de sucesso', async () => {
    const sent: Array<{ number: number; title: string; url: string }> = []
    const host = mockHost({
      requests: {
        'list-reports': () => ({ reports: [{ path: '/o1/report.html' }] }),
        'list-issues': () => ({ issues: [ISSUE] }),
        'start-issue': (input) => {
          sent.push(input)
          return {
            status: 'started' as const,
            detail: 'Agente iniciado — acompanhe o terminal; o relatório aparecerá aqui quando as waves concluírem.'
          }
        }
      }
    })
    const view = await mount(panel, { host })
    await view.press(ISSUE_BUTTON)
    assert.deepEqual(sent, [{ number: 42, title: ISSUE.title, url: ISSUE.url }], 'start-issue recebe a issue da linha')
    assert.ok(view.find({ text: /Agente iniciado/ }), 'nota de sucesso visível')
    assert.deepEqual(view.errors, [], 'nunca exceção no frame')
    await view.unmount()
  })

  test('falha do start-issue → nota danger na linha, campo de tarefa intacto', async () => {
    const host = mockHost({
      requests: {
        'list-reports': () => ({ reports: [] }),
        'list-issues': () => ({ issues: [ISSUE] }),
        'start-issue': () => ({ status: 'failed' as const, detail: 'Escolha uma issue primeiro.' })
      }
    })
    const view = await mount(panel, { host })
    await view.press(ISSUE_BUTTON)
    const note = view.find({ text: /Escolha uma issue primeiro/ })
    assert.ok(note, 'nota de falha visível')
    assert.equal(note.props.tone, 'danger', 'tom destrutivo')
    assert.ok(view.find({ label: TASK_LABEL }), 'o campo de tarefa segue ali (fallback)')
    assert.deepEqual(view.errors, [], 'nunca exceção no frame')
    await view.unmount()
  })

  test('request do start-issue rejeitada → nota danger, sem exceção no frame', async () => {
    const host = mockHost({
      requests: {
        'list-reports': () => ({ reports: [{ path: '/o1/report.html' }] }),
        'list-issues': () => ({ issues: [ISSUE] }),
        'start-issue': () => {
          throw hostError('unavailable', 'worker off')
        }
      }
    })
    const view = await mount(panel, { host })
    await view.press(ISSUE_BUTTON)
    assert.ok(view.find({ text: /worker off/ }), 'falha da request vira nota, não exceção')
    assert.deepEqual(view.errors, [], 'nunca exceção no frame')
    await view.unmount()
  })

  test('list-issues falha → nota pequena na área da seção, painel segue desenhando', async () => {
    const host = mockHost({
      requests: {
        'list-reports': () => ({ reports: [{ path: '/o1/report.html' }] }),
        'list-issues': () => {
          throw hostError('unavailable', 'worker off')
        }
      }
    })
    const view = await mount(panel, { host })
    assert.ok(view.find({ text: /worker off/ }), 'nota da falha de issues visível')
    assert.equal(view.find({ text: ISSUES_HEADING }), null, 'sem issues não há seção')
    assert.ok(view.find({ text: 'o1/report.html' }), 'a lista de relatórios segue intacta')
    assert.equal(view.find({ text: INSTRUCTION }), null, 'não é estado vazio: há relatório')
    assert.deepEqual(view.errors, [], 'nunca exceção no frame')
    await view.unmount()
  })

  test('mount e Recarregar pedem as DUAS listas', async () => {
    let reportLists = 0
    let issueLists = 0
    const host = mockHost({
      requests: {
        'list-reports': () => {
          reportLists += 1
          return { reports: [] }
        },
        'list-issues': () => {
          issueLists += 1
          return { issues: [] }
        }
      }
    })
    const view = await mount(panel, { host })
    assert.equal(reportLists, 1, 'list-reports no mount')
    assert.equal(issueLists, 1, 'list-issues no mount')
    await view.press({ text: 'Recarregar' })
    assert.equal(reportLists, 2, 'list-reports no reload')
    assert.equal(issueLists, 2, 'list-issues no reload')
    assert.deepEqual(view.errors, [])
    await view.unmount()
  })
})

// --- Avaliação interna (assess), proposta de waves e execução, pelo painel. ---

const ASSESS_BUTTON = { role: 'button', text: 'Avaliar projeto' }
const PROPOSE_BUTTON = { role: 'button', text: 'Propor waves' }
const ASSESS_HEADING = 'Avaliação'
const WAVES_HEADING = 'Proposta de waves'

/** Uma avaliação pronta (ok) com os três estados de Callout. */
const ASSESS_OK = {
  ok: true,
  items: [
    { label: 'alethe', state: 'ok' as const, detail: 'skill + runner prontos' },
    { label: 'CLIs', state: 'warn' as const, detail: 'nenhum' },
    { label: 'github', state: 'fail' as const, detail: 'gh sem autenticação' }
  ]
}

/** Uma avaliação que NÃO está pronta: sem o botão de proposta. */
const ASSESS_NOT_READY = {
  ok: false,
  items: [{ label: 'doctor', state: 'fail' as const, detail: 'doctor não respondeu' }]
}

/** As waves de uma proposta salva, para a seção. */
const WAVES = {
  waves: [
    { id: 1, title: 'Corrigir o dual-forge', issues: [58, 57], playbook: 'bugfix', estimate: '2h' },
    { id: 2, title: 'Fechar o plano', issues: [42] }
  ]
}

/** Walks the drawn tree looking for the Callout carrying `title` (props, never a throw). */
function calloutOf(node: unknown, title: string): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = calloutOf(child, title)
      if (hit) return hit
    }
    return null
  }
  if (node === null || typeof node !== 'object') return null
  const record = node as { props?: Record<string, unknown>; children?: unknown }
  const props = record.props
  if (
    props &&
    props.title === title &&
    (props.tone === 'success' || props.tone === 'warning' || props.tone === 'danger')
  ) {
    return props
  }
  if (Array.isArray(record.children)) return calloutOf(record.children, title)
  return null
}

/** Every string the tree draws, in render order — for the section-order assertion. */
function textsOf(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') {
    out.push(node)
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) textsOf(child, out)
    return out
  }
  if (node === null || typeof node !== 'object') return out
  const record = node as Record<string, unknown>
  const props = (record.props ?? record) as Record<string, unknown>
  for (const key of ['text', 'title', 'label', 'description']) {
    if (typeof props[key] === 'string') out.push(props[key] as string)
  }
  if (Array.isArray(record.children)) textsOf(record.children, out)
  return out
}

describe('costuras puras da avaliação e das waves', () => {
  test('runAssess: request rejeitada vira um item fail, nunca exceção', async () => {
    const result = await panel.runAssess(async () => {
      throw new Error('worker off')
    })
    assert.equal(result.ok, false)
    assert.equal(result.items.length, 1)
    assert.equal(result.items[0]?.state, 'fail')
    assert.match(result.items[0]?.detail ?? '', /worker off/)
  })

  test('runAssess: resposta do worker passa adiante como está', async () => {
    const result = await panel.runAssess(async () => ASSESS_OK)
    assert.equal(result.ok, true)
    assert.equal(result.items.length, 3)
  })

  test('runPropose e runExecuteWave: request rejeitada vira failed como dado', async () => {
    const propose = await panel.runPropose(async () => {
      throw new Error('worker off')
    })
    assert.equal(propose.status, 'failed')
    assert.match(propose.detail, /worker off/)
    const execute = await panel.runExecuteWave(async () => {
      throw new Error('worker off')
    })
    assert.equal(execute.status, 'failed')
    assert.match(execute.detail, /worker off/)
  })

  test('loadWaves: resposta com error → error como dado; rejeição → erro como dado', async () => {
    const withError = await panel.loadWaves(async () => ({
      waves: [],
      error: 'não consegui ler a proposta de waves'
    }))
    assert.deepEqual(withError.waves, [])
    assert.match(withError.error ?? '', /não consegui ler/)
    const rejected = await panel.loadWaves(async () => {
      throw new Error('worker off')
    })
    assert.deepEqual(rejected.waves, [])
    assert.match(rejected.error ?? '', /worker off/)
  })
})

describe('seção Avaliação no painel', () => {
  test('botão "Avaliar projeto" com icon search; assess desenha um Callout por item', async () => {
    const host = mockHost({
      requests: {
        'list-reports': () => ({ reports: [] }),
        assess: () => ASSESS_OK
      }
    })
    const view = await mount(panel, { host })
    assert.ok(view.find({ text: ASSESS_HEADING }), 'título da seção visível')
    const button = view.find(ASSESS_BUTTON)
    assert.ok(button, 'botão de avaliação visível')
    assert.equal(button.props.icon, 'search', 'ícone de busca')
    await view.press(ASSESS_BUTTON)
    assert.ok(view.find({ text: 'skill + runner prontos' }), 'item ok desenhado')
    assert.ok(view.find({ text: 'nenhum' }), 'item warn desenhado')
    assert.ok(view.find({ text: 'gh sem autenticação' }), 'item fail desenhado')
    const okCallout = calloutOf(view.tree(), 'alethe')
    assert.equal(okCallout?.tone, 'success')
    assert.equal(okCallout?.icon, 'check')
    const warnCallout = calloutOf(view.tree(), 'CLIs')
    assert.equal(warnCallout?.tone, 'warning')
    assert.equal(warnCallout?.icon, 'warning')
    const failCallout = calloutOf(view.tree(), 'github')
    assert.equal(failCallout?.tone, 'danger')
    assert.equal(failCallout?.icon, 'error')
    assert.deepEqual(view.errors, [], 'nunca exceção no frame')
    await view.unmount()
  })

  test('ambiente não pronto → sem botão "Propor waves"', async () => {
    const host = mockHost({
      requests: {
        'list-reports': () => ({ reports: [] }),
        assess: () => ASSESS_NOT_READY
      }
    })
    const view = await mount(panel, { host })
    await view.press(ASSESS_BUTTON)
    assert.ok(view.find({ text: 'doctor não respondeu' }), 'o item de falha desenhado')
    assert.equal(view.find(PROPOSE_BUTTON), null, 'sem proposta sem ambiente pronto')
    assert.deepEqual(view.errors, [])
    await view.unmount()
  })

  test('ambiente pronto → "Propor waves" (icon zap) dispara e mostra a nota da spec', async () => {
    const proposes: number[] = []
    const host = mockHost({
      requests: {
        'list-reports': () => ({ reports: [] }),
        assess: () => ASSESS_OK,
        'propose-waves': () => {
          proposes.push(1)
          return { status: 'started' as const, detail: 'Agente iniciado' }
        }
      }
    })
    const view = await mount(panel, { host })
    await view.press(ASSESS_BUTTON)
    const propose = view.find(PROPOSE_BUTTON)
    assert.ok(propose, 'botão de proposta visível após o assess ok')
    assert.equal(propose.props.icon, 'zap')
    await view.press(PROPOSE_BUTTON)
    assert.deepEqual(proposes, [1], 'propose-waves chamado uma vez')
    assert.ok(
      view.find({
        text: 'Proposta sendo gerada pelo leader alethe — clique em Recarregar em alguns minutos.'
      }),
      'nota da spec visível'
    )
    assert.deepEqual(view.errors, [], 'nunca exceção no frame')
    await view.unmount()
  })

  test('propose-waves falhou → nota danger com o detalhe', async () => {
    const host = mockHost({
      requests: {
        'list-reports': () => ({ reports: [] }),
        assess: () => ASSESS_OK,
        'propose-waves': () => ({ status: 'failed' as const, detail: 'nenhum workspace focado' })
      }
    })
    const view = await mount(panel, { host })
    await view.press(ASSESS_BUTTON)
    await view.press(PROPOSE_BUTTON)
    const note = view.find({ text: 'nenhum workspace focado' })
    assert.ok(note, 'nota de falha visível')
    assert.equal(note.props.tone, 'danger', 'tom destrutivo')
    assert.deepEqual(view.errors, [])
    await view.unmount()
  })

  test('assess rejeitado → o item de falha desenhado, sem exceção no frame', async () => {
    const host = mockHost({
      requests: {
        'list-reports': () => ({ reports: [] }),
        assess: () => {
          throw hostError('unavailable', 'worker off')
        }
      }
    })
    const view = await mount(panel, { host })
    await view.press(ASSESS_BUTTON)
    assert.ok(view.find({ text: /worker off/ }), 'falha da request vira item, não exceção')
    assert.deepEqual(view.errors, [], 'nunca exceção no frame')
    await view.unmount()
  })
})

describe('seção Proposta de waves no painel', () => {
  test('waves → ListItem com Wave · título · issues e o botão play por wave', async () => {
    const host = mockHost({
      requests: {
        'list-reports': () => ({ reports: [] }),
        'list-waves': () => WAVES
      }
    })
    const view = await mount(panel, { host })
    assert.ok(view.find({ text: WAVES_HEADING }), 'título da seção visível')
    // ListItem desenha title/description como PROPS do nó (não como filhos de texto), então a
    // linha é lida da árvore desenhada — exatamente o que a seção carrega.
    const texts = textsOf(view.tree())
    assert.ok(
      texts.includes('Wave 1 · Corrigir o dual-forge · issues 58, 57'),
      'linha da wave 1 na árvore desenhada'
    )
    assert.ok(texts.includes('2h · bugfix'), 'estimate/playbook na descrição')
    assert.ok(texts.includes('Wave 2 · Fechar o plano · issues 42'), 'linha da wave 2')
    const play = view.find({ label: 'Executar wave 1' })
    assert.ok(play, 'botão play da wave 1')
    assert.equal(play.props.icon, 'play')
    assert.deepEqual(view.errors, [])
    await view.unmount()
  })

  test('executar wave → execute-wave com o número e nota de sucesso', async () => {
    const sent: number[] = []
    const host = mockHost({
      requests: {
        'list-reports': () => ({ reports: [] }),
        'list-waves': () => WAVES,
        'execute-wave': ({ wave }) => {
          sent.push(wave)
          return { status: 'started' as const, detail: 'Agente iniciado — acompanhe o terminal' }
        }
      }
    })
    const view = await mount(panel, { host })
    await view.press({ label: 'Executar wave 1' })
    assert.deepEqual(sent, [1], 'execute-wave recebe o número da wave')
    assert.ok(view.find({ text: /Agente iniciado/ }), 'nota de sucesso visível')
    assert.deepEqual(view.errors, [], 'nunca exceção no frame')
    await view.unmount()
  })

  test('execução falhou → nota danger com o detalhe', async () => {
    const host = mockHost({
      requests: {
        'list-reports': () => ({ reports: [] }),
        'list-waves': () => WAVES,
        'execute-wave': () => ({ status: 'failed' as const, detail: 'Escolha uma wave primeiro.' })
      }
    })
    const view = await mount(panel, { host })
    await view.press({ label: 'Executar wave 2' })
    const note = view.find({ text: /Escolha uma wave primeiro/ })
    assert.ok(note, 'nota de falha visível')
    assert.equal(note.props.tone, 'danger', 'tom destrutivo')
    assert.deepEqual(view.errors, [])
    await view.unmount()
  })

  test('sem proposta → a seção some, sem ruído de "sem proposta"', async () => {
    const host = mockHost({
      requests: {
        'list-reports': () => ({ reports: [] }),
        'list-waves': () => ({ waves: [] })
      }
    })
    const view = await mount(panel, { host })
    assert.equal(view.find({ text: WAVES_HEADING }), null, 'sem waves não há seção')
    assert.equal(view.find({ text: /sem proposta/i }), null, 'sem nota de "sem proposta"')
    assert.deepEqual(view.errors, [])
    await view.unmount()
  })

  test('proposta ilegível → nota pequena em muted, sem seção', async () => {
    const host = mockHost({
      requests: {
        'list-reports': () => ({ reports: [{ path: '/o1/report.html' }] }),
        'list-waves': () => ({ waves: [], error: 'não consegui ler a proposta de waves' })
      }
    })
    const view = await mount(panel, { host })
    assert.equal(view.find({ text: WAVES_HEADING }), null, 'sem waves não há seção')
    const note = view.find({ text: 'não consegui ler a proposta de waves' })
    assert.ok(note, 'nota da falha visível')
    assert.equal(note.props.muted, true, 'nota pequena e não destrutiva')
    assert.ok(view.find({ text: 'o1/report.html' }), 'a lista de relatórios segue intacta')
    assert.deepEqual(view.errors, [], 'nunca exceção no frame')
    await view.unmount()
  })

  test('ordem das seções: avaliação → proposta → issues → tarefa → configuração', async () => {
    const host = mockHost({
      requests: {
        'list-reports': () => ({ reports: [] }),
        'list-waves': () => WAVES,
        'list-issues': () => ({
          issues: [
            { number: 42, title: 'Corrigir o write-back dual-forge', url: 'https://gl/42', labels: [] }
          ]
        })
      }
    })
    const view = await mount(panel, { host })
    const texts = textsOf(view.tree())
    const at = (needle: string): number => texts.findIndex((text) => text.includes(needle))
    const order = [
      'Avaliação',
      'Proposta de waves',
      'Issues abertas',
      'Qual tarefa?',
      'Preparar e gerar relatório'
    ].map(at)
    assert.ok(order.every((index) => index !== -1), `seções desenhadas: ${JSON.stringify(order)}`)
    assert.deepEqual(
      order,
      [...order].sort((a, b) => a - b),
      'ordem do painel: avaliação → proposta → issues → tarefa → configuração'
    )
    assert.deepEqual(view.errors, [])
    await view.unmount()
  })
})

// --- iconografia por props + regressão da varredura de emoji ---
//
// Nenhuma figurinha vive em texto de UI/copy: a semântica vem das props de ícone
// (`rocket`, `settings`, `search`, `zap`, `play`, `refresh`, `check`, `warning`, `error`).
// A varredura abaixo falha se qualquer codepoint emoji voltar para um arquivo de src/.
// Os glyphs de auto-verificação do detector são montados por codepoint — um literal de
// emoji neste próprio arquivo seria pego pela própria varredura.

/** Faixas de codepoint proibidas em qualquer string (código, comentário ou copy) de src/. */
const EMOJI_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1f000, 0x1ffff], // emoticons, transporte e símbolos suplementares
  [0x2600, 0x27bf], // miscellaneous symbols + dingbats (check, warning, zap, error)
  [0x2b00, 0x2bff], // miscellaneous symbols and arrows
  [0x2300, 0x23ff], // miscellaneous technical (relógios, controles de mídia)
  [0x25a0, 0x25ff], // geometric shapes (setas de mídia em bloco)
  [0xfe0e, 0xfe0f] // seletores de apresentação texto/emoji
]

/** Whether ONE codepoint is an emoji (seta de prosa e travessão nunca entram aqui). */
function isEmojiCode(code: number): boolean {
  return EMOJI_RANGES.some(([from, to]) => code >= from && code <= to)
}

/** Whether ANY codepoint of the text is an emoji — iterates by code point, not UTF-16 unit. */
function isEmoji(text: string): boolean {
  for (const char of text) {
    if (isEmojiCode(char.codePointAt(0) ?? 0)) return true
  }
  return false
}

/** The plugin's `src/`, found from the runner's cwd (repo root OR the plugin folder). */
function srcDirectory(): string {
  let dir = process.cwd()
  for (let depth = 0; depth < 6; depth += 1) {
    for (const candidate of [join(dir, 'src'), join(dir, 'plugin/alethe-report/src')]) {
      if (existsSync(join(candidate, 'panel.tsx')) && existsSync(join(candidate, 'worker.ts'))) {
        return candidate
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`src/ não encontrado a partir de ${process.cwd()}`)
}

describe('iconografia por props (nunca emoji em texto)', () => {
  test('botões e ícones das seções novas chegam como props', async () => {
    const host = mockHost({
      requests: {
        'list-reports': () => ({ reports: [] }),
        'list-waves': () => ({ waves: [{ id: 1, title: 'T', issues: [9] }] })
      }
    })
    const view = await mount(panel, { host })
    assert.equal(view.find(START_BUTTON)?.props.icon, 'rocket', 'Orquestrar tarefa → icon rocket')
    assert.equal(
      view.find({ role: 'button', text: 'Preparar e gerar relatório' })?.props.icon,
      'settings',
      'Preparar → icon settings'
    )
    assert.equal(view.find({ role: 'button', text: 'Recarregar' })?.props.icon, 'refresh')
    assert.equal(view.find(ASSESS_BUTTON)?.props.icon, 'search', 'Avaliar → icon search')
    assert.equal(view.find({ label: 'Executar wave 1' })?.props.icon, 'play')
    assert.deepEqual(view.errors, [], 'nunca exceção no frame')
    await view.unmount()
  })
})

describe('varredura de emoji (regressão)', () => {
  test('o detector reconhece os codepoints proíbidos e ignora a prosa', () => {
    for (const code of [0x1f680, 0x2699, 0x1f50d, 0x2713, 0x26d4, 0x2705, 0x26a1]) {
      assert.ok(isEmoji(String.fromCodePoint(code)), `codepoint U+${code.toString(16)}`)
    }
    for (const prose of ['→', '·', '—', 'seta → fluxo', 'Orquestrar tarefa', 'Avaliar projeto']) {
      assert.equal(isEmoji(prose), false, `prosa aceita: ${prose}`)
    }
  })

  test('nenhum codepoint emoji em nenhum arquivo .ts/.tsx de src/', () => {
    const dir = srcDirectory()
    const files = readdirSync(dir).filter((name) => name.endsWith('.ts') || name.endsWith('.tsx'))
    assert.ok(files.length >= 5, `arquivos varridos: ${files.join(', ')}`)
    const hits: string[] = []
    for (const name of files) {
      readFileSync(join(dir, name), 'utf8')
        .split('\n')
        .forEach((line, index) => {
          for (const char of line) {
            if (isEmoji(char)) {
              hits.push(`${name}:${index + 1}: U+${(char.codePointAt(0) ?? 0).toString(16)}`)
              break
            }
          }
        })
    }
    assert.deepEqual(hits, [], `emoji em src/: ${hits.join(', ')}`)
  })
})
