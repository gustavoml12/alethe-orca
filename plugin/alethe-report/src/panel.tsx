// No build step: Orca strips the types and compiles the JSX when the panel loads.
import {
  atom,
  Button,
  EmptyState,
  Heading,
  Input,
  plugin,
  read,
  Row,
  set,
  Stack,
  Text,
  update
} from 'orca'
import type { IssueItem, IssueList, ReportList, SetupResult, StartResult } from './reports'

/** What the empty and error states show: the new flow's first step, never a shell command. */
const INSTRUCTION = 'Sem relatórios ainda — escreva a tarefa acima e clique em 🚀 Orquestrar tarefa.'

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

/** The state drawn now; `loading` until the first answer arrives. */
const state = atom<PanelState>({ kind: 'loading' })
/** The "Issues abertas" section's state; `issues` empty until the first answer arrives. */
const issuesState = atom<IssuesState>({ issues: [] })
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
/** One issue-row 🚀 answer, keyed by the issue it belongs to; `null` when none. */
const issueNote = atom<{ number: number; text: string; tone: 'success' | 'danger' } | null>(null)
/** Whether an issue dispatch is in flight, so one click cannot start a second. */
const issueBusy = atom(false)

/** One list request end to end; `load` turns any failure into the error state. */
async function refresh(): Promise<void> {
  // Both lists, in parallel: a failure in one lands as data and never blocks the other.
  const [reports, issues] = await Promise.all([
    load(() => plugin.request('list-reports')),
    loadIssues(() => plugin.request('list-issues'))
  ])
  set(state, reports)
  set(issuesState, issues)
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
 * Pure: one `start-task` answer, with the request function injected so the seam tests without a
 * host (same shape as `load` and `runSetup`). A rejected request becomes `failed` data — the
 * frame never sees an exception.
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
 * The "🚀 Orquestrar tarefa" press: one click that opens the live agent terminal with the
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
 * One issue row's "🚀" press: `start-issue` for THAT row, with the same atom discipline as
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
      let text = 'Relatório gerado e aberto ✓'
      let tone: 'success' | 'danger' = 'success'
      try {
        const open = await plugin.request('open-report', { path: result.path })
        if (!open.opened) {
          text = `Relatório gerado ✓ — ${open.error ?? 'não foi possível abrir'}`
          tone = 'danger'
        }
      } catch (err) {
        text = `Relatório gerado ✓ — ${String(err)}`
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
  const allNotes = read(notes)
  const note = read(setupNote)
  const busy = read(setupBusy)
  const task = read(taskText)
  const starting = read(startBusy)
  const dispatchNote = read(startNote)
  const rowNote = read(issueNote)
  const issueStarting = read(issueBusy)
  /** The one-click setup button; hidden while loading, drawn where a stale or absent list needs it. Secondary to the dispatch button below. */
  const prepareButton = (size?: 'sm') => (
    <Button
      size={size ?? 'md'}
      variant="outline"
      disabled={busy}
      onPress={prepare}
    >
      ⚙️ Preparar e gerar relatório
    </Button>
  )
  /** The task field + dispatch button: the first step without friction (empty state only — a
   *  ready state already has its report, so `Recarregar` suffices there). */
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
        disabled={starting || task.trim() === ''}
        onPress={start}
      >
        🚀 Orquestrar tarefa
      </Button>
    </Row>
  )
  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading level={2}>Alethe Reports</Heading>
        <Row gap="sm" align="center">
          {current.kind === 'ready' && prepareButton('sm')}
          <Button size="sm" variant="ghost" icon="refresh" onPress={reload}>
            Recarregar
          </Button>
        </Row>
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
          {current.kind === 'empty' && dispatchNote && (
            <Text size="sm" tone={dispatchNote.tone}>
              {dispatchNote.text}
            </Text>
          )}
          {current.kind === 'empty' && dispatchRow}
          {prepareButton()}
          <EmptyState title="Nenhum relatório" description={current.instruction} icon="file-text" />
        </Stack>
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
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={issueStarting}
                      onPress={() => startFromIssue(issue)}
                    >
                      🚀
                    </Button>
                  </Row>
                )
              })}
            </Stack>
          )}
        </Stack>
      )}
    </Stack>
  )
}
