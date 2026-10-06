import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Play, Plus, SquareTerminal, Trash2 } from 'lucide-react'
import { apiErrorText, fetchTermSessions } from '../../lib/api'
import { relIso } from '../../lib/term'
import {
  LIMITS, PROJ_KEYS, fetchProjAutomation, isChangedSince, removeProjAutomation, saveProjAutomation,
  type Automation, type AutomationKind, type AutomationSummary, type Model, type ProjectTabProps,
  type ProjectTerm, type Run, type RunStatus,
} from '../../lib/projectsApi'
import { Card } from '../Card'
import { Dropdown } from '../Dropdown'
import { Markdown } from '../Markdown'
import { ArmButton } from './TabTools'
import { BTN_ACCENT, BTN_GHOST, BTN_TEXT, FIELD, LABEL, Sheet } from './Sheet'

// Mirrors KEY_RE in backend/src/lib/projectTypes.ts.
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

const slug = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 32).replace(/-+$/, '')

const MODEL_OPTIONS = [
  { value: '', label: 'default' },
  { value: 'opus', label: 'opus' },
  { value: 'sonnet', label: 'sonnet' },
  { value: 'haiku', label: 'haiku' },
]

const TAG = 'inline-flex shrink-0 items-center border px-1.5 py-0.5 text-[9px] uppercase tracking-[0.14em]'
const RUN_TONE: Record<RunStatus, string> = {
  starting: 'border-[var(--color-border)] text-[var(--color-text-dim)]',
  running: 'border-[var(--color-accent)]/60 text-[var(--color-accent)]',
  done: 'border-[var(--color-success)]/60 text-[var(--color-success)]',
  failed: 'border-[var(--color-danger)]/60 text-[var(--color-danger)]',
  blocked: 'border-[var(--color-warning)]/60 text-[var(--color-warning)]',
}

// react-markdown with skipHtml drops HTML and comments from the rendered view,
// but Claude reads the file raw. The renderer also drops link and footnote
// definitions (`[//]: # (...)`, `[^x]: ...`) and link titles. A brief that
// carries any is opened raw, so nothing it says is hidden from the one screen
// meant to show all of it.
const HIDDEN_RE = /<[!?/a-zA-Z]|^ {0,3}\[[^\]]+\]:|\]\([^)]*\s["'(]/m

// A 409 from a save made against an older rev carries the brief as it is now.
const conflictAutomation = (e: unknown): Automation | null => {
  const r = (e as { response?: { status?: number; data?: { current?: Automation } } } | null)?.response
  return r?.status === 409 && r.data?.current ? r.data.current : null
}

const ago = (iso: string | null): string => {
  const r = relIso(iso)
  return !r ? '' : r === 'now' ? 'just now' : `${r} ago`
}

function AutomationRow({ projectId, a, onRun, onEdit }: {
  projectId: string
  a: AutomationSummary
  onRun: (a: AutomationSummary) => void
  onEdit: (a: AutomationSummary) => void
}) {
  const qc = useQueryClient()
  const [error, setError] = useState('')
  const remove = useMutation({
    mutationFn: () => removeProjAutomation(projectId, a.key),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: PROJ_KEYS.doc(projectId) })
      void qc.invalidateQueries({ queryKey: PROJ_KEYS.events(projectId) })
    },
    onError: (e: unknown) => setError(apiErrorText(e, 'could not remove it')),
  })

  return (
    <li className={`flex flex-wrap items-start gap-x-3 gap-y-1 py-2.5${remove.isPending ? ' opacity-40' : ''}`}>
      <div className="min-w-0 flex-1 basis-full sm:basis-auto">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm text-[var(--color-text)]">{a.name}</span>
          {a.model && <span className="shrink-0 text-[10px] text-[var(--color-text-faint)]">[{a.model}]</span>}
        </div>
        {a.description && <div className="mt-0.5 break-words text-[11px] text-[var(--color-text-dim)]">{a.description}</div>}
        {a.updatedBy.startsWith('session:') && (
          <div className="mt-0.5 text-[10px] text-[var(--color-warning)]">[edited by session]</div>
        )}
        {error && <div className="mt-1 text-[11px] text-[var(--color-danger)]">{error}</div>}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <button type="button" onClick={() => onRun(a)} title="Read the brief, then run it" className={BTN_TEXT}>
          <Play size={11} /> run
        </button>
        <button type="button" onClick={() => onEdit(a)} className={BTN_TEXT}>
          <Pencil size={11} /> edit
        </button>
        <ArmButton
          label="remove"
          icon={<Trash2 size={11} />}
          disabled={remove.isPending}
          title="Remove it. The activity tab can undo it."
          onConfirm={() => remove.mutate()}
        />
      </div>
    </li>
  )
}

// A brief a session wrote last opens raw whatever the pattern finds: markdown
// has more ways to hide text than one regex can list.
function Brief({ body, sessionEdited }: { body: string; sessionEdited: boolean }) {
  const hidden = HIDDEN_RE.test(body)
  const [raw, setRaw] = useState(hidden || sessionEdited)
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        {hidden ? (
          <span className="text-[11px] text-[var(--color-warning)]">Has HTML, comments or definitions the rendered view hides.</span>
        ) : <span />}
        <button type="button" onClick={() => setRaw((v) => !v)} className={BTN_TEXT}>
          {raw ? 'rendered' : 'raw'}
        </button>
      </div>
      {raw ? (
        <pre className="whitespace-pre-wrap break-words border border-[var(--color-border)] p-3 text-[12px] text-[var(--color-text)]">{body}</pre>
      ) : (
        <div className="border border-[var(--color-border)] p-3"><Markdown>{body}</Markdown></div>
      )}
    </div>
  )
}

// The full body, read before a single run. Sessions can write agents and
// workflows but never start them, so this sheet is the one place a planted
// brief gets caught.
function RunSheet({ projectId, a, term, onClose }: {
  projectId: string
  a: AutomationSummary
  term: ProjectTerm
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [changed, setChanged] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  const key = PROJ_KEYS.automation(projectId, a.key)
  const q = useQuery({
    queryKey: key,
    queryFn: () => fetchProjAutomation(projectId, a.key),
    staleTime: 0,
    refetchInterval: false,
  })

  const run = async () => {
    if (!q.data) return
    const shown = q.data
    setStarting(true)
    setError('')
    try {
      // A session can rewrite the brief while this sheet is open. The backend
      // composes the run from the rev on screen or answers 409, in the same
      // transaction, so a write landing mid-request cannot slip through.
      await term.start({ automation: a.key, automationRev: shown.rev })
      setChanged(false)
      void qc.invalidateQueries({ queryKey: PROJ_KEYS.doc(projectId) })
      onClose()
    } catch (e) {
      if (isChangedSince(e)) {
        setChanged(true)
        await q.refetch()
        return
      }
      setError(apiErrorText(e, 'could not start the run'))
    } finally {
      setStarting(false)
    }
  }

  return (
    <Sheet
      title={`run ${a.kind}: ${a.name}`}
      onClose={onClose}
      footer={(
        <>
          <button
            type="button"
            disabled={!q.data || starting || term.busy}
            onClick={() => void run()}
            className={BTN_ACCENT}
          >
            <Play size={12} /> {starting || term.busy ? 'starting' : 'run'}
          </button>
          <button type="button" onClick={onClose} className={BTN_GHOST}>cancel</button>
          <span className="text-[11px] text-[var(--color-text-faint)]">
            Starts a new Claude session on thor with this brief{q.data?.model ? ` on ${q.data.model}` : ''}.
          </span>
        </>
      )}
    >
      {changed && (
        <div className="mb-3 border border-[var(--color-warning)]/50 px-3 py-2 text-xs text-[var(--color-warning)]">
          The brief changed while it was open. Read the new text below before running it.
        </div>
      )}
      {error && <div className="mb-3 text-xs text-[var(--color-danger)]">{error}</div>}
      {q.data?.updatedBy.startsWith('session:') && (
        <div className="mb-3 text-[11px] text-[var(--color-warning)]">[edited by session {ago(q.data.updatedAt)}]</div>
      )}
      {q.data?.description && <div className="mb-3 text-xs text-[var(--color-text-dim)]">{q.data.description}</div>}
      {q.isLoading ? (
        <div className="text-xs text-[var(--color-text-dim)]">&gt; loading</div>
      ) : q.isError ? (
        <div className="text-xs text-[var(--color-danger)]">{apiErrorText(q.error, 'could not read the brief')}</div>
      ) : q.data ? (
        <Brief key={q.data.rev} body={q.data.body} sessionEdited={q.data.updatedBy.startsWith('session:')} />
      ) : null}
    </Sheet>
  )
}

function EditForm({ projectId, kind, existing, takenKeys, onClose }: {
  projectId: string
  kind: AutomationKind
  existing: Automation | null
  takenKeys: Set<string>
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [name, setName] = useState(existing?.name ?? '')
  const [key, setKey] = useState(existing?.key ?? '')
  const [keyTouched, setKeyTouched] = useState(false)
  const [description, setDescription] = useState(existing?.description ?? '')
  const [model, setModel] = useState<Model>(existing?.model ?? '')
  const [body, setBody] = useState(existing?.body ?? '')
  const [error, setError] = useState('')
  // Nothing refetches the brief while this form is open, and a session can
  // save the same key at any moment. The save carries the rev the form was
  // filled from (0: must not exist yet) and a newer one comes back as 409.
  const [conflict, setConflict] = useState<Automation | null>(null)

  const finalKey = existing ? existing.key : keyTouched ? key : slug(name)
  const keyProblem = existing
    ? ''
    : !finalKey ? '' : !KEY_RE.test(finalKey) ? 'lowercase letters, digits and dashes, 32 at most'
    : takenKeys.has(finalKey) ? 'that key is taken in this project' : ''
  const ready = name.trim() !== '' && body.trim() !== '' && finalKey !== '' && keyProblem === ''

  const save = useMutation({
    mutationFn: (baseRev: number) => saveProjAutomation(projectId, finalKey, {
      kind, name: name.trim(), description: description.trim(), body, model, baseRev,
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: PROJ_KEYS.doc(projectId) })
      void qc.invalidateQueries({ queryKey: PROJ_KEYS.events(projectId) })
      void qc.invalidateQueries({ queryKey: PROJ_KEYS.automation(projectId, finalKey) })
      onClose()
    },
    onError: (e: unknown) => {
      const current = conflictAutomation(e)
      if (current) { setConflict(current); setError(''); return }
      setError(apiErrorText(e, 'could not save it'))
    },
  })

  // An edit remounts on the newer rev through EditSheet's key. A new one has
  // nothing to remount into, so the session's version simply stays.
  const discard = (current: Automation) => {
    if (!existing) { onClose(); return }
    qc.setQueryData(PROJ_KEYS.automation(projectId, current.key), current)
  }

  return (
    <Sheet
      title={existing ? `edit ${kind}: ${existing.name}` : `new ${kind}`}
      onClose={onClose}
      footer={(
        <>
          <button
            type="button"
            disabled={!ready || save.isPending || conflict !== null}
            onClick={() => save.mutate(existing ? existing.rev : 0)}
            className={BTN_ACCENT}
          >
            {save.isPending ? 'saving' : 'save'}
          </button>
          <button type="button" onClick={onClose} className={BTN_GHOST}>cancel</button>
        </>
      )}
    >
      <div className="space-y-3">
        {conflict && (
          <div className="space-y-2 border border-[var(--color-warning)]/50 px-3 py-2 text-xs text-[var(--color-warning)]">
            <div>
              {existing ? 'changed while you were editing' : 'saved under this key while you were writing'}
              {conflict.updatedBy.startsWith('session:') ? ' (by a session)' : ''}. Your draft is still below.
            </div>
            <details>
              <summary className="cursor-pointer text-[11px] uppercase tracking-[0.14em]">the newer version</summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words border border-[var(--color-border)] p-2 text-[12px] text-[var(--color-text-dim)]">
                {conflict.body || '(empty)'}
              </pre>
            </details>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={save.isPending}
                onClick={() => { const rev = conflict.rev; setConflict(null); save.mutate(rev) }}
                className={BTN_ACCENT}
              >
                save mine anyway
              </button>
              <button type="button" disabled={save.isPending} onClick={() => discard(conflict)} className={BTN_GHOST}>
                discard mine
              </button>
            </div>
          </div>
        )}
        <label className="block">
          <span className={LABEL}>name</span>
          <input value={name} maxLength={LIMITS.automationName} onChange={(e) => setName(e.target.value)} className={FIELD} />
        </label>
        {existing ? (
          <div className="text-[11px] text-[var(--color-text-faint)]">key: <span className="font-mono">{existing.key}</span></div>
        ) : (
          <label className="block">
            <span className={LABEL}>key</span>
            <input
              value={finalKey}
              maxLength={32}
              onChange={(e) => { setKey(e.target.value.toLowerCase()); setKeyTouched(true) }}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className={`font-mono ${FIELD}`}
            />
            {keyProblem && <span className="mt-1 block text-[11px] text-[var(--color-warning)]">{keyProblem}</span>}
          </label>
        )}
        <label className="block">
          <span className={LABEL}>description</span>
          <input
            value={description}
            maxLength={LIMITS.automationDescription}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="optional"
            className={FIELD}
          />
        </label>
        <div>
          <span className={LABEL}>model</span>
          <Dropdown value={model} options={MODEL_OPTIONS} onChange={(v) => setModel(v as Model)} />
        </div>
        <label className="block">
          <span className={LABEL}>{kind === 'agent' ? 'brief' : 'steps'} (markdown)</span>
          <textarea
            value={body}
            maxLength={LIMITS.automationBody}
            onChange={(e) => setBody(e.target.value)}
            className={`min-h-[40dvh] resize-y ${FIELD}`}
          />
          <span className="mt-1 block text-right text-[10px] text-[var(--color-text-faint)]">
            {body.length} / {LIMITS.automationBody}
          </span>
        </label>
        {error && <div className="text-xs text-[var(--color-danger)]">{error}</div>}
      </div>
    </Sheet>
  )
}

// The list row carries only a preview, so editing loads the full body first and
// mounts the form once it is here, never with a half-filled box.
function EditSheet({ projectId, kind, editKey, takenKeys, onClose }: {
  projectId: string
  kind: AutomationKind
  editKey: string | null
  takenKeys: Set<string>
  onClose: () => void
}) {
  const q = useQuery({
    queryKey: PROJ_KEYS.automation(projectId, editKey ?? ''),
    queryFn: () => fetchProjAutomation(projectId, editKey ?? ''),
    enabled: editKey !== null,
    staleTime: 0,
    refetchInterval: false,
  })
  if (editKey === null) {
    return <EditForm projectId={projectId} kind={kind} existing={null} takenKeys={takenKeys} onClose={onClose} />
  }
  if (q.data) {
    return <EditForm key={q.data.rev} projectId={projectId} kind={kind} existing={q.data} takenKeys={takenKeys} onClose={onClose} />
  }
  return (
    <Sheet title={`edit ${kind}`} onClose={onClose}>
      {q.isError
        ? <div className="text-xs text-[var(--color-danger)]">{apiErrorText(q.error, 'could not load it')}</div>
        : <div className="text-xs text-[var(--color-text-dim)]">&gt; loading</div>}
    </Sheet>
  )
}

function RunRow({ run, alive, known, term }: { run: Run; alive: boolean; known: boolean; term: ProjectTerm }) {
  const orphaned = known && !alive && (run.status === 'starting' || run.status === 'running')
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2.5">
      <span className={`${TAG} ${RUN_TONE[run.status]}`}>{run.status}</span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm text-[var(--color-text)]">{run.name}</span>
          <span className="ml-auto shrink-0 text-[10px] text-[var(--color-text-faint)]">{ago(run.startedAt)}</span>
        </div>
        {run.summary && <div className="mt-0.5 line-clamp-2 break-words text-[11px] text-[var(--color-text-dim)]">{run.summary}</div>}
        {orphaned && <div className="mt-0.5 text-[10px] text-[var(--color-warning)]">[ended without a report]</div>}
      </div>
      {alive && run.tmuxName && (
        <button type="button" onClick={() => term.open(run.tmuxName ?? '')} className={`ml-auto ${BTN_TEXT}`}>
          <SquareTerminal size={11} /> open
        </button>
      )}
    </li>
  )
}

export function AutomationsTab({ projectId, doc, term }: ProjectTabProps) {
  const [running, setRunning] = useState<AutomationSummary | null>(null)
  const [editing, setEditing] = useState<{ kind: AutomationKind; key: string | null } | null>(null)

  // Shared with the page and the session board, which already poll it.
  const terms = useQuery({ queryKey: ['term', 'sessions'], queryFn: fetchTermSessions, refetchInterval: false })
  const livePanes = new Set((terms.data ?? []).filter((t) => !t.dead).map((t) => t.name))

  const agents = doc.automations.filter((a) => a.kind === 'agent')
  const workflows = doc.automations.filter((a) => a.kind === 'workflow')
  const runs = [...doc.runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  const takenKeys = new Set(doc.automations.map((a) => a.key))
  const full = doc.automations.length >= LIMITS.automationsPerProject

  const list = (kind: AutomationKind, rows: AutomationSummary[]) => (
    <Card
      title={kind === 'agent' ? 'agents' : 'workflows'}
      action={(
        <button
          type="button"
          disabled={full}
          onClick={() => setEditing({ kind, key: null })}
          title={full ? `A project holds ${LIMITS.automationsPerProject} at most` : undefined}
          className={BTN_TEXT}
        >
          <Plus size={11} /> new {kind}
        </button>
      )}
    >
      {rows.length === 0 ? (
        <div className="text-[11px] text-[var(--color-text-faint)]">
          {kind === 'agent'
            ? 'None yet. An agent is a saved role with its own brief.'
            : 'None yet. A workflow is a saved list of steps.'}
        </div>
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {rows.map((a) => (
            <AutomationRow
              key={a.id}
              projectId={projectId}
              a={a}
              onRun={setRunning}
              onEdit={(x) => setEditing({ kind: x.kind, key: x.key })}
            />
          ))}
        </ul>
      )}
    </Card>
  )

  return (
    <div className="space-y-6">
      {term.error && (
        <div className="border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 text-xs text-[var(--color-danger)]">{term.error}</div>
      )}
      {list('agent', agents)}
      {list('workflow', workflows)}
      <Card title="runs">
        {runs.length === 0 ? (
          <div className="text-[11px] text-[var(--color-text-faint)]">Nothing has run yet. A run is a normal Claude session you can open and stop.</div>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {runs.map((r) => (
              <RunRow
                key={r.id}
                run={r}
                alive={r.tmuxName !== null && livePanes.has(r.tmuxName)}
                known={terms.isSuccess}
                term={term}
              />
            ))}
          </ul>
        )}
      </Card>

      {running && <RunSheet projectId={projectId} a={running} term={term} onClose={() => setRunning(null)} />}
      {editing && (
        <EditSheet
          projectId={projectId}
          kind={editing.kind}
          editKey={editing.key}
          takenKeys={takenKeys}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}
