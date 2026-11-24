// Runs src/worker.ts's activate(orca) with the orca object Orca passes, over a mock host, and
// exercises the pure helpers of src/reports.ts directly.
import { assert, describe, mockHost, mountWorker, test } from 'orca/testing'
import { execSync } from 'node:child_process'
import * as main from './worker'
import {
  checkCommand,
  findCommand,
  folderCommand,
  installCommand,
  isReportPath,
  judgeTabCreate,
  listReports,
  parseFindOutput,
  parseInstallOutput,
  parseSetupCheck,
  parseSetupFolder,
  parseSetupWrite,
  setupReport,
  shellQuote,
  writeCommand,
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
    assert.equal(res.detail, 'Relatório gerado ✓')
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
    assert.match(res.detail, /Alethe instalado ✓/)
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

describe('marcadores dos comandos em shell real', () => {
  test('checkCommand produz um marcador que um shell real consegue ecoar', () => {
    // O alethe pode ou não estar instalado na máquina que roda os testes — os dois casos são
    // válidos. O que NUNCA pode acontecer é o parse 'failed' que o bug do sublinhado causava.
    const out = execSync(`sh -c ${JSON.stringify(checkCommand())}`, { encoding: 'utf8' })
    assert.notEqual(parseSetupCheck(out), 'failed', `saída real: ${JSON.stringify(out)}`)
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
    const out = execSync(`sh -c ${JSON.stringify(folderCommand())}`, { encoding: 'utf8' })
    const parsed = parseSetupFolder(out)
    assert.ok(
      ['NO_ORCH', 'NO_RUNS', 'FOLDER='].some((marker) => out.includes(marker)),
      `saída real sem marcador reconhecido: ${JSON.stringify(out)}`
    )
    // O tipo vem do que o shell imprimiu, nunca de "não achei nada" genérico.
    assert.ok(['no-orch', 'no-runs', 'found'].includes(parsed.kind))
  })

  test('writeCommand num shell real produz WROTE_FAIL (o report não existe), nunca lixo', () => {
    const out = execSync(`sh -c ${JSON.stringify(writeCommand('/tmp/alethe-no-such-folder'))}`, {
      encoding: 'utf8'
    })
    assert.equal(parseSetupWrite(out), false)
    assert.ok(out.includes('WROTE_FAIL'), `saída real: ${JSON.stringify(out)}`)
  })
})
