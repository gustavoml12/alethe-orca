// Runs src/worker.ts's activate(orca) with the orca object Orca passes, over a mock host, and
// exercises the pure helpers of src/reports.ts directly.
import { assert, describe, mockHost, mountWorker, test } from 'orca/testing'
import { spawnSync } from 'node:child_process'
import * as main from './worker'
import {
  assess,
  checkCommand,
  doctorCommand,
  executeWave,
  findCommand,
  folderCommand,
  gitlabAuthCommand,
  githubAuthCommand,
  installCommand,
  isReportPath,
  issuesCommand,
  judgeTabCreate,
  listIssues,
  listReports,
  listWaves,
  normalizeWave,
  parseDoctorOutput,
  parseFindOutput,
  parseInstallOutput,
  parseIssuesOutput,
  parseSetupCheck,
  parseSetupFolder,
  parseSetupWrite,
  parseWavesOutput,
  PROPOSE_KICKOFF,
  proposeWaves,
  setupReport,
  shellQuote,
  startIssue,
  startTask,
  wavesCommand,
  writeCommand,
  executeWaveKickoff,
  type Host
} from './reports'

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

describe('shellQuote', () => {
  test('path with space and double quote goes into the command wrapped in single quotes', () => {
    const path = '/tmp/my "dir"/report.html'
    const command = `orca tab create --url ${shellQuote(`file://${path}`)} --json`
    assert.ok(command.includes(`'file://${path}'`), 'caminho entre aspas simples')
    assert.ok(!command.includes('--url "'), 'nunca aspas duplas como delimitador da URL')
  })

  test('escapes an embedded single quote as a closed-quoted sequence', () => {
    assert.equal(shellQuote("it's"), `'it'\\''s'`)
  })
})

describe('judgeTabCreate', () => {
  test('"ok": true is success', () => {
    assert.equal(judgeTabCreate('{"ok": true}').ok, true)
  })

  test('empty output is not success', () => {
    assert.equal(judgeTabCreate('').ok, false)
  })

  test('"command not found" is not success', () => {
    assert.equal(judgeTabCreate('command not found: orca').ok, false)
  })

  test('"ok": false fails and carries the error', () => {
    const verdict = judgeTabCreate('{"ok": false, "error": "x"}')
    assert.equal(verdict.ok, false)
    assert.equal(verdict.error, '{"ok": false, "error": "x"}')
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
    tw.host.respond('terminal.read', { lines: ['{"ok": true}'], truncated: false })
    tw.host.respond('terminal.close', { closed: true })
    const res = await tw.request('open-report', { path: '/x/report.html' })
    assert.equal(res.opened, true)
    assert.equal(res.via, 'browser-tab')
    const create = tw.host.callsOf('terminal.create')[0] as { command: string }
    assert.equal(create.command, `orca tab create --url 'file:///x/report.html' --json`)
    assert.equal(tw.host.callsOf('terminal.close').length, 1)
    await tw.deactivate()
  })

  test('reports what the terminal said and never tries editor.open', async () => {
    const tw = await mountWorker(main)
    tw.host.respond('workspace.readContext', CONTEXT)
    tw.host.respond('terminal.create', { terminalId: 't1' })
    tw.host.respond('terminal.read', {
      lines: ['{"ok": false, "error": "tab create refused"}'],
      truncated: false
    })
    tw.host.respond('terminal.close', { closed: true })
    const res = await tw.request('open-report', { path: '/x/report.html' })
    assert.equal(res.opened, false)
    assert.equal(res.via, 'none')
    assert.match(res.error ?? '', /tab create refused/)
    assert.deepEqual(tw.host.callsOf('editor.open'), [], 'sem workspace:write não há fallback')
    assert.equal(tw.host.callsOf('terminal.close').length, 1)
    await tw.deactivate()
  })

  test('rejects a path that is not report.html before any terminal is created', async () => {
    const tw = await mountWorker(main)
    const res = await tw.request('open-report', { path: '/etc/passwd' })
    assert.equal(res.opened, false)
    assert.equal(res.via, 'none')
    assert.match(res.error ?? '', /report\.html/)
    assert.deepEqual(tw.host.callsOf('terminal.create'), [], 'sem terminal.create, sem shell')
    await tw.deactivate()
  })
})

/** The orchestration folder a scripted run "finds"; the command echoes it with a trailing `/`. */
const FOLDER = '/home/u/.config/alethe/orchestrations/o1'

/** Answers each `terminal.create` from the command it carries, so a whole flow runs unattended. */
function scriptedHost(answer: (command: string) => string): {
  host: Host
  created: string[]
  closed: string[]
} {
  const created: string[] = []
  const closed: string[] = []
  const outputs = new Map<string, string>()
  let seq = 0
  const host: Host = {
    call: async (method, params) => {
      if (method === 'workspace.readContext') return { workspaceId: 'w1' }
      if (method === 'terminal.create') {
        const command = String((params as { command?: string }).command ?? '')
        created.push(command)
        seq += 1
        const id = `t${seq}`
        outputs.set(id, answer(command))
        return { terminalId: id }
      }
      if (method === 'terminal.read') {
        const id = String((params as { terminalId?: string }).terminalId ?? '')
        return { lines: [outputs.get(id) ?? ''], truncated: false }
      }
      if (method === 'terminal.close') {
        closed.push(String((params as { terminalId?: string }).terminalId ?? ''))
        return { closed: true }
      }
      return {}
    }
  }
  return { host, created, closed }
}

/** Routes a scripted command to the step's answer, by the marker each command carries. */
function flowScript(step: {
  check: string
  install?: string
  folder: string
  write?: string
}): (command: string) => string {
  return (command) => {
    if (command.includes('orchestrate.py report')) return step.write ?? 'WROTE_FAIL'
    if (command.includes('ls -td')) return step.folder
    if (command.includes('git clone')) return step.install ?? 'INSTALL_FAILED'
    return step.check
  }
}

// Instalação é julgada só pelo marcador completo: um eco do comando (ou um clone que estourou
// o prazo) não pode passar por "instalado" só porque a fonte carrega a palavra INSTALLED.
describe('parseInstallOutput', () => {
  test('INSTALLED_OK → ok', () => {
    assert.equal(parseInstallOutput('...\nINSTALLED_OK\n'), 'ok')
  })

  test('INSTALLED sozinho (eco de echo-only/timeout) → failed', () => {
    assert.equal(parseInstallOutput('INSTALLED'), 'failed')
    assert.equal(parseInstallOutput('echo INSTALLED\n'), 'failed')
  })

  test('vazio e INSTALL_FAILED → failed', () => {
    assert.equal(parseInstallOutput(''), 'failed')
    assert.equal(parseInstallOutput('git clone: fatal\nINSTALL_FAILED\n'), 'failed')
  })

  test('regressão: a linha de eco antiga, que traz INSTALLED literal, não passa como ok', () => {
    // O código antigo gerava `echo INSTALLED"_"OK`: o parser velho via só `INSTALLED` e
    // respondia "instalado" a partir do eco, sem nenhum resultado real.
    const oldEcho = 'rm -rf /tmp/x && echo INSTALLED"_"OK || echo INSTALL"_"FAILED'
    assert.equal(parseInstallOutput(oldEcho), 'failed')
    assert.equal(parseInstallOutput(`${oldEcho}\nINSTALLED_OK`), 'ok')
  })
})

describe('parseSetupCheck', () => {
  test('INSTALLED e INSTALLED_OK contam como instalado', () => {
    assert.equal(parseSetupCheck('INSTALLED'), 'installed')
    assert.equal(parseSetupCheck('INSTALLED_OK'), 'installed')
  })

  test('MISSING → missing', () => {
    assert.equal(parseSetupCheck('MISSING'), 'missing')
  })

  test('INSTALL_FAILED → failed', () => {
    assert.equal(parseSetupCheck('INSTALL_FAILED'), 'failed')
  })

  test('saída sem marcador reconhecido → failed', () => {
    assert.equal(parseSetupCheck('command not found: test'), 'failed')
    assert.equal(parseSetupCheck(''), 'failed')
  })

  test('o eco do comando no PTY não decide o resultado (último marcador vence)', () => {
    assert.equal(parseSetupCheck(`test -f x && echo INSTALLED || echo MISSING\nMISSING`), 'missing')
    assert.equal(parseSetupCheck(`test -f x && echo INSTALLED || echo MISSING\nINSTALLED`), 'installed')
    assert.equal(parseSetupCheck(`${installCommand()}\nINSTALL_FAILED`), 'failed')
    assert.equal(parseSetupCheck(`${installCommand()}\nINSTALLED_OK`), 'installed')
  })
})

describe('parseSetupFolder', () => {
  test('NO_ORCH → no-orch', () => {
    assert.equal(parseSetupFolder('NO_ORCH').kind, 'no-orch')
  })

  test('NO_RUNS → no-runs', () => {
    assert.equal(parseSetupFolder('NO_RUNS').kind, 'no-runs')
  })

  test('FOLDER= devolve a pasta sem barra final', () => {
    const parsed = parseSetupFolder(`FOLDER=${FOLDER}/`)
    assert.equal(parsed.kind, 'found')
    assert.equal(parsed.kind === 'found' ? parsed.folder : '', FOLDER)
  })

  test('eco do comando não engana: o resultado real é o último', () => {
    assert.equal(parseSetupFolder(`${folderCommand()}\nNO_RUNS`).kind, 'no-runs')
    const parsed = parseSetupFolder(`${folderCommand()}\nFOLDER=${FOLDER}/`)
    assert.equal(parsed.kind === 'found' ? parsed.folder : '', FOLDER)
  })
})

describe('parseSetupWrite', () => {
  test('WROTE_OK → true, WROTE_FAIL → false', () => {
    assert.equal(parseSetupWrite('WROTE_OK'), true)
    assert.equal(parseSetupWrite('WROTE_FAIL'), false)
    assert.equal(parseSetupWrite(''), false)
  })

  test('eco do comando não engana', () => {
    const command = writeCommand(FOLDER)
    assert.equal(parseSetupWrite(`${command}\nWROTE_OK`), true)
    assert.equal(parseSetupWrite(`${command}\nWROTE_FAIL`), false)
  })
})

describe('setupReport over an injected host', () => {
  test('instala, acha a pasta e gera o relatório; um close por terminal criado', async () => {
    const { host, created, closed } = scriptedHost(
      flowScript({
        check: 'MISSING',
        install: 'INSTALLED_OK',
        folder: `FOLDER=${FOLDER}/`,
        write: 'WROTE_OK'
      })
    )
    const res = await setupReport(host)
    assert.equal(res.status, 'generated')
    assert.equal(res.installed, true, 'esta chamada instalou o alethe')
    assert.equal(res.path, `${FOLDER}/report.html`)
    assert.equal(res.detail, 'Relatório gerado')
    assert.equal(created.length, 4, 'check, install, folder, write')
    assert.deepEqual(closed, ['t1', 't2', 't3', 't4'], 'cada terminal criado é fechado no finally')
    assert.ok(created[3].includes(shellQuote(FOLDER)), 'a pasta vai entre aspas simples no comando')
  })

  test('já instalado pula o clone (nenhum comando de git clone enviado)', async () => {
    const { host, created } = scriptedHost(
      flowScript({ check: 'INSTALLED', folder: `FOLDER=${FOLDER}/`, write: 'WROTE_OK' })
    )
    const res = await setupReport(host)
    assert.equal(res.status, 'generated')
    assert.equal(res.installed, false, 'não instalou nada nesta chamada')
    assert.equal(created.length, 3, 'sem o passo de instalação')
    assert.deepEqual(
      created.filter((command) => command.includes('git clone')),
      [],
      'clone nunca enviado'
    )
  })

  test('NO_RUNS → no-runs e nenhum comando de relatório', async () => {
    const { host, created } = scriptedHost(flowScript({ check: 'INSTALLED', folder: 'NO_RUNS' }))
    const res = await setupReport(host)
    assert.equal(res.status, 'no-runs')
    assert.equal(res.installed, false)
    assert.match(res.detail, /\/alethe/, 'diz como começar')
    assert.deepEqual(
      created.filter((command) => command.includes('orchestrate.py report')),
      [],
      'sem comando de relatório'
    )
  })

  test('instalou agora e não há execuções → o detalhe diz que o alethe foi instalado', async () => {
    const { host } = scriptedHost(
      flowScript({ check: 'MISSING', install: 'INSTALLED_OK', folder: 'NO_ORCH' })
    )
    const res = await setupReport(host)
    assert.equal(res.status, 'no-runs')
    assert.equal(res.installed, true)
    assert.match(res.detail, /Alethe instalado/)
    assert.match(res.detail, /\/alethe/)
  })

  test('clone falhou → failed com a dica do gh auth e nada além do clone', async () => {
    const { host, created } = scriptedHost(
      flowScript({ check: 'MISSING', install: 'INSTALL_FAILED', folder: 'NO_RUNS' })
    )
    const res = await setupReport(host)
    assert.equal(res.status, 'failed')
    assert.equal(res.installed, false)
    assert.match(res.detail, /gh auth login/)
    assert.equal(created.length, 2, 'para depois do clone')
  })

  test('WROTE_FAIL → failed com a pasta no detalhe', async () => {
    const { host } = scriptedHost(
      flowScript({ check: 'INSTALLED', folder: `FOLDER=${FOLDER}/`, write: 'WROTE_FAIL' })
    )
    const res = await setupReport(host)
    assert.equal(res.status, 'failed')
    assert.equal(res.installed, false)
    assert.ok(res.detail.includes(FOLDER), 'o detalhe nomeia a pasta')
  })

  test('sem workspace focado → failed como dado, sem exceção', async () => {
    const host: Host = { call: async () => null }
    const res = await setupReport(host)
    assert.equal(res.status, 'failed')
    assert.match(res.detail, /workspace/)
  })
})

describe('setup-report handler', () => {
  test('roda o fluxo completo pela host e fecha cada terminal', async () => {
    const tw = await mountWorker(main)
    const outputs = new Map<string, string>()
    const script = flowScript({
      check: 'MISSING',
      install: 'INSTALLED_OK',
      folder: `FOLDER=${FOLDER}/`,
      write: 'WROTE_OK'
    })
    let seq = 0
    tw.host.respond('workspace.readContext', CONTEXT)
    tw.host.respond('terminal.create', (params: { command?: string }) => {
      seq += 1
      const id = `t${seq}`
      outputs.set(id, script(String(params.command ?? '')))
      return { terminalId: id }
    })
    tw.host.respond('terminal.read', (params: { terminalId?: string }) => ({
      lines: [outputs.get(String(params.terminalId ?? '')) ?? ''],
      truncated: false
    }))
    tw.host.respond('terminal.close', { closed: true })
    const res = await tw.request('setup-report')
    assert.equal(res.status, 'generated')
    assert.equal(res.installed, true)
    assert.equal(res.path, `${FOLDER}/report.html`)
    assert.equal(tw.host.callsOf('terminal.close').length, 4)
    await tw.deactivate()
  })

  test('falha do clone chega como resposta, não como exceção', async () => {
    const tw = await mountWorker(main)
    tw.host.respond('workspace.readContext', CONTEXT)
    tw.host.respond('terminal.create', (params: { command?: string }) => ({
      terminalId: params.command?.includes('git clone') ? 'clone' : 'check'
    }))
    tw.host.respond('terminal.read', (params: { terminalId?: string }) => ({
      lines: [params.terminalId === 'clone' ? 'INSTALL_FAILED' : 'MISSING'],
      truncated: false
    }))
    tw.host.respond('terminal.close', { closed: true })
    const res = await tw.request('setup-report')
    assert.equal(res.status, 'failed')
    assert.match(res.detail, /gh auth login/)
    assert.deepEqual(tw.host.callsOf('terminal.create').length, 2, 'para depois do clone')
    await tw.deactivate()
  })
})

// --- Marcadores que um shell de verdade tem que conseguir produzir. ---
//
// Os mocks devolvem strings desenhadas, então qualquer bug na FONTE do comando passa batido.
// Aqui o comando roda num shell real e a fonte é inspecionada: é a classe de bug em que
// `echo MISS"_"ING` imprimia `MISS_ING` (o `_` entre aspas é literal) e todo o setup morria.

/** Todos os marcadores completos que os parsers esperam ver, um por passo. */
const FULL_MARKERS = [
  'INSTALLED_OK',
  'INSTALL_FAILED',
  'NO_ORCH',
  'NO_RUNS',
  'FOLDER=',
  'WROTE_OK',
  'WROTE_FAIL',
  'INSTALLED',
  'MISSING'
] as const

/** Colapsa as aspas vazias de volta: é o texto que a fonte do comando "quer dizer". */
function collapsed(command: string): string {
  return command.replace(/""/g, '')
}

/**
 * Roda o comando num /bin/sh de verdade, passado como argv — sem uma camada extra de shell
 * entre o teste e a fonte (um `sh -c "…"` wrapper colapsaria as `""` e expandiria `$f` antes
 * do shell de verdade ver, mascarando exatamente o que se quer medir).
 */
function sh(command: string): string {
  const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' })
  if (result.error) throw result.error
  return result.stdout
}

describe('marcadores dos comandos em shell real', () => {
  test('checkCommand produz um marcador que um shell real consegue ecoar', () => {
    // O alethe pode ou não estar instalado na máquina que roda os testes — os dois casos são
    // válidos. O que NUNCA pode acontecer é o parse 'failed' que o bug do sublinhado causava.
    const out = sh(checkCommand())
    assert.notEqual(parseSetupCheck(out), 'failed', `saída real: ${JSON.stringify(out)}`)
  })

  test('checkCommand num shell real → missing quando o arquivo não existe', () => {
    // Ponto A do bug original: a fonte antiga imprimia MISS_ING e o parser via 'failed'.
    const out = sh(`test -f /tmp/alethe-definitely-missing-$$ && echo INSTAL""LED || echo MISS""ING`)
    assert.equal(parseSetupCheck(out), 'missing', `saída real: ${JSON.stringify(out)}`)
  })

  test('checkCommand num shell real → installed quando o arquivo existe', () => {
    const out = sh(`test -f /etc/hosts && echo INSTAL""LED || echo MISS""ING`)
    assert.equal(parseSetupCheck(out), 'installed', `saída real: ${JSON.stringify(out)}`)
  })

  test('nenhuma fonte carrega um marcador completo (o eco do comando nunca casa)', () => {
    const sources = [
      ['checkCommand', checkCommand()],
      ['installCommand', installCommand()],
      ['folderCommand', folderCommand()],
      ['writeCommand', writeCommand(FOLDER)]
    ] as const
    for (const [name, source] of sources) {
      for (const marker of FULL_MARKERS) {
        assert.ok(
          !source.includes(marker),
          `${name} não pode conter o marcador completo ${marker} na fonte: ${source}`
        )
      }
    }
  })

  test('colapsar "" nos argumentos de echo revela exatamente os marcadores esperados', () => {
    assert.ok(collapsed(checkCommand()).includes('echo INSTALLED'), 'INSTAL""LED → INSTALLED')
    assert.ok(collapsed(checkCommand()).includes('echo MISSING'), 'MISS""ING → MISSING')
    assert.ok(collapsed(installCommand()).includes('echo INSTALLED_OK'))
    assert.ok(collapsed(installCommand()).includes('echo INSTALL_FAILED'))
    assert.ok(collapsed(folderCommand()).includes('echo NO_ORCH'))
    assert.ok(collapsed(folderCommand()).includes('echo NO_RUNS'))
    assert.ok(collapsed(folderCommand()).includes('FOLDER=$f'))
    assert.ok(collapsed(writeCommand(FOLDER)).includes('echo WROTE_OK'))
    assert.ok(collapsed(writeCommand(FOLDER)).includes('echo WROTE_FAIL'))
  })

  test('regressão: nenhuma fonte usa o split antigo com sublinhado literal', () => {
    // No código antigo `INSTAL"_"ED` imprimia `INSTAL_ED` e `MISS"_"ING` imprimia `MISS_ING`.
    assert.ok(!checkCommand().includes('INSTAL"_"ED'), 'o split antigo nunca volta')
    assert.ok(!checkCommand().includes('MISS"_"ING'), 'o split antigo nunca volta')
    assert.ok(!installCommand().includes('INSTALLED"_"'), 'o split antigo nunca volta')
    assert.ok(!installCommand().includes('INSTALL"_"FAILED'), 'o split antigo nunca volta')
    assert.ok(!folderCommand().includes('NO"_"ORCH'), 'o split antigo nunca volta')
    assert.ok(!folderCommand().includes('NO"_"RUNS'), 'o split antigo nunca volta')
    assert.ok(!folderCommand().includes('FOLDER"="'), 'o split antigo nunca volta')
    assert.ok(!writeCommand(FOLDER).includes('WROTE"_"'), 'o split antigo nunca volta')
  })

  test('folderCommand num shell real produz um marcador reconhecido (NO_ORCH/NO_RUNS/FOLDER=)', () => {
    const out = sh(folderCommand())
    const parsed = parseSetupFolder(out)
    assert.ok(
      ['NO_ORCH', 'NO_RUNS', 'FOLDER='].some((marker) => out.includes(marker)),
      `saída real sem marcador reconhecido: ${JSON.stringify(out)}`
    )
    // O tipo vem do que o shell imprimiu, nunca de "não achei nada" genérico.
    assert.ok(['no-orch', 'no-runs', 'found'].includes(parsed.kind))
  })

  test('folderCommand num shell real → no-orch nesta máquina (o diretório está vazio)', () => {
    // Fixture adaptada ao que é verdade aqui: ~/.config/alethe/orchestrations existe e não tem
    // subpastas, então o comando real imprime NO_ORCH e o parser devolve no-orch.
    const out = sh(folderCommand())
    if (out.includes('NO_ORCH')) {
      assert.equal(parseSetupFolder(out).kind, 'no-orch', `saída real: ${JSON.stringify(out)}`)
    }
  })

  test('writeCommand num shell real produz WROTE_FAIL (o report não existe), nunca lixo', () => {
    const out = sh(writeCommand('/tmp/alethe-no-such-folder'))
    assert.equal(parseSetupWrite(out), false)
    assert.ok(out.includes('WROTE_FAIL'), `saída real: ${JSON.stringify(out)}`)
  })

  test('writeCommand num shell real → WROTE_OK quando o arquivo já existe', () => {
    // O truque do comando real: `test -f` encontra o arquivo → WROTE_OK; sem ele → WROTE_FAIL.
    // Um touch no /tmp reproduz o braço de sucesso sem precisar do orchestrate.py de verdade.
    const report = `/tmp/alethe-write-ok-$$.html`
    const out = sh(`touch ${shellQuote(report)} && test -f ${shellQuote(report)} && echo WROTE""_OK || echo WROTE""_FAIL`)
    assert.equal(parseSetupWrite(out), true, `saída real: ${JSON.stringify(out)}`)
    const missing = sh(`rm -f ${shellQuote(report)} && test -f ${shellQuote(report)} && echo WROTE""_OK || echo WROTE""_FAIL`)
    assert.equal(parseSetupWrite(missing), false, `saída real: ${JSON.stringify(missing)}`)
  })

  test('eco do installCommand num shell real (só a fonte, sem executar) nunca finge sucesso', () => {
    // Simula o que um PTY devolve quando o clone estourou o prazo: a linha do comando ecoada,
    // sem nenhum resultado. O parser da instalação tem que recusar.
    const echoOnly = sh(`echo ${shellQuote(installCommand())}`)
    assert.equal(parseInstallOutput(echoOnly), 'failed', `eco real: ${JSON.stringify(echoOnly)}`)
  })
})

// --- start-task: o primeiro passo sem atrito — o painel dispara o agente com o kickoff do alethe. ---
//
// O terminal do agente NÃO é efêmero (diferente do runStep): ele é a sessão viva que o usuário
// acompanha, então nenhum caminho daqui pode fechá-lo.

/** O runbook NDS que o kickoff aponta — caminho literal dentro do comando. */
const RUNBOOK = '~/.agents/skills/alethe/references/nds-runbook.md'

/** O kickoff exato da spec: skill + runbook + a tarefa, uma vez só. */
function kickoffOf(task: string): string {
  return (
    `Use a skill alethe para orquestrar a tarefa seguindo o runbook NDS em ${RUNBOOK}. ` +
    `TAREFA: ${task}`
  )
}

/** Host onde o terminal de check responde `checkOutput`; cada create fica registrado. */
function startHost(checkOutput: string): {
  host: Host
  created: Array<{ terminalId: string; command: string; title: string }>
  closed: string[]
} {
  const created: Array<{ terminalId: string; command: string; title: string }> = []
  const closed: string[] = []
  let seq = 0
  const host: Host = {
    call: async (method, params) => {
      if (method === 'workspace.readContext') return { workspaceId: 'w1' }
      if (method === 'terminal.create') {
        seq += 1
        const record = {
          terminalId: `t${seq}`,
          command: String((params as { command?: string }).command ?? ''),
          title: String((params as { title?: string }).title ?? '')
        }
        created.push(record)
        return { terminalId: record.terminalId }
      }
      if (method === 'terminal.read') return { lines: [checkOutput], truncated: false }
      if (method === 'terminal.close') {
        closed.push(String((params as { terminalId?: string }).terminalId ?? ''))
        return { closed: true }
      }
      return {}
    }
  }
  return { host, created, closed }
}

describe('startTask sobre host injetado', () => {
  test('tarefa vazia ou só espaços → failed antes de qualquer chamada ao host', async () => {
    const { host, created } = startHost('INSTALLED')
    for (const task of ['', '   ', '\n\t ']) {
      const res = await startTask(host, task)
      assert.equal(res.status, 'failed')
      assert.equal(res.detail, 'Escreva a tarefa antes de orquestrar.')
    }
    assert.deepEqual(created, [], 'nenhum terminal criado na validação')
  })

  test('já instalado → create do agente com opencode run + tarefa + runbook, e sem close dele', async () => {
    const { host, created, closed } = startHost('INSTALLED')
    const res = await startTask(host, 'escrever o plano de testes')
    assert.equal(res.status, 'started')
    assert.match(res.detail, /Agente iniciado/)
    const agent = created.find((record) => record.command.includes('opencode run'))
    assert.ok(agent, 'terminal do agente criado')
    assert.ok(agent.command.includes('escrever o plano de testes'), 'a tarefa vai no comando')
    assert.ok(agent.command.includes(RUNBOOK), 'o runbook vai no comando')
    assert.ok(agent.title.startsWith('alethe: '), 'título nomeia o agente')
    // O anti-pattern do runStep (fechar no finally) não pode vazar para cá.
    assert.deepEqual(
      closed.filter((terminalId) => terminalId === agent.terminalId),
      [],
      'o terminal do agente NUNCA é fechado'
    )
    assert.equal(closed.length, 1, 'só o terminal efêmero do check é fechado')
  })

  test('sequência real: o create do agente vem direto depois do workspace.readContext', async () => {
    const tw = await mountWorker(main)
    tw.host.respond('workspace.readContext', CONTEXT)
    tw.host.respond('terminal.create', (params: { command?: string }) => ({
      terminalId: String(params.command ?? '').includes('opencode run') ? 'agent' : 'check'
    }))
    tw.host.respond('terminal.read', { lines: ['INSTALLED'], truncated: false })
    tw.host.respond('terminal.close', { closed: true })
    const res = await tw.request('start-task', { task: 'refatorar o setup' })
    assert.equal(res.status, 'started')
    const calls = tw.host.calls
    const agentAt = calls.findIndex(
      (call) =>
        call.method === 'terminal.create' &&
        String((call.params as { command?: string }).command ?? '').includes('opencode run')
    )
    assert.ok(agentAt > 0, 'create do agente registrado')
    assert.equal(calls[agentAt - 1].method, 'workspace.readContext', 'readContext → create')
    const closes = tw.host.callsOf('terminal.close') as Array<{ terminalId: string }>
    assert.deepEqual(
      closes.filter((close) => close.terminalId === 'agent'),
      [],
      'o terminal do agente sobrevive (nunca fechado)'
    )
    assert.equal(closes.length, 1, 'apenas o check efêmero foi fechado')
    await tw.deactivate()
  })

  test('não instalado → o clone roda ANTES do terminal do agente', async () => {
    const tw = await mountWorker(main)
    tw.host.respond('workspace.readContext', CONTEXT)
    tw.host.respond('terminal.create', (params: { command?: string }) => {
      const command = String(params.command ?? '')
      if (command.includes('opencode run')) return { terminalId: 'agent' }
      if (command.includes('git clone')) return { terminalId: 'install' }
      return { terminalId: 'check' }
    })
    tw.host.respond('terminal.read', (params: { terminalId?: string }) => ({
      lines: [params.terminalId === 'check' ? 'MISSING' : 'INSTALLED_OK'],
      truncated: false
    }))
    tw.host.respond('terminal.close', { closed: true })
    const res = await tw.request('start-task', { task: 'refatorar o módulo' })
    assert.equal(res.status, 'started')
    const commands = (tw.host.callsOf('terminal.create') as Array<{ command: string }>).map(
      (record) => record.command
    )
    const cloneAt = commands.findIndex((command) => command.includes('git clone'))
    const agentAt = commands.findIndex((command) => command.includes('opencode run'))
    assert.ok(cloneAt !== -1, 'comando de instalação presente')
    assert.ok(cloneAt < agentAt, 'instalação antes do agente')
  })

  test('instalação falhou → failed com a dica do gh auth e nenhum terminal do agente', async () => {
    const tw = await mountWorker(main)
    tw.host.respond('workspace.readContext', CONTEXT)
    tw.host.respond('terminal.create', (params: { command?: string }) => ({
      terminalId: String(params.command ?? '').includes('git clone') ? 'install' : 'check'
    }))
    tw.host.respond('terminal.read', (params: { terminalId?: string }) => ({
      lines: [params.terminalId === 'install' ? 'INSTALL_FAILED' : 'MISSING'],
      truncated: false
    }))
    tw.host.respond('terminal.close', { closed: true })
    const res = await tw.request('start-task', { task: 'qualquer coisa' })
    assert.equal(res.status, 'failed')
    assert.match(res.detail, /gh auth login/)
    const commands = (tw.host.callsOf('terminal.create') as Array<{ command: string }>).map(
      (record) => record.command
    )
    assert.deepEqual(
      commands.filter((command) => command.includes('opencode run')),
      [],
      'sem terminal do agente'
    )
    await tw.deactivate()
  })

  test('sem workspace focado → failed com "nenhum workspace focado" e nenhum terminal', async () => {
    const tw = await mountWorker(main)
    tw.host.respond('workspace.readContext', null)
    const res = await tw.request('start-task', { task: 'qualquer coisa' })
    assert.equal(res.status, 'failed')
    assert.equal(res.detail, 'nenhum workspace focado')
    assert.deepEqual(tw.host.callsOf('terminal.create'), [], 'sem terminal, sem shell')
    await tw.deactivate()
  })

  test('a tarefa com " e $(whoami) vai entre aspas simples, nunca interpolada cru', async () => {
    const task = 'acha o "bug" e roda $(whoami) e `id`'
    const { host, created } = startHost('INSTALLED')
    const res = await startTask(host, task)
    assert.equal(res.status, 'started')
    const agent = created.find((record) => record.command.includes('opencode run'))
    assert.ok(agent, 'terminal do agente criado')
    assert.equal(
      agent.command,
      `opencode run ${shellQuote(kickoffOf(task))}`,
      'o kickoff inteiro passa pelo shellQuote'
    )
    assert.ok(!agent.command.includes('run $(whoami)'), '$(whoami) nunca cru fora das aspas')
  })

  test('o create recusado vira failed com a mensagem, nunca uma exceção', async () => {
    const host: Host = {
      call: async (method) => {
        if (method === 'workspace.readContext') return { workspaceId: 'w1' }
        if (method === 'terminal.create') throw new Error('capability_denied: terminal:send')
        if (method === 'terminal.read') return { lines: ['INSTALLED'], truncated: false }
        return {}
      }
    }
    const res = await startTask(host, 'qualquer coisa')
    assert.equal(res.status, 'failed')
    assert.match(res.detail, /capability_denied/)
  })
})

describe('start-task handler', () => {
  test('tarefa vazia → failed sem nenhuma chamada ao host (nem terminal.create)', async () => {
    const tw = await mountWorker(main)
    const res = await tw.request('start-task', { task: '   ' })
    assert.equal(res.status, 'failed')
    assert.equal(res.detail, 'Escreva a tarefa antes de orquestrar.')
    assert.deepEqual(tw.host.callsOf('terminal.create'), [], 'sem terminal.create')
    assert.deepEqual(tw.host.callsOf('workspace.readContext'), [], 'validação antes de tudo')
    assert.deepEqual(tw.host.calls, [], 'nenhuma chamada ao host antes de validar')
    await tw.deactivate()
  })

  test('falha chega como resposta (logada), nunca como exceção', async () => {
    const tw = await mountWorker(main)
    tw.host.respond('workspace.readContext', null)
    const res = await tw.request('start-task', { task: 'qualquer coisa' })
    assert.equal(res.status, 'failed')
    assert.match(res.detail, /workspace/)
    assert.ok(tw.logs.some((line) => line.includes('start-task')), 'falha também vai para o log')
    await tw.deactivate()
  })
})

// --- list-issues: as issues abertas do projeto aparecem no painel. ---
//
// Um só comando efêmero escolhe o forge pelo remote (glab no GitLab, gh no GitHub),
// e o parse sobrevive ao eco do comando no PTY (a fonte carrega `[` e `]` do `if [ -z ]`,
// então "primeiro [ até último ]" cego quebraria: cada candidato a `[` é tentado até
// JSON.parse aceitar um array).

/** Todos os marcadores completos que `parseIssuesOutput` espera ver, mais o do fluxo. */
const ISSUE_MARKERS = ['NO_REPO', 'ISSUES_DONE'] as const

describe('issuesCommand', () => {
  test('fonte não carrega nenhum marcador completo (o eco nunca casa)', () => {
    const source = issuesCommand()
    for (const marker of ISSUE_MARKERS) {
      assert.ok(!source.includes(marker), `${marker} só quebrado com "" na fonte: ${source}`)
    }
    assert.ok(source.includes('NO""_REPO'), 'split com aspas vazias, nunca "_"')
    assert.ok(source.includes('ISSUES""_DONE'), 'split com aspas vazias, nunca "_"')
    assert.ok(!source.includes('NO"_"REPO'), 'o split antigo com sublinhado não volta')
    assert.ok(!source.includes('ISSUES"_"DONE'), 'o split antigo com sublinhado não volta')
  })

  test('escolhe o forge pelo remote: glab no GitLab, gh no GitHub com --limit 20 abertas', () => {
    const source = issuesCommand()
    assert.match(source, /git remote get-url origin/)
    assert.match(source, /grep -qi gitlab/)
    assert.match(source, /glab issue list -O json/)
    assert.match(source, /gh issue list --limit 20 --json number,title,url,labels --state open/)
  })

  test('sem remote → NO_REPO num shell real, e o parse lê o marcador', () => {
    const out = sh('cd /tmp && ' + issuesCommand())
    assert.ok(out.includes('NO_REPO'), `saída real: ${JSON.stringify(out)}`)
    const parsed = parseIssuesOutput(out)
    assert.deepEqual(parsed.issues, [])
    assert.match(parsed.error ?? '', /workspace sem remote git/)
  })

  test('colapsar "" revela exatamente os marcadores esperados', () => {
    assert.ok(collapsed(issuesCommand()).includes('echo NO_REPO'))
    assert.ok(collapsed(issuesCommand()).includes('echo ISSUES_DONE'))
  })

  // ROOT CAUSE (reproduzido ao vivo): em TTY o gh imprime JSON PRETTY (29 issues → 1000+
  // linhas), mas o terminal.read do Orca devolve só as 200 mais NOVAS — o começo do array
  // (com o `[` inicial) é cortado e o parse cai no meio do array. O pipe `tr -d '\n'` deixa
  // o payload em UMA linha antes do eco/read, então as 200 linhas nunca cortam o JSON.
  test("output pretty de 300 linhas parseia após o tr -d \\n (regra do terminal.read)", () => {
    const build = [
      'rm -rf /tmp/ndsfake && mkdir -p /tmp/ndsfake',
      // fake gh E fake glab (o remote decide qual roda): imprimem um array JSON PRETTY
      // de >200 linhas (10 issues + linhas em branco de espaço entre elementos), exit 0
      `printf '#!/bin/sh\\ncat <<'\\''JSON'\\''\\n[\\n' > /tmp/ndsfake/gh`,
      `for i in $(seq 1 10); do if [ "$i" -gt 1 ]; then printf ',\\n' >> /tmp/ndsfake/gh; fi; printf '  {\\n    "number": %s,\\n    "title": "t%s",\\n    "url": "https://x/%s",\\n    "labels": [{"name": "a"}]\\n  }\\n' "$i" "$i" "$i" >> /tmp/ndsfake/gh; printf '\\n\\n\\n\\n\\n\\n\\n\\n\\n\\n\\n\\n\\n\\n\\n\\n\\n\\n\\n\\n\\n\\n\\n\\n\\n' >> /tmp/ndsfake/gh; done`,
      `printf ']\\nJSON\\n' >> /tmp/ndsfake/gh`,
      'chmod +x /tmp/ndsfake/gh',
      'cp /tmp/ndsfake/gh /tmp/ndsfake/glab'
    ].join('; ')
    const built = spawnSync('/bin/sh', ['-c', build], { encoding: 'utf8' })
    assert.equal(built.error, undefined, 'construção do fake falhou')
    // A condição que bitou: o fake EMITE mais de 200 linhas de JSON pretty.
    const raw = spawnSync('/bin/sh', ['-c', '/tmp/ndsfake/gh | wc -l'], { encoding: 'utf8' })
    assert.ok(
      Number(raw.stdout.trim()) > 200,
      `o fake gh deve emitir >200 linhas pretty: ${raw.stdout.trim()}`
    )
    // O comando REAL, com o fake na PATH, cortado como o terminal.read do Orca corta
    // (só as 200 linhas mais novas chegam ao parser — as de cima, com o `[`, somem).
    // Os parênteses envolvem o comando INTEIRO: sem eles o `| tail` pegaria só o echo.
    const script = [
      'rm -rf /tmp/ndsfake-cut',
      'mkdir -p /tmp/ndsfake-cut',
      'cd /tmp/ndsfake-cut',
      // remote github (sem ele o comando cairia no braço NO_REPO, não no gh)
      'git init -q . && git remote add origin https://github.com/gustavoml12/alethe-orca.git',
      'export PATH=/tmp/ndsfake:$PATH',
      '(' + issuesCommand() + ') | tail -n 200'
    ].join('; ')
    const out = spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8' }).stdout
    const parsed = parseIssuesOutput(out)
    assert.equal(parsed.error, undefined, `parse falhou: ${parsed.error}`)
    assert.equal(parsed.issues.length, 10, 'todos os issues parseados apesar do corte')
    assert.equal(
      parsed.issues[0]?.number,
      1,
      'o primeiro issue sobrevive: sem o tr -d \\n o `[` inicial é cortado'
    )
  })
})

describe('parseIssuesOutput', () => {
  test('forma do gh: labels [{name}] viram strings', () => {
    const out =
      '[{"number":3,"title":"Bug no painel","url":"https://gh/3","labels":[{"name":"bug"},{"name":"ui"}]}]\n' +
      'ISSUES_DONE'
    const parsed = parseIssuesOutput(out)
    assert.equal(parsed.error, undefined)
    assert.deepEqual(parsed.issues, [
      { number: 3, title: 'Bug no painel', url: 'https://gh/3', labels: ['bug', 'ui'] }
    ])
  })

  test('forma do glab: iid + web_url + labels de string', () => {
    const out =
      '[{"iid":7,"title":"Ajuste NDS","web_url":"https://gl/7","labels":["enhancement"]}]\nISSUES_DONE'
    const parsed = parseIssuesOutput(out)
    assert.equal(parsed.error, undefined)
    assert.deepEqual(parsed.issues, [
      { number: 7, title: 'Ajuste NDS', url: 'https://gl/7', labels: ['enhancement'] }
    ])
  })

  test('forma do glab aceita url quando web_url não existe', () => {
    const parsed = parseIssuesOutput('[{"iid":9,"title":"T","url":"https://gl/9","labels":[]}]\nISSUES_DONE')
    assert.deepEqual(parsed.issues, [{ number: 9, title: 'T', url: 'https://gl/9', labels: [] }])
  })

  test('JSON malformado → erro como dado, nunca exceção', () => {
    const parsed = parseIssuesOutput('[{"number": 1,\nISSUES_DONE')
    assert.deepEqual(parsed.issues, [])
    assert.match(parsed.error ?? '', /não consegui ler as issues/)
  })

  test('sem JSON nenhum (gh/glab ausente) → mesmo erro de leitura', () => {
    const parsed = parseIssuesOutput('gh: command not found\nISSUES_DONE')
    assert.deepEqual(parsed.issues, [])
    assert.match(parsed.error ?? '', /não consegui ler as issues/)
  })

  test('NO_REPO → workspace sem remote git', () => {
    const parsed = parseIssuesOutput('echo NO""_REPO\nNO_REPO\nISSUES_DONE')
    assert.deepEqual(parsed.issues, [])
    assert.match(parsed.error ?? '', /workspace sem remote git/)
  })

  test('zero issues → array vazio sem erro', () => {
    const parsed = parseIssuesOutput('[]\nISSUES_DONE')
    assert.deepEqual(parsed.issues, [])
    assert.equal(parsed.error, undefined)
  })

  test('o eco do comando (com [ e ] do if) não engana o parse', () => {
    // A fonte real carrega `if [ -z "$url" ]`: um "primeiro [ até último ]" cego
    // engoliria o eco e o JSON.parse falharia. O parser tem que achar o array REAL.
    const json = '[{"number":1,"title":"Eco","url":"u","labels":[]}]'
    const parsed = parseIssuesOutput(`${issuesCommand()}\n${json}\nISSUES_DONE`)
    assert.equal(parsed.error, undefined, `erro inesperado: ${parsed.error}`)
    assert.deepEqual(parsed.issues, [{ number: 1, title: 'Eco', url: 'u', labels: [] }])
  })

  // SEGUNDO modo de falha observado ao vivo (após o tr -d '\n'): o terminal do Orca
  // descarta o MAIS ANTIGO quando a saída total passa de ~7.5KB, e o corte cai DENTRO
  // do JSON de uma linha só — sobra `…título…","url":…}]` sem o `[` inicial.
  // A recobra tenta cada `{` como início de objeto até JSON.parse aceitar um array.
  test('cabeça cortada pela retenção do terminal → recupera as issues completas', () => {
    const issues = Array.from({ length: 20 }, (_, i) => ({
      number: 100 - i,
      title: `Issue ${i} com um título razoavelmente longo para ocupar espaço de verdade e mais um monte de palavras aqui para inflar o payload do JSON acima de sete kilobytes, como o gh real faz com vinte issues abertas — e ainda mais texto de preenchimento para garantir que o corte de 1500 bytes caia bem no meio dos dados`,
      url: `https://github.com/x/y/issues/${100 - i}`,
      labels: [{ name: 'bug' }]
    }))
    const full = JSON.stringify(issues)
    assert.ok(full.length > 7000, `payload grande como o gh real: ${full.length}`)
    const cut = full.slice(1500) // o `[` inicial e o começo de algumas issues já não existem
    // O esperado é derivado do próprio corte (que objeto começa DEPOIS da posição 1500),
    // sem passar pelo parser: a primeira issue 100% completa após o corte.
    const firstCompleteAt = issues.findIndex((_, i) => full.indexOf(`{"number":${100 - i}`) >= 1500)
    const expected = issues.slice(firstCompleteAt)
    assert.ok(expected.length >= 15, `corte deixa issues suficientes: ${expected.length}`)
    const parsed = parseIssuesOutput(`${cut}\nISSUES_DONE`)
    assert.equal(parsed.error, undefined, `não recuperou: ${parsed.error}`)
    assert.deepEqual(
      parsed.issues.map((issue) => issue.number),
      expected.map((issue) => issue.number),
      'as issues completas após o corte, na ordem original'
    )
    assert.ok(
      parsed.issues.every((issue) => issue.number <= 100 - firstCompleteAt),
      'a issue cortada não volta inventada'
    )
  })

  test('corta em 20 issues (máximo do painel)', () => {
    const many = JSON.stringify(
      Array.from({ length: 25 }, (_, i) => ({ number: i + 1, title: `t${i}`, url: 'u', labels: [] }))
    )
    const parsed = parseIssuesOutput(`${many}\nISSUES_DONE`)
    assert.equal(parsed.issues.length, 20)
    assert.equal(parsed.error, undefined)
  })
})

describe('listIssues sobre host injetado', () => {
  test('sequência readContext → create → read → close, com o JSON parseado', async () => {
    const json = '[{"number":5,"title":"X","url":"https://gl/5","labels":["bug"]}]'
    const { host, created, closed } = scriptedHost((command) =>
      command.includes('git remote get-url') ? `${json}\nISSUES_DONE` : ''
    )
    const res = await listIssues(host)
    assert.equal(res.error, undefined)
    assert.deepEqual(res.issues, [{ number: 5, title: 'X', url: 'https://gl/5', labels: ['bug'] }])
    assert.equal(created.length, 1, 'um só terminal efêmero')
    assert.deepEqual(closed, ['t1'], 'fechado no finally, como todo efêmero')
  })

  test('NO_REPO → erro como dado, com o terminal fechado', async () => {
    const { host, closed } = scriptedHost(() => 'NO_REPO\nISSUES_DONE')
    const res = await listIssues(host)
    assert.deepEqual(res.issues, [])
    assert.match(res.error ?? '', /workspace sem remote git/)
    assert.deepEqual(closed, ['t1'])
  })

  test('host rejeita → erro como dado, nunca exceção', async () => {
    const host: Host = {
      call: async () => {
        throw new Error('boom')
      }
    }
    const res = await listIssues(host)
    assert.deepEqual(res.issues, [])
    assert.match(res.error ?? '', /boom/)
  })

  test('o handler responde a lista e registra falha no log', async () => {
    const tw = await mountWorker(main)
    tw.host.respond('workspace.readContext', CONTEXT)
    tw.host.respond('terminal.create', { terminalId: 't1' })
    tw.host.respond('terminal.read', {
      lines: ['[{"number":2,"title":"Y","url":"u","labels":[]}]\nISSUES_DONE'],
      truncated: false
    })
    tw.host.respond('terminal.close', { closed: true })
    const res = await tw.request('list-issues')
    assert.deepEqual(res.issues, [{ number: 2, title: 'Y', url: 'u', labels: [] }])
    assert.equal(res.error, undefined)
    assert.equal(tw.host.callsOf('terminal.close').length, 1)
    await tw.deactivate()
  })

  test('falha do handler chega como resposta com error, logada', async () => {
    const tw = await mountWorker(main)
    tw.host.respond('workspace.readContext', null)
    const res = await tw.request('list-issues')
    assert.deepEqual(res.issues, [])
    assert.ok(res.error, 'erro propagado como resposta')
    assert.ok(tw.logs.some((line) => line.includes('list-issues')), 'erro também vai para o log')
    await tw.deactivate()
  })
})

// --- start-issue: o botão de uma linha da seção de issues dispara a mesma orquestração. ---

/** O kickoff exato da spec: issue + runbook + dry-run + AGUARDE minha aprovação. */
function issueKickoffOf(issue: { number: number; title: string; url: string }): string {
  return (
    `Use a skill alethe para orquestrar a tarefa da issue #${issue.number}: "${issue.title}" — ${issue.url}. ` +
    'Leia a issue com gh (ou glab) e siga o runbook NDS em ' +
    `${RUNBOOK}. ` +
    'Após analisar, MOSTRE o dry-run (playbook, waves, modelos e estimativa) e ' +
    'AGUARDE minha aprovação antes de executar qualquer wave.'
  )
}

describe('startIssue sobre host injetado', () => {
  test('sem number ou title → failed "Escolha uma issue primeiro." antes de qualquer host call', async () => {
    const { host, created } = startHost('INSTALLED')
    const invalid = [
      { number: 0, title: 'x', url: 'u' },
      { number: NaN, title: 'x', url: 'u' },
      { number: 3, title: '   ', url: 'u' },
      { number: 3, title: '', url: 'u' }
    ]
    for (const issue of invalid) {
      const res = await startIssue(host, issue)
      assert.equal(res.status, 'failed')
      assert.equal(res.detail, 'Escolha uma issue primeiro.')
    }
    assert.deepEqual(created, [], 'nenhum terminal criado na validação')
  })

  test('dispatch → create do agente com issue #, título, url e AGUARDE; nunca fechado', async () => {
    const issue = {
      number: 42,
      title: 'Corrigir o write-back dual-forge',
      url: 'https://gitlab.com/grp/proj/-/issues/42'
    }
    const { host, created, closed } = startHost('INSTALLED')
    const res = await startIssue(host, issue)
    assert.equal(res.status, 'started')
    const agent = created.find((record) => record.command.includes('opencode run'))
    assert.ok(agent, 'terminal do agente criado')
    assert.ok(agent.command.includes('#42'), 'o número da issue vai no kickoff')
    assert.ok(agent.command.includes(issue.title), 'o título vai no kickoff')
    assert.ok(agent.command.includes(issue.url), 'a url vai no kickoff')
    assert.ok(agent.command.includes('AGUARDE minha aprovação'), 'o dry-run e a aprovação vão no kickoff')
    assert.ok(agent.command.includes(RUNBOOK), 'o runbook NDS vai no comando')
    assert.equal(
      agent.command,
      `opencode run ${shellQuote(issueKickoffOf(issue))}`,
      'o kickoff inteiro passa pelo shellQuote'
    )
    assert.ok(agent.title.startsWith('alethe #42 '), 'título nomeia a issue')
    assert.deepEqual(
      closed.filter((terminalId) => terminalId === agent.terminalId),
      [],
      'o terminal do agente NUNCA é fechado'
    )
    assert.equal(closed.length, 1, 'só o terminal efêmero do check é fechado')
  })

  test('título longo corta em 30 caracteres no título do terminal', async () => {
    const issue = { number: 7, title: 'Um título bem comprido que passa de trinta caracteres', url: 'u' }
    const { host, created } = startHost('INSTALLED')
    await startIssue(host, issue)
    const agent = created.find((record) => record.command.includes('opencode run'))
    assert.ok(agent)
    assert.equal(agent.title, `alethe #7 ${issue.title.slice(0, 30)}`)
  })
})

describe('start-issue handler', () => {
  test('input inválido → failed sem nenhuma chamada ao host', async () => {
    const tw = await mountWorker(main)
    const res = await tw.request('start-issue', { number: 0, title: '', url: '' })
    assert.equal(res.status, 'failed')
    assert.equal(res.detail, 'Escolha uma issue primeiro.')
    assert.deepEqual(tw.host.calls, [], 'nenhuma chamada ao host antes de validar')
    await tw.deactivate()
  })

  test('dispatch completo pela host: check → agente, sem close do agente', async () => {
    const tw = await mountWorker(main)
    tw.host.respond('workspace.readContext', CONTEXT)
    tw.host.respond('terminal.create', (params: { command?: string }) => ({
      terminalId: String(params.command ?? '').includes('opencode run') ? 'agent' : 'check'
    }))
    tw.host.respond('terminal.read', { lines: ['INSTALLED'], truncated: false })
    tw.host.respond('terminal.close', { closed: true })
    const res = await tw.request('start-issue', {
      number: 9,
      title: 'Fechar o plano',
      url: 'https://gh/9'
    })
    assert.equal(res.status, 'started')
    const commands = (tw.host.callsOf('terminal.create') as Array<{ command: string }>).map(
      (record) => record.command
    )
    assert.ok(
      commands.some((command) => command.includes('#9') && command.includes('https://gh/9')),
      'kickoff com número e url'
    )
    const closes = tw.host.callsOf('terminal.close') as Array<{ terminalId: string }>
    assert.deepEqual(
      closes.filter((close) => close.terminalId === 'agent'),
      [],
      'o terminal do agente sobrevive'
    )
    assert.equal(closes.length, 1, 'apenas o check efêmero foi fechado')
    await tw.deactivate()
  })

  test('falha chega como resposta (logada), nunca como exceção', async () => {
    const tw = await mountWorker(main)
    tw.host.respond('workspace.readContext', null)
    const res = await tw.request('start-issue', { number: 1, title: 'x', url: 'u' })
    assert.equal(res.status, 'failed')
    assert.match(res.detail, /workspace/)
    assert.ok(tw.logs.some((line) => line.includes('start-issue')), 'falha também vai para o log')
    await tw.deactivate()
  })
})

// --- assess: a avaliação interna do ambiente — zero tokens, itens como dados. ---
//
// Três passos em terminais efêmeros (cada um fechado no finally do runStep): o
// ensureAlethe compartilhado, o `doctor` do orchestrate.py (JSON compacto — a MESMA lição do
// pretty-PTY das issues: `tr -d '\n'`) e o auth de cada forge. O resultado geral é
// alethe + python + ≥1 CLI; forge sem auth é item fail, nunca derruba o `ok`.

/** O payload que o `doctor` real devolve (fonte: orchestrate.py `doctor_payload`). */
const DOCTOR_JSON = JSON.stringify({
  python: { version: '3.12.4', ok: true },
  providers: [
    { provider: 'claude', installed: true, loggedIn: true },
    { provider: 'codex', installed: true, loggedIn: false },
    { provider: 'kimi', installed: false, loggedIn: null }
  ],
  installedProviders: ['claude', 'codex'],
  hints: []
})

/** Roteia os comandos do assess ao passo que cada um representa. */
function assessFlow(step: {
  check: string
  install?: string
  doctor: string
  gh: string
  glab: string
}): (command: string) => string {
  return (command) => {
    if (command.includes('orchestrate.py doctor')) return step.doctor
    if (command.includes('gh auth status')) return step.gh
    if (command.includes('glab auth status')) return step.glab
    if (command.includes('git clone')) return step.install ?? 'INSTALL_FAILED'
    return step.check
  }
}

describe('comandos do assess', () => {
  test('doctorCommand: JSON compacto, marcador quebrado com "" e NENHUMA chave na fonte', () => {
    const source = doctorCommand()
    assert.ok(source.includes('orchestrate.py doctor'), 'roda o doctor do skill')
    assert.ok(source.includes("tr -d '\\n'"), 'payload em UMA linha (lição do pretty-PTY)')
    assert.ok(source.includes('DOCTOR""_DONE'), 'marcador quebrado com aspas vazias')
    assert.ok(!source.includes('DOCTOR_DONE'), 'a fonte nunca carrega o marcador completo')
    assert.ok(!source.includes('{') && !source.includes('}'), 'sem chaves: o parse {…} não engole o eco')
  })

  test('auth das forges: marcadores quebrados com "" (nunca "_" literal)', () => {
    const gh = githubAuthCommand()
    const glab = gitlabAuthCommand()
    assert.ok(gh.includes('gh auth status'))
    assert.ok(gh.includes('GH""_OK') && gh.includes('GH""_FAIL'))
    assert.ok(!gh.includes('GH_OK') && !gh.includes('GH_FAIL'), 'sem marcador completo na fonte')
    assert.ok(glab.includes('glab auth status'))
    assert.ok(glab.includes('GLAB""_OK') && glab.includes('GLAB""_FAIL'))
    assert.ok(!glab.includes('GLAB_OK') && !glab.includes('GLAB_FAIL'), 'sem marcador completo na fonte')
  })

  test('os comandos de auth rodam em shell real e imprimem um marcador reconhecível', () => {
    assert.match(sh(githubAuthCommand()), /GH_(OK|FAIL)\s*$/)
    assert.match(sh(gitlabAuthCommand()), /GLAB_(OK|FAIL)\s*$/)
  })
})

describe('parseDoctorOutput', () => {
  test('payload real → python, CLIs e auth/quota derivados dos campos', () => {
    const info = parseDoctorOutput(`${DOCTOR_JSON}\nDOCTOR_DONE`)
    assert.ok(info, 'payload legível')
    assert.equal(info?.pythonOk, true)
    assert.equal(info?.pythonDetail, 'python 3.12.4')
    assert.deepEqual(info?.clis, ['claude', 'codex'])
    assert.deepEqual(info?.blocked, ['codex'], 'loggedIn false é problema de auth')
  })

  test('o eco do comando (sem chaves) não engole o parse', () => {
    const info = parseDoctorOutput(`${doctorCommand()}\n${DOCTOR_JSON}\nDOCTOR_DONE`)
    assert.ok(info, 'o eco não tem chaves, o payload continua íntegro')
  })

  test('python com ok:false → pythonOk false', () => {
    const info = parseDoctorOutput(JSON.stringify({ python: { version: '3.8.0', ok: false }, installedProviders: ['claude'], providers: [] }))
    assert.equal(info?.pythonOk, false)
  })

  test('campos faltando → sem CLIs, sem bloqueios, python não encontrado', () => {
    const info = parseDoctorOutput('{}')
    assert.ok(info)
    assert.deepEqual(info?.clis, [])
    assert.deepEqual(info?.blocked, [])
    assert.equal(info?.pythonOk, false)
  })

  test('sem chaves, JSON inválido ou payload não-objeto → null (nunca exceção)', () => {
    assert.equal(parseDoctorOutput('python3: command not found\nDOCTOR_DONE'), null)
    assert.equal(parseDoctorOutput('{broken\nDOCTOR_DONE'), null)
    assert.equal(parseDoctorOutput('[1,2]\nDOCTOR_DONE'), null)
    assert.equal(parseDoctorOutput(''), null)
  })
})

describe('assess sobre host injetado', () => {
  test('ambiente pronto → ok:true, seis itens na ordem e todos os terminais fechados', async () => {
    const { host, created, closed } = scriptedHost(
      assessFlow({
        check: 'INSTALLED',
        doctor: `${DOCTOR_JSON}\nDOCTOR_DONE`,
        gh: 'GH_OK',
        glab: 'GLAB_FAIL'
      })
    )
    const res = await assess(host)
    assert.equal(res.ok, true, 'alethe + python + ≥1 CLI')
    assert.deepEqual(
      res.items.map((item) => item.label),
      ['alethe', 'python', 'CLIs', 'auth/quota', 'github', 'gitlab']
    )
    assert.equal(res.items[0]?.state, 'ok')
    assert.equal(res.items[0]?.detail, 'skill + runner prontos')
    assert.equal(res.items[1]?.state, 'ok')
    assert.equal(res.items[1]?.detail, 'python 3.12.4')
    assert.equal(res.items[2]?.state, 'ok')
    assert.equal(res.items[2]?.detail, 'claude, codex')
    assert.equal(res.items[3]?.state, 'warn')
    assert.match(res.items[3]?.detail ?? '', /codex/)
    assert.equal(res.items[4]?.state, 'ok', 'gh ok sustenta o ambiente')
    assert.equal(res.items[5]?.state, 'fail', 'glab sem auth é só o item')
    assert.equal(created.length, 4, 'check + doctor + gh + glab')
    assert.deepEqual(closed, ['t1', 't2', 't3', 't4'], 'todo terminal efêmero é fechado')
  })

  test('alethe sem instalar e clone recusado → ok:false com só o item de falha', async () => {
    const { host, created } = scriptedHost(
      assessFlow({
        check: 'MISSING',
        install: 'INSTALL_FAILED',
        doctor: 'NUNCA',
        gh: 'GH_OK',
        glab: 'GLAB_OK'
      })
    )
    const res = await assess(host)
    assert.equal(res.ok, false)
    assert.equal(res.items.length, 1)
    assert.equal(res.items[0]?.label, 'alethe')
    assert.equal(res.items[0]?.state, 'fail')
    assert.match(res.items[0]?.detail ?? '', /gh auth login/)
    assert.deepEqual(
      created.filter((command) => command.includes('doctor')),
      [],
      'sem doctor quando o skill não está pronto'
    )
  })

  test('doctor sem resposta → ok:false com o item de falha no lugar dos itens do doctor', async () => {
    const { host, created } = scriptedHost(
      assessFlow({
        check: 'INSTALLED',
        doctor: 'python3: command not found\nDOCTOR_DONE',
        gh: 'GH_OK',
        glab: 'GLAB_OK'
      })
    )
    const res = await assess(host)
    assert.equal(res.ok, false)
    const labels = res.items.map((item) => item.label)
    assert.deepEqual(labels, ['alethe', 'doctor', 'github', 'gitlab'], 'um só item de falha')
    assert.equal(res.items[1]?.state, 'fail')
    assert.equal(res.items[1]?.detail, 'doctor não respondeu')
    assert.equal(created.filter((command) => command.includes('gh auth')).length, 1, 'forges seguem avaliadas')
  })

  test('host rejeita → dados, nunca exceção', async () => {
    const host: Host = {
      call: async () => {
        throw new Error('boom')
      }
    }
    const res = await assess(host)
    assert.equal(res.ok, false)
    assert.equal(res.items.length, 1)
    assert.equal(res.items[0]?.label, 'alethe')
    assert.match(res.items[0]?.detail ?? '', /boom/)
  })
})

// --- propose-waves: o leader do alethe monta a proposta (UM dispatch, só mockado aqui). ---

describe('proposeWaves sobre host injetado', () => {
  test('abre UM terminal de agente com o kickoff da spec e nunca o fecha', async () => {
    const { host, created, closed } = startHost('INSTALLED')
    const res = await proposeWaves(host)
    assert.equal(res.status, 'started')
    const agents = created.filter((record) => record.command.includes('opencode run'))
    assert.equal(agents.length, 1, 'um só dispatch')
    const agent = agents[0]
    assert.ok(agent)
    assert.equal(agent.command, `opencode run ${shellQuote(PROPOSE_KICKOFF)}`, 'kickoff inteiro no shellQuote')
    assert.ok(agent.command.includes('AVALIAR este projeto'), 'avaliar primeiro')
    assert.ok(agent.command.includes('proposals/'), 'salva em ~/.config/alethe/proposals/')
    assert.ok(agent.command.includes('NÃO execute nenhuma wave'), 'nada é executado agora')
    assert.ok(agent.command.includes('proposta salva'), 'frase final do agent')
    assert.equal(agent.title, 'alethe: propor waves')
    assert.deepEqual(
      closed.filter((terminalId) => terminalId === agent.terminalId),
      [],
      'o terminal do agente NUNCA é fechado'
    )
    assert.equal(closed.length, 1, 'só o terminal efêmero do check é fechado')
  })

  test('instalação recusada → failed como dado, sem terminal do agente', async () => {
    const created: Array<{ terminalId: string; command: string; title: string }> = []
    let seq = 0
    const host: Host = {
      call: async (method, params) => {
        if (method === 'workspace.readContext') return { workspaceId: 'w1' }
        if (method === 'terminal.create') {
          seq += 1
          const record = {
            terminalId: `t${seq}`,
            command: String((params as { command?: string }).command ?? ''),
            title: String((params as { title?: string }).title ?? '')
          }
          created.push(record)
          return { terminalId: record.terminalId }
        }
        if (method === 'terminal.read') {
          // check → MISSING, install → INSTALL_FAILED: o clone é recusado na hora, sem esperar
          // o prazo de 120s do install.
          const command = created[created.length - 1]?.command ?? ''
          return { lines: [command.includes('git clone') ? 'INSTALL_FAILED' : 'MISSING'], truncated: false }
        }
        if (method === 'terminal.close') return { closed: true }
        return {}
      }
    }
    const res = await proposeWaves(host)
    assert.equal(res.status, 'failed')
    assert.ok(created.every((record) => !record.command.includes('opencode run')), 'sem agente')
  })
})

// --- list-waves + execute-wave: a proposta salva vira waves executáveis pelo painel. ---

const WAVES_JSON = JSON.stringify({
  waves: [
    { id: 1, title: 'Corrigir o dual-forge', issues: [58, 57], playbook: 'bugfix', estimate: '2h' },
    { id: 2, title: 'Fechar o plano', issues: [42] }
  ]
})

describe('wavesCommand', () => {
  test('fonte sem chaves e sem marcador completo (o eco nunca casa)', () => {
    const source = wavesCommand()
    assert.ok(source.includes('NO""_PROPOSAL'), 'marcador quebrado com aspas vazias')
    assert.ok(source.includes('WAVES""_DONE'), 'marcador de fluxo quebrado com aspas vazias')
    assert.ok(!source.includes('NO_PROPOSAL') && !source.includes('WAVES_DONE'), 'sem marcador completo')
    assert.ok(!source.includes('{') && !source.includes('}'), 'payload é objeto: a fonte não tem chaves')
    assert.ok(source.includes("tr -d '\\n'"), 'payload em UMA linha (lição do pretty-PTY)')
  })

  test('colapsar "" revela exatamente os marcadores esperados', () => {
    assert.ok(collapsed(wavesCommand()).includes('echo NO_PROPOSAL'))
    assert.ok(collapsed(wavesCommand()).includes('echo WAVES_DONE'))
  })
})

describe('normalizeWave', () => {
  test('forma válida passa adiante, com playbook/estimate opcionais', () => {
    const wave = normalizeWave({ id: 1, title: 'T', issues: [58, 57], playbook: 'p', estimate: '2h' })
    assert.deepEqual(wave, { id: 1, title: 'T', issues: [58, 57], playbook: 'p', estimate: '2h' })
    assert.deepEqual(normalizeWave({ id: 2, title: 'T', issues: [42] }), { id: 2, title: 'T', issues: [42] })
  })

  test('id em string e issues em string viram número', () => {
    assert.deepEqual(normalizeWave({ id: '3', title: 'T', issues: ['58', 7] }), { id: 3, title: 'T', issues: [58, 7] })
  })

  test('itens malformados são descartados, nunca lançam', () => {
    assert.equal(normalizeWave(null), undefined)
    assert.equal(normalizeWave('wave'), undefined)
    assert.equal(normalizeWave({ id: 'x', title: 'T', issues: [] }), undefined, 'id sem número')
    assert.equal(normalizeWave({ id: 1, title: '', issues: [] }), undefined, 'sem título')
    assert.equal(normalizeWave({ id: 1, title: 'T' }), undefined, 'issues não é array')
    assert.deepEqual(normalizeWave({ id: 1, title: 'T', issues: ['a', null, '58'] }), { id: 1, title: 'T', issues: [58] }, 'entradas inválidas caem fora')
  })
})

describe('parseWavesOutput', () => {
  test('NO_PROPOSAL → lista vazia sem erro', () => {
    const parsed = parseWavesOutput('echo NO""_PROPOSAL\nNO_PROPOSAL\nWAVES_DONE')
    assert.deepEqual(parsed.waves, [])
    assert.equal(parsed.error, undefined)
  })

  test('objeto completo → waves normalizadas', () => {
    const parsed = parseWavesOutput(`${WAVES_JSON}\nWAVES_DONE`)
    assert.equal(parsed.error, undefined)
    assert.equal(parsed.waves.length, 2)
    assert.deepEqual(parsed.waves[0], {
      id: 1,
      title: 'Corrigir o dual-forge',
      issues: [58, 57],
      playbook: 'bugfix',
      estimate: '2h'
    })
    assert.deepEqual(parsed.waves[1], { id: 2, title: 'Fechar o plano', issues: [42] })
  })

  test('o eco do comando (sem chaves) não engole o parse', () => {
    const parsed = parseWavesOutput(`${wavesCommand()}\n${WAVES_JSON}\nWAVES_DONE`)
    assert.equal(parsed.error, undefined, `erro inesperado: ${parsed.error}`)
    assert.equal(parsed.waves.length, 2)
  })

  test('waves válido mas vazio → lista vazia sem erro', () => {
    const parsed = parseWavesOutput('{"waves":[]}\nWAVES_DONE')
    assert.deepEqual(parsed.waves, [])
    assert.equal(parsed.error, undefined)
  })

  test('JSON inválido, sem objeto ou waves que não é array → erro como dado', () => {
    for (const bad of ['{"waves":[1,\nWAVES_DONE', 'lixo\nWAVES_DONE', '{"waves":"x"}\nWAVES_DONE', '[1,2]\nWAVES_DONE']) {
      const parsed = parseWavesOutput(bad)
      assert.deepEqual(parsed.waves, [], `entrada: ${JSON.stringify(bad)}`)
      assert.match(parsed.error ?? '', /não consegui ler a proposta de waves/)
    }
  })

  test('itens malformados caem fora sem derrubar os válidos', () => {
    const parsed = parseWavesOutput(
      '{"waves":[{"id":"x","title":"ruim","issues":[]},{"id":1,"title":"boa","issues":[9]},{"title":"sem id","issues":[1]}]}\nWAVES_DONE'
    )
    assert.equal(parsed.error, undefined)
    assert.deepEqual(parsed.waves, [{ id: 1, title: 'boa', issues: [9] }])
  })
})

describe('listWaves sobre host injetado', () => {
  test('um terminal efêmero, fechado no finally, com o JSON parseado', async () => {
    const { host, created, closed } = scriptedHost((command) =>
      command.includes('proposals') ? `${WAVES_JSON}\nWAVES_DONE` : ''
    )
    const res = await listWaves(host)
    assert.equal(res.error, undefined)
    assert.equal(res.waves.length, 2)
    assert.equal(created.length, 1, 'um só terminal efêmero')
    assert.deepEqual(closed, ['t1'], 'fechado no finally')
  })

  test('sem proposta → lista vazia sem erro, terminal fechado', async () => {
    const { host, closed } = scriptedHost(() => 'NO_PROPOSAL\nWAVES_DONE')
    const res = await listWaves(host)
    assert.deepEqual(res.waves, [])
    assert.equal(res.error, undefined)
    assert.deepEqual(closed, ['t1'])
  })

  test('host rejeita → erro como dado, nunca exceção', async () => {
    const host: Host = {
      call: async () => {
        throw new Error('boom')
      }
    }
    const res = await listWaves(host)
    assert.deepEqual(res.waves, [])
    assert.match(res.error ?? '', /boom/)
  })
})

describe('executeWave sobre host injetado', () => {
  test('wave inválida → failed "Escolha uma wave primeiro." antes de qualquer host call', async () => {
    const { host, created } = startHost('INSTALLED')
    for (const wave of [0, -1, NaN, Infinity]) {
      const res = await executeWave(host, wave)
      assert.equal(res.status, 'failed')
      assert.equal(res.detail, 'Escolha uma wave primeiro.')
    }
    assert.deepEqual(created, [], 'nenhum terminal criado na validação')
  })

  test('wave válida → abre o agente com o kickoff da aprovação e nunca fecha', async () => {
    const { host, created, closed } = startHost('INSTALLED')
    const res = await executeWave(host, 3)
    assert.equal(res.status, 'started')
    const agent = created.find((record) => record.command.includes('opencode run'))
    assert.ok(agent, 'terminal do agente criado')
    assert.equal(agent.command, `opencode run ${shellQuote(executeWaveKickoff(3))}`)
    assert.ok(agent.command.includes('APROVOU pelo painel a wave 3'), 'a aprovação vai no kickoff')
    assert.ok(agent.command.includes('proposals/'), 'aponta para a proposta salva')
    assert.ok(agent.command.includes('nds-runbook.md'), 'o runbook NDS vai no comando')
    assert.equal(agent.title, 'alethe: wave 3')
    assert.deepEqual(
      closed.filter((terminalId) => terminalId === agent.terminalId),
      [],
      'o terminal do agente NUNCA é fechado'
    )
    assert.equal(closed.length, 1, 'só o terminal efêmero do check é fechado')
  })
})

// --- os handlers novos no worker: assess, propose-waves, list-waves, execute-wave. ---

/** Responde os terminais do assess pelo comando que cada um carrega. */
function seedAssess(tw: { host: { respond: (method: string, result: unknown) => void } }): void {
  tw.host.respond('workspace.readContext', CONTEXT)
  let seq = 0
  const script = assessFlow({
    check: 'INSTALLED',
    doctor: `${DOCTOR_JSON}\nDOCTOR_DONE`,
    gh: 'GH_OK',
    glab: 'GLAB_FAIL'
  })
  tw.host.respond('terminal.create', (params: { command?: string }) => {
    seq += 1
    outputsOf(tw).set(`t${seq}`, script(String(params.command ?? '')))
    return { terminalId: `t${seq}` }
  })
  tw.host.respond('terminal.read', (params: { terminalId?: string }) => ({
    lines: [outputsOf(tw).get(String(params.terminalId ?? '')) ?? ''],
    truncated: false
  }))
  tw.host.respond('terminal.close', { closed: true })
}

/** Onde o seed acima guarda a saída de cada terminal criado. */
const TERMINAL_OUTPUTS = new WeakMap<object, Map<string, string>>()
function outputsOf(tw: object): Map<string, string> {
  let map = TERMINAL_OUTPUTS.get(tw)
  if (!map) {
    map = new Map()
    TERMINAL_OUTPUTS.set(tw, map)
  }
  return map
}

describe('assess handler', () => {
  test('avalia o ambiente pela host e fecha cada terminal', async () => {
    const tw = await mountWorker(main)
    seedAssess(tw)
    const res = await tw.request('assess')
    assert.equal(res.ok, true)
    assert.equal(res.items.length, 6)
    assert.equal(res.items[4]?.label, 'github')
    assert.equal(tw.host.callsOf('terminal.close').length, 4, 'check + doctor + gh + glab')
    await tw.deactivate()
  })

  test('falha chega como resposta (logada), nunca como exceção', async () => {
    const tw = await mountWorker(main)
    tw.host.respond('workspace.readContext', null)
    const res = await tw.request('assess')
    assert.equal(res.ok, false)
    assert.equal(res.items[0]?.state, 'fail')
    assert.ok(tw.logs.some((line) => line.includes('assess')), 'erro também vai para o log')
    await tw.deactivate()
  })
})

describe('propose-waves handler', () => {
  test('dispatch completo: check → agente com o kickoff, sem close do agente', async () => {
    const tw = await mountWorker(main)
    tw.host.respond('workspace.readContext', CONTEXT)
    tw.host.respond('terminal.create', (params: { command?: string }) => ({
      terminalId: String(params.command ?? '').includes('opencode run') ? 'agent' : 'check'
    }))
    tw.host.respond('terminal.read', { lines: ['INSTALLED'], truncated: false })
    tw.host.respond('terminal.close', { closed: true })
    const res = await tw.request('propose-waves')
    assert.equal(res.status, 'started')
    const agent = (tw.host.callsOf('terminal.create') as Array<{ command: string; title: string }>).find(
      (record) => record.command.includes('opencode run')
    )
    assert.ok(agent, 'terminal do agente criado')
    assert.equal(agent?.title, 'alethe: propor waves')
    assert.ok(agent?.command.includes('NÃO execute nenhuma wave'))
    const closes = tw.host.callsOf('terminal.close') as Array<{ terminalId: string }>
    assert.deepEqual(closes.filter((close) => close.terminalId === 'agent'), [], 'agente nunca fechado')
    assert.equal(closes.length, 1, 'apenas o check efêmero')
    await tw.deactivate()
  })

  test('falha chega como resposta (logada), nunca como exceção', async () => {
    const tw = await mountWorker(main)
    tw.host.respond('workspace.readContext', null)
    const res = await tw.request('propose-waves')
    assert.equal(res.status, 'failed')
    assert.match(res.detail, /workspace/)
    assert.ok(tw.logs.some((line) => line.includes('propose-waves')), 'erro também vai para o log')
    await tw.deactivate()
  })
})

describe('list-waves handler', () => {
  test('responde as waves do arquivo mais novo e fecha o terminal', async () => {
    const tw = await mountWorker(main)
    tw.host.respond('workspace.readContext', CONTEXT)
    tw.host.respond('terminal.create', { terminalId: 't1' })
    tw.host.respond('terminal.read', { lines: [`${WAVES_JSON}\nWAVES_DONE`], truncated: false })
    tw.host.respond('terminal.close', { closed: true })
    const res = await tw.request('list-waves')
    assert.equal(res.error, undefined)
    assert.equal(res.waves.length, 2)
    assert.equal(tw.host.callsOf('terminal.close').length, 1)
    await tw.deactivate()
  })

  test('proposta ilegível chega como error (logada), nunca como exceção', async () => {
    const tw = await mountWorker(main)
    tw.host.respond('workspace.readContext', CONTEXT)
    tw.host.respond('terminal.create', { terminalId: 't1' })
    tw.host.respond('terminal.read', { lines: ['lixo\nWAVES_DONE'], truncated: false })
    tw.host.respond('terminal.close', { closed: true })
    const res = await tw.request('list-waves')
    assert.deepEqual(res.waves, [])
    assert.match(res.error ?? '', /não consegui ler a proposta de waves/)
    assert.ok(tw.logs.some((line) => line.includes('list-waves')), 'erro também vai para o log')
    await tw.deactivate()
  })
})

describe('execute-wave handler', () => {
  test('input inválido → failed sem nenhuma chamada ao host', async () => {
    const tw = await mountWorker(main)
    const res = await tw.request('execute-wave', { wave: 0 })
    assert.equal(res.status, 'failed')
    assert.equal(res.detail, 'Escolha uma wave primeiro.')
    assert.deepEqual(tw.host.calls, [], 'nenhuma chamada ao host antes de validar')
    await tw.deactivate()
  })

  test('wave aprovada → dispatch do agente, sem close dele', async () => {
    const tw = await mountWorker(main)
    tw.host.respond('workspace.readContext', CONTEXT)
    tw.host.respond('terminal.create', (params: { command?: string }) => ({
      terminalId: String(params.command ?? '').includes('opencode run') ? 'agent' : 'check'
    }))
    tw.host.respond('terminal.read', { lines: ['INSTALLED'], truncated: false })
    tw.host.respond('terminal.close', { closed: true })
    const res = await tw.request('execute-wave', { wave: 7 })
    assert.equal(res.status, 'started')
    const agent = (tw.host.callsOf('terminal.create') as Array<{ command: string; title: string }>).find(
      (record) => record.command.includes('opencode run')
    )
    assert.equal(agent?.title, 'alethe: wave 7')
    assert.ok(agent?.command.includes('wave 7'))
    const closes = tw.host.callsOf('terminal.close') as Array<{ terminalId: string }>
    assert.deepEqual(closes.filter((close) => close.terminalId === 'agent'), [], 'agente nunca fechado')
    assert.equal(closes.length, 1, 'apenas o check efêmero')
    await tw.deactivate()
  })

  test('falha chega como resposta (logada), nunca como exceção', async () => {
    const tw = await mountWorker(main)
    tw.host.respond('workspace.readContext', null)
    const res = await tw.request('execute-wave', { wave: 2 })
    assert.equal(res.status, 'failed')
    assert.match(res.detail, /workspace/)
    assert.ok(tw.logs.some((line) => line.includes('execute-wave')), 'erro também vai para o log')
    await tw.deactivate()
  })
})
