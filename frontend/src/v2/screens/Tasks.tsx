import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Button, Press, toast } from '../kit/ui'
import { Icon } from '../kit/icons'
import { useTick } from '../kit/data'
import { apiErrorText } from '../../lib/api'
import { addDayKey, dueLabel, dueState, nyDayKey, type DueState } from '../../lib/taskDue'
import {
  addTask, fetchTasks, removeTask, restoreTask, taskKey, updateTask,
  type Task, type TaskPatch, type TasksPage as TasksData, type TaskView,
} from '../../lib/tasksApi'
import { PageFrame } from './Calendar'
import './tasks.css'

// Tasks in v2 (/m/tasks): every open task in one list, whichever project it
// belongs to (backend/src/lib/tasksStore.ts). A project's tasks are its
// checklist items, so ticking one here ticks it on the project page too; a task
// can also belong to no project, under an area. Open groups by when it is due
// (Overdue, Today, Next 7 days, Later, No date), New York time throughout. A
// row's box ticks it (with Undo); the row opens to its due date and time, Open
// project, or Remove for a task outside a project. The line at the top adds a
// task: text, where it goes (a project, or no project in an area) and a date.

const VIEWS: { id: TaskView; label: string }[] = [
  { id: 'open', label: 'Open' },
  { id: 'done', label: 'Done' },
]

type Group = { id: DueState | 'none'; label: string; tasks: Task[] }

const GROUPS: { id: Group['id']; label: string }[] = [
  { id: 'overdue', label: 'Overdue' },
  { id: 'today', label: 'Today' },
  { id: 'soon', label: 'Next 7 days' },
  { id: 'later', label: 'Later' },
  { id: 'none', label: 'No date' },
]

const DEST_KEY = 'v2.tasks.dest'
const NY_DONE = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' })

function storedDest(): string {
  try { return localStorage.getItem(DEST_KEY) || 'a:personal' } catch { return 'a:personal' }
}

export default function TasksPage() {
  return (
    <PageFrame id="tasks" title="Tasks" icon="tasks" scroll>
      <TasksScreen />
    </PageFrame>
  )
}

function TasksScreen() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const now = useTick(60_000)
  const view: TaskView = params.get('view') === 'done' ? 'done' : 'open'
  const area = params.get('area')
  const [openKey, setOpenKey] = useState<string | null>(null)

  const key = ['tasks', view] as const
  const q = useQuery({
    queryKey: key,
    queryFn: () => fetchTasks(view),
    refetchInterval: () => (document.hidden ? false : 30_000),
    refetchOnWindowFocus: true,
  })
  const all = useMemo(() => q.data?.tasks ?? [], [q.data])
  const areas = useMemo(() => q.data?.areas ?? [], [q.data])
  const projects = useMemo(() => q.data?.projects ?? [], [q.data])

  const setParam = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(params)
    for (const [k, v] of Object.entries(next)) {
      if (v == null) p.delete(k)
      else p.set(k, v)
    }
    setParams(p, { replace: true, state: window.history.state?.usr })
  }

  // every change refreshes both views and the dashboard's glance
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['tasks'] })
    void qc.invalidateQueries({ queryKey: ['v2', 'tasks-open'] })
  }
  const patchList = (fn: (t: Task) => Task | null) => {
    qc.setQueryData<TasksData>(key, (d) => d && { ...d, tasks: d.tasks.map(fn).filter((x): x is Task => x !== null) })
  }
  const same = (a: Task, b: Task) => taskKey(a.ref) === taskKey(b.ref)
  const fail = (what: string) => (e: unknown) => toast(`${what}: ${apiErrorText(e, 'Valkyrie did not answer')}`, { ms: 4000 })

  const tick = useMutation({
    mutationFn: ({ t, done }: { t: Task; done: boolean }) => updateTask(t.ref, { done }),
    onMutate: ({ t }) => patchList((x) => (same(x, t) ? null : x)),
    onSuccess: (_r, { t, done }) => {
      toast(done ? `Done: ${t.text}` : `Reopened: ${t.text}`, { action: { label: 'Undo', run: () => tick.mutate({ t: { ...t, done }, done: !done }) } })
    },
    onError: fail('Could not change it'),
    onSettled: refresh,
  })

  const patch = useMutation({
    mutationFn: ({ t, p }: { t: Task; p: TaskPatch }) => updateTask(t.ref, p),
    onMutate: ({ t, p }) => patchList((x) => (same(x, t) ? { ...x, ...p } as Task : x)),
    onError: fail('Could not change it'),
    onSettled: refresh,
  })

  const remove = useMutation({
    mutationFn: (t: Task) => removeTask(t.ref),
    onMutate: (t) => patchList((x) => (same(x, t) ? null : x)),
    onSuccess: (_r, t) => {
      const id = t.ref.kind === 'loose' ? t.ref.id : null
      toast(`Removed: ${t.text}`, id ? { action: { label: 'Undo', run: () => { restoreTask(id).then(refresh, fail('Could not bring it back')) } } } : undefined)
    },
    onError: fail('Could not remove it'),
    onSettled: refresh,
  })

  const shown = useMemo(() => all.filter((t) => !area || t.area === area), [all, area])
  const groups: Group[] = useMemo(() => {
    if (view === 'done') return [{ id: 'none', label: '', tasks: shown }]
    const by = new Map<Group['id'], Task[]>()
    for (const t of shown) {
      const g = t.due ? dueState(t.due, now) : 'none'
      by.set(g, [...(by.get(g) ?? []), t])
    }
    return GROUPS.map((g) => ({ ...g, tasks: by.get(g.id) ?? [] })).filter((g) => g.tasks.length > 0)
  }, [shown, view, now])
  const areaChips = useMemo(() => areas.filter((a) => all.some((t) => t.area === a) || a === area), [areas, all, area])
  const status = q.isError && !q.data ? `Tasks are not answering: ${apiErrorText(q.error, 'no reply from Valkyrie')}` : !q.data ? 'Reading tasks' : null

  return (
    <div className="tk">
      <div className="tk-bar">
        <nav className="tk-tabs" aria-label="Task views">
          {VIEWS.map((v) => (
            <Press
              key={v.id}
              className="tk-tab"
              data-on={v.id === view || undefined}
              aria-current={v.id === view ? 'page' : undefined}
              onPress={() => { setOpenKey(null); setParam({ view: v.id === 'open' ? null : v.id }) }}
            >
              {v.label}
              {v.id === 'open' && view === 'open' && q.data && <span className="tk-tab-n">{all.length}</span>}
            </Press>
          ))}
        </nav>
      </div>

      {view === 'open' && q.data && <AddLine areas={areas} projects={projects} onAdded={refresh} />}

      {areaChips.length > 1 && (
        <div className="tk-chips" role="group" aria-label="Areas">
          <Press className="tk-chip" data-on={!area || undefined} onPress={() => setParam({ area: null })}>All</Press>
          {areaChips.map((a) => (
            <Press key={a} className="tk-chip" data-on={a === area || undefined} onPress={() => setParam({ area: a === area ? null : a })}>
              {a}
              {view === 'open' && <span className="tk-chip-n">{all.filter((t) => t.area === a).length}</span>}
            </Press>
          ))}
        </div>
      )}

      {status && <p className="tk-quiet">{status}</p>}
      {q.data && shown.length === 0 && (
        <p className="tk-quiet">{view === 'done' ? 'Nothing done in the last 30 days.' : area ? `Nothing open in ${area}.` : 'Nothing to do.'}</p>
      )}

      {groups.map((g) => (
        <section key={g.id} className="tk-group" data-group={g.id}>
          {g.label && <h2 className="tk-ghead"><span>{g.label}</span><span className="tk-gn">{g.tasks.length}</span></h2>}
          <div className="tk-rows">
            {g.tasks.map((t) => {
              const k = taskKey(t.ref)
              const open = k === openKey
              const st = t.due ? dueState(t.due, now) : undefined
              return (
                <div key={k} className="tk-row" data-open={open || undefined} data-done={t.done || undefined}>
                  <div className="tk-line">
                    <Press
                      className="tk-box"
                      role="checkbox"
                      aria-checked={t.done}
                      aria-label={t.done ? `Reopen ${t.text}` : `Done: ${t.text}`}
                      onPress={() => tick.mutate({ t, done: !t.done })}
                    >
                      {t.done && <Icon name="done" size={11} tone="ink" />}
                    </Press>
                    <Press className="tk-main" aria-expanded={open} onPress={() => setOpenKey(open ? null : k)}>
                      <span className="tk-text">{t.text}</span>
                      <span className="tk-meta">
                        <span className="tk-from">{t.project?.name ?? t.area}</span>
                        {view === 'done' && t.doneAt
                          ? <span className="tk-due">Done {NY_DONE.format(Date.parse(t.doneAt))}</span>
                          : t.due && <span className="tk-due" data-state={st}>{dueLabel(t.due, now)}</span>}
                      </span>
                    </Press>
                  </div>
                  {open && (
                    <Detail
                      t={t}
                      onDue={(due) => patch.mutate({ t, p: { due } })}
                      onProject={() => navigate(`/m/ai/projects?p=${encodeURIComponent(t.project!.id)}`, { state: { v2Back: true } })}
                      onRemove={() => { setOpenKey(null); remove.mutate(t) }}
                    />
                  )}
                </div>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}

/** An open row: its due date and time (each saves on change), Open project, or Remove for a task outside projects. */
function Detail({ t, onDue, onProject, onRemove }: {
  t: Task
  onDue: (due: string | null) => void
  onProject: () => void
  onRemove: () => void
}) {
  const day = t.due?.slice(0, 10) ?? ''
  const time = t.due && t.due.length > 10 ? t.due.slice(11, 16) : ''
  const setDay = (d: string) => onDue(d ? (time ? `${d}T${time}` : d) : null)
  // a time with no date means today
  const setTime = (hm: string) => onDue(hm ? `${day || nyDayKey(Date.now())}T${hm}` : day || null)
  return (
    <div className="tk-detail">
      {!t.done && (
        <div className="tk-due-edit">
          <span className="tk-k">Due</span>
          <input type="date" className="tk-field" value={day} aria-label="Due date" onChange={(e) => setDay(e.target.value)} />
          <input type="time" className="tk-field" value={time} aria-label="Due time" onChange={(e) => setTime(e.target.value)} />
          {!day && (
            <span className="tk-quick">
              <Button kind="link" onPress={() => setDay(nyDayKey(Date.now()))}>Today</Button>
              <Button kind="link" onPress={() => setDay(addDayKey(nyDayKey(Date.now()), 1))}>Tomorrow</Button>
            </span>
          )}
          {day && <Button kind="link" onPress={() => onDue(null)}>Clear</Button>}
        </div>
      )}
      <div className="tk-acts">
        {t.project && <Button kind="line" icon="projects" onPress={onProject}>Open project</Button>}
        {t.ref.kind === 'loose' && <Button kind="link" onPress={onRemove}>Remove</Button>}
        <span className="tk-where">{t.project ? `${t.project.name}${t.list ? ` · ${t.list}` : ''}` : `No project · ${t.area}`}</span>
      </div>
    </div>
  )
}

/** The add line: the text, then where it goes and a date once there is text. Enter adds it. */
function AddLine({ areas, projects, onAdded }: {
  areas: string[]
  projects: TasksData['projects']
  onAdded: () => void
}) {
  const [draft, setDraft] = useState('')
  const [due, setDue] = useState('')
  const [dest, setDest] = useState(storedDest)
  const valid = dest.startsWith('p:') ? projects.some((p) => `p:${p.id}` === dest) : areas.some((a) => `a:${a}` === dest)
  const where = valid ? dest : 'a:personal'
  const add = useMutation({
    mutationFn: () => addTask({
      text: draft.trim(),
      due: due || null,
      ...(where.startsWith('p:') ? { projectId: where.slice(2) } : { area: where.slice(2) }),
    }),
    onSuccess: (t) => {
      setDraft('')
      setDue('')
      toast(`Added: ${t.text}`)
      onAdded()
    },
    onError: (e) => toast(`Could not add it: ${apiErrorText(e, 'Valkyrie did not answer')}`, { ms: 4000 }),
  })
  const pick = (v: string) => {
    setDest(v)
    try { localStorage.setItem(DEST_KEY, v) } catch { /* storage unavailable */ }
  }
  const can = draft.trim() !== '' && !add.isPending
  return (
    <form className="tk-add" data-typing={draft.trim() ? '' : undefined} onSubmit={(e) => { e.preventDefault(); if (can) add.mutate() }}>
      <div className="tk-add-line">
        <Icon name="add" size={14} tone={draft.trim() ? 'fg' : 'dim'} />
        <input
          className="tk-field tk-add-text"
          value={draft}
          maxLength={300}
          onChange={(e) => setDraft(e.target.value)}
          // a form with a date field and no submit button never submits on Enter by itself
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); if (can) add.mutate() } }}
          placeholder="Add a task"
          aria-label="New task"
          enterKeyHint="done"
          autoComplete="off"
        />
      </div>
      {draft.trim() !== '' && (
        <div className="tk-add-opts">
          <select className="tk-field tk-pick" value={where} aria-label="Where it goes" onChange={(e) => pick(e.target.value)}>
            {areas.map((a) => (
              <optgroup key={a} label={a}>
                <option value={`a:${a}`}>No project ({a})</option>
                {projects.filter((p) => p.area === a).map((p) => <option key={p.id} value={`p:${p.id}`}>{p.name}</option>)}
              </optgroup>
            ))}
          </select>
          <input type="date" className="tk-field tk-add-date" value={due} aria-label="Due date" onChange={(e) => setDue(e.target.value)} />
          <Press className="tk-addbtn" disabled={!can} onPress={() => { if (can) add.mutate() }}>{add.isPending ? 'Adding' : 'Add'}</Press>
        </div>
      )}
    </form>
  )
}
