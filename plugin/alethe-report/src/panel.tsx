// No build step: Orca strips the types and compiles the JSX when the panel loads.
import {
  atom,
  Button,
  EmptyState,
  Heading,
  plugin,
  read,
  Row,
  set,
  Stack,
  Text,
  update
} from 'orca'
import type { ReportList } from './reports'

/** What the empty and error states show, worded exactly as the spec words it. */
const INSTRUCTION = 'Rode `/alethe report html` no terminal do projeto'

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

/** The state drawn now; `loading` until the first answer arrives. */
const state = atom<PanelState>({ kind: 'loading' })
/** What the last "Abrir" press answered, inline feedback by report path. */
const notes = atom<Record<string, { text: string; tone: 'success' | 'danger' }>>({})

/** One list request end to end; `load` turns any failure into the error state. */
async function refresh(): Promise<void> {
  set(state, await load(() => plugin.request('list-reports')))
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
  const allNotes = read(notes)
  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading level={2}>Alethe Reports</Heading>
        <Button size="sm" variant="ghost" icon="refresh" onPress={reload}>
          Recarregar
        </Button>
      </Row>
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
    </Stack>
  )
}
