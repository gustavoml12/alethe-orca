// No build step: Orca strips the types and compiles the JSX when the panel loads.
import {
  atom,
  Button,
  Callout,
  EmptyState,
  Heading,
  IconButton,
  Input,
  List,
  ListItem,
  plugin,
  read,
  Row,
  set,
  Stack,
  Text,
  update
} from 'orca'
import type {
  AssessItem,
  AssessResult,
  IssueItem,
  IssueList,
  ReportList,
  SetupResult,
  StartResult,
  WaveList
} from './reports'

/** What the empty and error states show: the new flow's first step, never a shell command. */
const INSTRUCTION = 'Sem relatórios ainda — escreva a tarefa acima e clique em Orquestrar tarefa.'

/** The panel's states: what one `list-reports` answer (or its failure) becomes. */
export type PanelState =
  | { kind: 'loading' }
  | { kind: 'ready'; reports: Array<{ path: string }> }
  | { kind: 'empty'; instruction: string }
  | { kind: 'error'; message: string; instruction: string }

/**
 * Pure: maps one `list-reports` answer to the state the panel draws, with the request function
 * injected so the logic tests without a host. A rejected request or the worker's own `error`
 * field lands here as data — the frame never sees an exception (plan Review Focus 4).
 */
export async function load(req: () => Promise<ReportList>): Promise<PanelState> {
  try {
    const answer = await req()
    if (answer.reports.length === 0) {
      return answer.error
        ? { kind: 'error', message: answer.error, instruction: INSTRUCTION }
        : { kind: 'empty', instruction: INSTRUCTION }
    }
    return { kind: 'ready', reports: answer.reports }
  } catch (err) {
    return { kind: 'error', message: String(err), instruction: INSTRUCTION }
  }
}

/** What the "Issues abertas" section draws: the rows found, or why there are none. */
export type IssuesState = { issues: IssueItem[]; error?: string }

/**
 * Pure: maps one `list-issues` answer to the section's state, with the request function
 * injected (same shape as `load`). A rejected request or the worker's own `error` field lands
 * here as data — a broken issues list never takes the panel down with it.
 */
export async function loadIssues(req: () => Promise<IssueList>): Promise<IssuesState> {
  try {
    const answer = await req()
    return answer.error ? { issues: answer.issues ?? [], error: answer.error } : { issues: answer.issues ?? [] }
  } catch (err) {
    return { issues: [], error: String(err) }
  }
}

/**
 * Pure: maps one `list-waves` answer to the section's state, with the request function
 * injected (same shape as `load` and `loadIssues`). A rejected request — or the worker's own
 * `error` — lands here as data: an unreadable proposal is a small note, never a broken frame.
 */
export async function loadWaves(req: () => Promise<WaveList>): Promise<WaveList> {
  try {
    const answer = await req()
    return { waves: answer?.waves ?? [], error: answer?.error }
  } catch (err) {
    return { waves: [], error: String(err) }
  }
}

/** What the "Avaliação" section draws: the items of the last `assess`, or nothing yet. */
export type AssessmentState = { ok: boolean; items: AssessItem[] } | null

/** The state drawn now; `loading` until the first answer arrives. */
const state = atom<PanelState>({ kind: 'loading' })
/** The "Issues abertas" section's state; `issues` empty until the first answer arrives. */
const issuesState = atom<IssuesState>({ issues: [] })
/** The "Proposta de waves" section's state; empty until the first answer arrives. */
const wavesState = atom<WaveList>({ waves: [] })
/** The last "Avaliar projeto" answer; `null` until the first press. */
const assessmentState = atom<AssessmentState>(null)
/** Whether an assessment is in flight, so one click cannot start a second. */
const assessBusy = atom(false)
/** What the last "Propor waves" press answered, inline under the assessment. */
const proposeNote = atom<{ text: string; tone: 'success' | 'danger' } | null>(null)
/** Whether a proposal dispatch is in flight, so one click cannot start a second. */
const proposeBusy = atom(false)
/** What the last "Executar wave" press answered, inline under the proposal. */
const execNote = atom<{ text: string; tone: 'success' | 'danger' } | null>(null)
/** Whether a wave dispatch is in flight, so one click cannot start a second. */
const execBusy = atom(false)
/** What the last "Abrir" press answered, inline feedback by report path. */
const notes = atom<Record<string, { text: string; tone: 'success' | 'danger' }>>({})
/** One "Preparar e gerar" answer, inline above the list (or the empty state); `null` when none. */
const setupNote = atom<{ text: string; tone: 'success' | 'danger' | 'accent' } | null>(null)
/** Whether a setup run is in flight, so one click cannot start a second. */
const setupBusy = atom(false)
/** What the "Qual tarefa?" field holds; the text `start-task` receives. */
const taskText = atom('')
/** One "Orquestrar tarefa" answer, inline above the field; `null` when none. */
const startNote = atom<{ text: string; tone: 'success' | 'danger' } | null>(null)
/** Whether an agent dispatch is in flight, so one click cannot start a second. */
const startBusy = atom(false)
/** One issue-row dispatch answer, keyed by the issue it belongs to; `null` when none. */
const issueNote = atom<{ number: number; text: string; tone: 'success' | 'danger' } | null>(null)
/** Whether an issue dispatch is in flight, so one click cannot start a second. */
const issueBusy = atom(false)

/** The note a started proposal shows: the leader takes minutes, so there is no polling. */
const PROPOSING_NOTE =
  'Proposta sendo gerada pelo leader alethe — clique em Recarregar em alguns minutos.'

/** How each assessment state is drawn: tone and icon of the Callout carrying the item. */
const CALLOUT_STYLE: Record<
  AssessItem['state'],
  { tone: 'success' | 'warning' | 'danger'; icon: 'check' | 'warning' | 'error' }
> = {
  ok: { tone: 'success', icon: 'check' },
  warn: { tone: 'warning', icon: 'warning' },
  fail: { tone: 'danger', icon: 'error' }
}

/** One list request end to end; `load` turns any failure into the error state. */
async function refresh(): Promise<void> {
  // All three lists, in parallel: a failure in one lands as data and never blocks the others.
  const [reports, issues, waves] = await Promise.all([
    load(() => plugin.request('list-reports')),
    loadIssues(() => plugin.request('list-issues')),
    loadWaves(() => plugin.request('list-waves'))
  ])
  set(state, reports)
  set(issuesState, issues)
  set(wavesState, waves)
}

/**
 * Pure: one `setup-report` answer, with the request function injected so the seam tests without
 * a host (same shape as `load`). A rejected request becomes `failed` data — the frame never sees
 * an exception.
 */
export async function runSetup(req: () => Promise<SetupResult>): Promise<SetupResult> {
  try {
    return await req()
  } catch (err) {
    return { status: 'failed', installed: false, detail: String(err) }
  }
}

/**
 * Pure: one `start-task` answer, with the request function injected (same shape as `load` and
 * `runSetup`). A rejected request becomes `failed` data — the frame never sees an exception.
 */
export async function runStart(req: () => Promise<StartResult>): Promise<StartResult> {
  try {
    return await req()
  } catch (err) {
    return { status: 'failed', detail: String(err) }
  }
}

/**
 * Pure: one `start-issue` answer, with the request function injected (same shape as
 * `runStart`). A rejected request becomes `failed` data — the frame never sees an exception.
 */
export async function runStartIssue(req: () => Promise<StartResult>): Promise<StartResult> {
  try {
    return await req()
  } catch (err) {
    return { status: 'failed', detail: String(err) }
  }
}

/**
 * Pure: one `assess` answer, with the request function injected (same shape as `load`). A
 * rejected request becomes one `fail` item — the frame never sees an exception, and the
 * section still draws what went wrong.
 */
export async function runAssess(req: () => Promise<AssessResult>): Promise<AssessResult> {
  try {
    return await req()
  } catch (err) {
    return { ok: false, items: [{ label: 'avaliação', state: 'fail', detail: String(err) }] }
  }
}

/**
 * Pure: one `propose-waves` answer, with the request function injected (same shape as
 * `runStart`). A rejected request becomes `failed` data — the frame never sees an exception.
 */
export async function runPropose(req: () => Promise<StartResult>): Promise<StartResult> {
  try {
    return await req()
  } catch (err) {
    return { status: 'failed', detail: String(err) }
  }
}

/**
 * Pure: one `execute-wave` answer, with the request function injected (same shape as
 * `runStart`). A rejected request becomes `failed` data — the frame never sees an exception.
 */
export async function runExecuteWave(req: () => Promise<StartResult>): Promise<StartResult> {
  try {
    return await req()
  } catch (err) {
    return { status: 'failed', detail: String(err) }
  }
}

/**
 * The "Orquestrar tarefa" press: one click that opens the live agent terminal with the
 * alethe kickoff, so the person never has to know that `/alethe` is an agent command rather
 * than a shell one. `started` clears the field (the task now belongs to the terminal); every
 * outcome lands as an inline note — never a thrown exception — and the note is reset on the
 * next click, the same discipline as `prepare`.
 */
async function start(): Promise<void> {
  if (read(startBusy)) return
  set(startBusy, true)
  set(startNote, null)
  try {
    const result = await runStart(() => plugin.request('start-task', { task: read(taskText) }))
    set(startNote, {
      text: result.detail,
      tone: result.status === 'started' ? 'success' : 'danger'
    })
    if (result.status === 'started') set(taskText, '')
  } finally {
    set(startBusy, false)
  }
}

/**
 * One issue row's dispatch press: `start-issue` for THAT row, with the same atom discipline as
 * `start` (busy guard, note reset on the next click). Every outcome lands as an inline note
 * under the row — never a thrown exception — and the manual field below stays as the fallback.
 */
async function startFromIssue(issue: IssueItem): Promise<void> {
  if (read(issueBusy)) return
  set(issueBusy, true)
  set(issueNote, null)
  try {
    const result = await runStartIssue(() =>
      plugin.request('start-issue', { number: issue.number, title: issue.title, url: issue.url })
    )
    set(issueNote, {
      number: issue.number,
      text: result.detail,
      tone: result.status === 'started' ? 'success' : 'danger'
    })
  } finally {
    set(issueBusy, false)
  }
}

/** The "Avaliar projeto" press: one zero-token `assess`; the items land as Callouts. */
async function runAssessment(): Promise<void> {
  if (read(assessBusy)) return
  set(assessBusy, true)
  try {
    const result = await runAssess(() => plugin.request('assess'))
    set(assessmentState, { ok: result.ok, items: result.items ?? [] })
  } finally {
    set(assessBusy, false)
  }
}

/**
 * The "Propor waves" press (shown only after a ready assessment): ONE dispatch of the alethe
 * leader, which saves the proposal without executing anything. The leader runs for minutes,
 * so the note tells the person to hit Recarregar later — no polling, ever.
 */
async function proposeWavesAction(): Promise<void> {
  if (read(proposeBusy)) return
  set(proposeBusy, true)
  set(proposeNote, null)
  try {
    const result = await runPropose(() => plugin.request('propose-waves'))
    set(
      proposeNote,
      result.status === 'started'
        ? { text: PROPOSING_NOTE, tone: 'success' }
        : { text: result.detail, tone: 'danger' }
    )
  } finally {
    set(proposeBusy, false)
  }
}

/** One wave's play press: `execute-wave` for THAT approved wave, note under the proposal. */
async function executeWaveAction(wave: number): Promise<void> {
  if (read(execBusy)) return
  set(execBusy, true)
  set(execNote, null)
  try {
    const result = await runExecuteWave(() => plugin.request('execute-wave', { wave }))
    set(execNote, { text: result.detail, tone: result.status === 'started' ? 'success' : 'danger' })
  } finally {
    set(execBusy, false)
  }
}

/**
 * The "Preparar e gerar relatório" press: one click that installs alethe if missing and writes
 * report.html. A `generated` answer is followed by `open-report` (the panel's own way of showing
 * it, one click ends with the report open) and a list refresh; every outcome lands as an inline
 * note — never a thrown exception.
 */
async function prepare(): Promise<void> {
  if (read(setupBusy)) return
  set(setupBusy, true)
  set(setupNote, null)
  try {
    const result = await runSetup(() => plugin.request('setup-report'))
    if (result.status === 'generated' && result.path) {
      let text = 'Relatório gerado e aberto'
      let tone: 'success' | 'danger' = 'success'
      try {
        const open = await plugin.request('open-report', { path: result.path })
        if (!open.opened) {
          text = `Relatório gerado — ${open.error ?? 'não foi possível abrir'}`
          tone = 'danger'
        }
      } catch (err) {
        text = `Relatório gerado — ${String(err)}`
        tone = 'danger'
      }
      set(setupNote, { text, tone })
    } else if (result.status === 'no-runs') {
      set(setupNote, { text: result.detail, tone: 'accent' })
    } else {
      set(setupNote, { text: result.detail, tone: 'danger' })
    }
    await refresh()
  } finally {
    set(setupBusy, false)
  }
}

/** The "Recarregar" press: show loading at once, then whatever the worker answers. */
async function reload(): Promise<void> {
  set(state, { kind: 'loading' })
  await refresh()
}

/** The per-row "Abrir" press: inline success or error feedback, never a thrown exception. */
async function open(path: string): Promise<void> {
  let note: { text: string; tone: 'success' | 'danger' }
  try {
    const answer = await plugin.request('open-report', { path })
    note = answer.opened
      ? {
          text: answer.via === 'editor-tab' ? 'Aberto na aba do editor' : 'Aberto na aba do browser',
          tone: 'success'
        }
      : { text: answer.error ?? 'Não foi possível abrir o relatório', tone: 'danger' }
  } catch (err) {
    note = { text: String(err), tone: 'danger' }
  }
  update(notes, (all) => ({ ...all, [path]: note }))
}

/** Runs once before the first render; the first list request starts here. */
export function setup(): void {
  void refresh()
}

/** The row's name: the folder right above the file plus the file (`wave-2/report.html`). */
function displayName(path: string): string {
  const at = path.lastIndexOf('/')
  return at === -1 ? path : path.slice(path.lastIndexOf('/', at - 1) + 1)
}

/** The folder chain above the row's name (`/o1`), for context under a long path. */
function contextOf(path: string): string {
  const at = path.lastIndexOf('/')
  if (at <= 0) return ''
  const nameStart = path.lastIndexOf('/', at - 1) + 1
  return nameStart > 1 ? path.slice(0, nameStart - 1) : ''
}

export default function Panel() {
  const current = read(state)
  const issueList = read(issuesState)
  const waveList = read(wavesState)
  const assessment = read(assessmentState)
  const assessing = read(assessBusy)
  const proposing = read(proposeBusy)
  const proposalNote = read(proposeNote)
  const executing = read(execBusy)
  const executionNote = read(execNote)
  const allNotes = read(notes)
  const note = read(setupNote)
  const busy = read(setupBusy)
  const task = read(taskText)
  const starting = read(startBusy)
  const dispatchNote = read(startNote)
  const rowNote = read(issueNote)
  const issueStarting = read(issueBusy)
  /** The one-click setup button: the LAST control of the panel, secondary to the dispatch one. */
  const prepareButton = (
    <Button variant="outline" icon="settings" disabled={busy} onPress={prepare}>
      Preparar e gerar relatório
    </Button>
  )
  /** The task field + dispatch button: the first step without friction, always available. */
  const dispatchRow = (
    <Row gap="sm" align="end">
      <Input
        label="Qual tarefa?"
        placeholder="ex.: mover os endpoints de billing para v2"
        value={task}
        disabled={starting}
        onChange={(value) => set(taskText, value)}
      />
      <Button
        variant="solid"
        icon="rocket"
        disabled={starting || task.trim() === ''}
        onPress={start}
      >
        Orquestrar tarefa
      </Button>
    </Row>
  )
  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading level={2}>Alethe Reports</Heading>
        <Button size="sm" variant="ghost" icon="refresh" onPress={reload}>
          Recarregar
        </Button>
      </Row>
      {note && (
        <Text size="sm" tone={note.tone}>
          {note.text}
        </Text>
      )}
      {current.kind === 'loading' && <Text muted>Carregando relatórios…</Text>}
      {current.kind === 'ready' && (
        <Stack gap="sm">
          {current.reports.map((report) => {
            const note = allNotes[report.path]
            const context = contextOf(report.path)
            return (
              <Row key={report.path} justify="between" align="start" gap="sm">
                <Stack gap="none" align="start">
                  <Text weight="medium" truncate>
                    {displayName(report.path)}
                  </Text>
                  {context !== '' && (
                    <Text muted size="xs" truncate>
                      {context}
                    </Text>
                  )}
                  {note && (
                    <Text size="xs" tone={note.tone}>
                      {note.text}
                    </Text>
                  )}
                </Stack>
                <Button size="sm" variant="outline" onPress={() => open(report.path)}>
                  Abrir
                </Button>
              </Row>
            )
          })}
        </Stack>
      )}
      {(current.kind === 'empty' || current.kind === 'error') && (
        <Stack gap="sm">
          {current.kind === 'error' && (
            <Text tone="danger" size="sm">
              {current.message}
            </Text>
          )}
          <EmptyState title="Nenhum relatório" description={current.instruction} icon="file-text" />
        </Stack>
      )}
      {/* Avaliação: um clique zero-token; os itens viram Callouts, e um ambiente pronto
          libera o botão que despacha o leader para propor as waves. */}
      <Stack gap="sm">
        <Heading level={3}>Avaliação</Heading>
        <Row gap="sm" wrap>
          <Button
            size="sm"
            variant="outline"
            icon="search"
            disabled={assessing || proposing}
            onPress={runAssessment}
          >
            Avaliar projeto
          </Button>
          {assessment?.ok && (
            <Button size="sm" variant="solid" icon="zap" disabled={proposing} onPress={proposeWavesAction}>
              Propor waves
            </Button>
          )}
        </Row>
        {assessment && (
          <Stack gap="sm">
            {assessment.items.map((item) => (
              <Callout
                key={item.label}
                tone={CALLOUT_STYLE[item.state].tone}
                icon={CALLOUT_STYLE[item.state].icon}
                title={item.label}
              >
                <Text size="sm">{item.detail}</Text>
              </Callout>
            ))}
          </Stack>
        )}
        {proposalNote && (
          <Text size="sm" tone={proposalNote.tone}>
            {proposalNote.text}
          </Text>
        )}
      </Stack>
      {/* Proposta de waves: some quando não há proposta (sem ruído), e vira uma nota pequena
          quando ela não pôde ser lida — a lista de relatórios segue funcionando. */}
      {waveList.waves.length > 0 && (
        <Stack gap="sm">
          <Heading level={3}>Proposta de waves</Heading>
          <List>
            {waveList.waves.map((wave) => {
              const meta = [wave.estimate, wave.playbook]
                .filter((value): value is string => typeof value === 'string' && value !== '')
                .join(' · ')
              return (
                <ListItem
                  key={wave.id}
                  title={`Wave ${wave.id} · ${wave.title} · issues ${wave.issues.join(', ')}`}
                  description={meta === '' ? undefined : meta}
                  icon="layers"
                >
                  <IconButton
                    icon="play"
                    label={`Executar wave ${wave.id}`}
                    disabled={executing}
                    onPress={() => executeWaveAction(wave.id)}
                  />
                </ListItem>
              )
            })}
          </List>
          {executionNote && (
            <Text size="sm" tone={executionNote.tone}>
              {executionNote.text}
            </Text>
          )}
        </Stack>
      )}
      {waveList.error && (
        <Text size="xs" muted>
          {waveList.error}
        </Text>
      )}
      {/* Issues abertas: a seção existe só com issues; a falha do fetch vira uma nota
          pequena e não destrutiva na mesma área — o painel segue funcionando. */}
      {(issueList.issues.length > 0 || issueList.error) && (
        <Stack gap="sm">
          {issueList.error && (
            <Text size="xs" muted>
              Issues: {issueList.error}
            </Text>
          )}
          {issueList.issues.length > 0 && (
            <Stack gap="sm">
              <Heading level={3}>Issues abertas</Heading>
              {issueList.issues.map((issue) => {
                const feedback = rowNote?.number === issue.number ? rowNote : null
                return (
                  <Row key={issue.number} justify="between" align="start" gap="sm">
                    <Stack gap="none" align="start">
                      <Text weight="medium" truncate>
                        {`#${issue.number} ${issue.title}${
                          issue.labels.length > 0 ? ` [${issue.labels.join(', ')}]` : ''
                        }`}
                      </Text>
                      {feedback && (
                        <Text size="xs" tone={feedback.tone}>
                          {feedback.text}
                        </Text>
                      )}
                    </Stack>
                    <IconButton
                      icon="rocket"
                      label={`Orquestrar issue #${issue.number}`}
                      disabled={issueStarting}
                      onPress={() => startFromIssue(issue)}
                    />
                  </Row>
                )
              })}
            </Stack>
          )}
        </Stack>
      )}
      {/* Tarefa manual: o caminho sem atrito, sempre disponível (fallback das seções acima). */}
      {dispatchNote && (
        <Text size="sm" tone={dispatchNote.tone}>
          {dispatchNote.text}
        </Text>
      )}
      {dispatchRow}
      {prepareButton}
    </Stack>
  )
}
