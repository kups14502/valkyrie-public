import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Archive, ArchiveRestore, ArrowDownToLine, Ellipsis, FileText, Link2, Unlink, type LucideIcon } from 'lucide-react'
import { Press, Segmented, cx, toast } from '../kit/ui'
import { Icon, type IconName, type IconTone } from '../kit/icons'
import { ago, useLaunchTargets } from '../kit/data'
import { apiErrorText, fetchSessionList, openTermSession } from '../../lib/api'
import { copyText } from '../../lib/clipboard'
import {
  BASE_AREAS, LIMITS, MIXABLE_AREAS, PROJ_KEYS, archiveProj, createProj, fetchProjDoc, isClientArea, linkProjSession,
  projAreasQuery, updateProj, type Exposure, type LinkItem, type ProjectPatch, type ProjStatus,
} from '../../lib/projectsApi'
import { seedTerminal } from '../../lib/sessionLaunch'
import { v2TermPath } from '../../lib/term'
import { Markdown, safeHref } from '../../components/Markdown'
import './projectpage.css'

// The parts of AI > Projects that the classic project pages used to own, rebuilt
// for v2 (Claude.tsx wires them into the project list and the project detail):
//
// - New project: a desk session on thor sets the project up (the classic
//   NewProjectAiSheet: openTermSession desk + prompt, backend lib/projectDesk.ts),
//   with "Set up by hand" as the fallback form (createProj).
// - Project settings: name, next action, summary, status (an archived project
//   is restored by picking Active or Paused), area, folder, exposure and the
//   two session switches, plus a two-tap Archive. Save sends only what changed,
//   so text a session rewrote meanwhile is not put back.
// - Link a session: the board's thor sessions that may join the project (a
//   client area takes only its own sessions; personal and server mix).
// - Notes: the project's markdown and links tabs, read here (edits stay on the
//   classic page, with files, activity and agents).
// - Session actions: the strip under a linked session (move here, stop, done, unlink).

type Vars = CSSProperties & Record<`--${string}`, string | number>
const iv = (i: number): Vars => ({ '--i': i })

const errText = (e: unknown) => apiErrorText(e, (e as Error | null)?.message || 'no reply')
const areaName = (a: string) => (a ? a[0].toUpperCase() + a.slice(1) : 'Other')
const finePointer = () => typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches

/** The phone terminal's first-frame grid; the page fits the real one once it connects. */
const grid = () => ({
  cols: Math.max(24, Math.floor(window.innerWidth / (12 * 0.6))),
  rows: Math.max(10, Math.floor((window.innerHeight - 120) / (12 * 1.32))),
})

// ---------- icons kit/icons.tsx does not carry ----------

const EXTRA = {
  archive: Archive,
  restore: ArchiveRestore,
  move: ArrowDownToLine,
  more: Ellipsis,
  note: FileText,
  link: Link2,
  unlink: Unlink,
} satisfies Record<string, LucideIcon>
export type PIconName = keyof typeof EXTRA

/** A line icon in the kit's look (tone classes, stroke by size) for the project actions. */
export function PIcon({ name, size = 14, tone = 'dim', className }: { name: PIconName; size?: number; tone?: IconTone; className?: string }) {
  const C = EXTRA[name]
  return <C size={size} strokeWidth={size <= 12 ? 1.8 : size <= 14 ? 1.6 : 1.4} className={cx('vl-icon', `vl-icon-${tone}`, className)} aria-hidden />
}

function SecHead({ icon, label, n, children }: { icon: ReactNode; label: string; n: ReactNode; children?: ReactNode }) {
  return (
    <header className="vc-ghead">
      <span className="vc-ghead-l">
        {icon}
        <span className="vc-ghead-t">{label}</span>
        <span className="vc-ghead-n">{n}</span>
      </span>
      {children}
    </header>
  )
}

function Err({ msg }: { msg: string | null }) {
  if (!msg) return null
  return <p className="vc-act-err" role="alert"><Icon name="alert" size={13} tone="acc2" />{msg}</p>
}

// ---------- shared form fields ----------

function AreaPlates({ value, onChange }: { value: string; onChange: (a: string) => void }) {
  const areas = useQuery(projAreasQuery).data ?? BASE_AREAS
  const list = areas.includes(value) ? areas : [...areas, value]
  return (
    <div className="vc-flabel">
      <span>Area</span>
      <div className="vp-choices" role="radiogroup" aria-label="Area">
        {list.map((a) => (
          <Press key={a} role="radio" aria-checked={a === value} data-on={a === value || undefined} className="vc-fplate" onPress={() => onChange(a)}>
            {areaName(a)}
          </Press>
        ))}
      </div>
    </div>
  )
}

/** thor's launch targets; a folder the list does not carry (or a list that did not load) stays as its key. */
function FolderSelect({ value, onChange }: { value: string; onChange: (key: string) => void }) {
  const targets = useLaunchTargets()
  const list = targets.data ?? []
  const known = list.some((t) => t.key === value)
  return (
    <label className="vc-flabel">
      <span>Folder on thor</span>
      <select className="vc-field vp-select" value={value} onChange={(e) => onChange(e.target.value)}>
        {!value && <option value="">{targets.data ? 'Pick a folder' : 'Reading folders'}</option>}
        {value && !known && <option value={value}>{list.length ? `${value} (not listed)` : value}</option>}
        {list.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
      </select>
      {targets.failed && !list.length && <small className="vp-hint" data-warn>thor did not list its folders: {targets.error?.message ?? 'no reply'}</small>}
    </label>
  )
}

function Toggle({ label, note, on, onChange }: { label: string; note: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="vp-toggle">
      <span className="vp-toggle-t"><b>{label}</b><small>{note}</small></span>
      <Press role="switch" aria-checked={on} aria-label={label} className="vc-fplate vp-switch" data-on={on || undefined} onPress={() => onChange(!on)}>
        {on ? 'On' : 'Off'}
      </Press>
    </div>
  )
}

// ---------- new project ----------

const PROMPT_MAX = 2000

// The id the backend derives from the name (projectsStore slug), so the hint
// shows what the URL becomes. A taken id gets a -2 there, which only the reply knows.
const projectSlug = (name: string): string =>
  name.normalize('NFKD').toLowerCase().replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '') || 'project'
// the one-liner goes through a Claude session into PowerShell, inside double quotes
const psSafe = (s: string) => s.replace(/["`$]/g, '').trim()

/**
 * The New project sheet's body. Claude sets the project up (his call: the UI is
 * driven by the AI, a form is the fallback): a desk session on thor finds the
 * folder, names the project, creates it and fills its page. The terminal opens
 * in the page and its way back is AI > Projects, where the project appears.
 */
export function NewProjectFlow({ area, onCreated, onLeave }: {
  /** the area filter: the hand form starts on it */
  area: string
  onCreated: (id: string) => void
  /** closes the sheet before the terminal opens */
  onLeave: () => void
}) {
  const [manual, setManual] = useState(false)
  return manual
    ? <ManualProject area={area} onCreated={onCreated} onBack={() => setManual(false)} />
    : <AiProject onLeave={onLeave} onManual={() => setManual(true)} />
}

function AiProject({ onLeave, onManual }: { onLeave: () => void; onManual: () => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  // a mouse gets the cursor at once; a phone keeps its keyboard down until a tap
  useEffect(() => { if (finePointer()) ref.current?.focus({ preventScroll: true }) }, [])

  const start = async () => {
    if (busy) return
    setBusy(true)
    setErr(null)
    try {
      const r = await openTermSession({ mode: 'new', desk: true, prompt: prompt.trim(), label: 'new project', ...grid() })
      seedTerminal(qc, r)
      onLeave()
      navigate(v2TermPath(r.name, '/projects'))
    } catch (e) {
      setErr(`Could not start the session: ${errText(e)}`)
      setBusy(false)
    }
  }

  return (
    <form className="vp-form vl-build-on" onSubmit={(e) => { e.preventDefault(); void start() }} data-no-swipe>
      <label className="vc-flabel vl-build" style={iv(1)}>
        <span>What is it</span>
        <textarea
          ref={ref}
          className="vc-field"
          rows={4}
          maxLength={PROMPT_MAX}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void start() } }}
          placeholder="A client, a folder, an idea. Leave it empty and Claude asks."
        />
      </label>
      <p className="vp-hint vl-build" style={iv(2)}>Claude finds the folder, names the project, creates it and fills its page. Its terminal opens here.</p>
      <Err msg={err} />
      <div className="vp-acts vl-build" style={iv(3)}>
        <Press className="vl-btn vp-main" data-busy={busy || undefined} disabled={busy} onPress={() => void start()}>
          <Icon name={busy ? 'refresh' : 'start'} size={15} tone="ink" className={busy ? 'vl-pulse' : undefined} />{busy ? 'Starting' : 'Start'}
        </Press>
        <Press className="vl-link" onPress={onManual}><Icon name="settings" size={13} tone="dim" />Set up by hand</Press>
      </div>
    </form>
  )
}

function ManualProject({ area, onCreated, onBack }: { area: string; onCreated: (id: string) => void; onBack: () => void }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [pick, setPick] = useState(area && area !== 'all' ? area : 'personal')
  const [targetKey, setTargetKey] = useState('')
  const [summary, setSummary] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (finePointer()) nameRef.current?.focus({ preventScroll: true }) }, [])

  const slug = projectSlug(name)
  const oneLiner = `powershell -NoProfile -File C:\\Thor\\tools\\session-board\\Add-LaunchTarget.ps1 -Key ${slug} -Label "${psSafe(name) || slug}" -Path "<folder>"`
  const ready = name.trim() !== '' && targetKey !== '' && !busy

  const create = async () => {
    if (!ready) return
    setBusy(true)
    setErr(null)
    try {
      const doc = await createProj({ name: name.trim(), area: pick, targetKey, summary: summary.trim() || undefined })
      qc.setQueryData(PROJ_KEYS.doc(doc.project.id), doc)
      toast(`Created ${doc.project.name}`)
      onCreated(doc.project.id)
    } catch (e) {
      setErr(`Could not create the project: ${errText(e)}`)
      setBusy(false)
    }
  }
  const copy = async () => {
    if (!(await copyText(oneLiner))) {
      toast('Could not copy it')
      return
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <form className="vp-form vl-build-on" onSubmit={(e) => { e.preventDefault(); void create() }} data-no-swipe>
      <label className="vc-flabel vl-build" style={iv(1)}>
        <span>Name</span>
        <input ref={nameRef} className="vc-field" value={name} maxLength={LIMITS.projectName} onChange={(e) => setName(e.target.value)} placeholder="What this project is" autoComplete="off" />
        {name.trim() && <small className="vp-hint vp-mono">id: {slug}</small>}
      </label>
      <div className="vl-build" style={iv(2)}><AreaPlates value={pick} onChange={setPick} /></div>
      <div className="vl-build" style={iv(3)}><FolderSelect value={targetKey} onChange={setTargetKey} /></div>
      <div className="vp-cmd vl-build" style={iv(4)}>
        <small className="vp-hint">Folder not listed? Ask any Claude session on thor to run:</small>
        <div className="vp-cmd-line">
          <code>{oneLiner}</code>
          <Press className="vc-sact vc-iact" data-copied={copied || undefined} aria-label="Copy the command" title="Copy the command" onPress={() => void copy()}>
            <Icon name={copied ? 'done' : 'copy'} size={14} tone={copied ? 'hot' : 'dim'} />
          </Press>
        </div>
      </div>
      <label className="vc-flabel vl-build" style={iv(5)}>
        <span>Summary (optional)</span>
        <textarea className="vc-field" rows={3} maxLength={LIMITS.summary} value={summary} onChange={(e) => setSummary(e.target.value)} />
      </label>
      <Err msg={err} />
      <div className="vp-acts vl-build" style={iv(6)}>
        <Press className="vl-btn vp-main" data-busy={busy || undefined} disabled={!ready} onPress={() => void create()}>
          <Icon name={busy ? 'refresh' : 'add'} size={15} tone="ink" className={busy ? 'vl-pulse' : undefined} />{busy ? 'Creating' : 'Create'}
        </Press>
        <Press className="vl-link" onPress={onBack}><Icon name="ai" size={13} tone="dim" />Let Claude set it up</Press>
      </div>
    </form>
  )
}

// ---------- project settings ----------

export type ProjMeta = { targetKey: string; exposure: Exposure; allowSnapshots: boolean; sessionEdits: boolean }
type SettingsProject = { id: string; name: string; nextAction: string; summary: string; status: string; area: string }

type Draft = {
  name: string; nextAction: string; summary: string; status: ProjStatus; area: string
  targetKey: string; exposure: Exposure; allowSnapshots: boolean; sessionEdits: boolean
}

const asStatus = (s: string): ProjStatus => (s === 'paused' || s === 'archived' ? s : 'active')

const EXPOSURE_NOTE: Record<Exposure, string> = {
  tailnet: 'Hidden from anything that reaches Valkyrie through Cloudflare.',
  anywhere: 'Visible wherever you are signed in, Cloudflare included.',
}

export function ProjectSettings({ p, meta, onClose, onSaved, onArchived }: {
  p: SettingsProject
  meta: ProjMeta
  onClose: () => void
  onSaved: () => void
  onArchived: () => void
}) {
  // frozen at open: Save sends only what changed here
  const [init] = useState<Draft>(() => ({
    name: p.name, nextAction: p.nextAction, summary: p.summary, status: asStatus(p.status), area: p.area,
    targetKey: meta.targetKey, exposure: meta.exposure, allowSnapshots: meta.allowSnapshots, sessionEdits: meta.sessionEdits,
  }))
  const [draft, setDraft] = useState<Draft>(init)
  const [saving, setSaving] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [armed, setArmed] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(t)
  }, [armed])
  const set = <K extends keyof Draft>(key: K, v: Draft[K]) => setDraft((d) => ({ ...d, [key]: v }))

  const patch: ProjectPatch = {}
  if (draft.name.trim() !== init.name) patch.name = draft.name.trim()
  if (draft.nextAction !== init.nextAction) patch.nextAction = draft.nextAction
  if (draft.summary !== init.summary) patch.summary = draft.summary
  // Active or Paused on an archived project restores it; nothing here archives by status
  if (draft.status !== init.status && draft.status !== 'archived') patch.status = draft.status
  if (draft.area !== init.area) patch.area = draft.area
  if (draft.targetKey !== init.targetKey) patch.targetKey = draft.targetKey
  if (draft.exposure !== init.exposure) patch.exposure = draft.exposure
  if (draft.allowSnapshots !== init.allowSnapshots) patch.allowSnapshots = draft.allowSnapshots
  if (draft.sessionEdits !== init.sessionEdits) patch.sessionEdits = draft.sessionEdits
  const dirty = Object.keys(patch).length > 0
  const can = dirty && draft.name.trim() !== '' && !saving && !archiving

  const save = () => {
    if (!can) return
    setSaving(true)
    setErr(null)
    updateProj(p.id, patch)
      .then(() => {
        onSaved()
        toast(init.status === 'archived' && patch.status ? `Restored ${draft.name.trim()}` : `Saved ${draft.name.trim()}`)
        onClose()
      })
      .catch((e: unknown) => {
        setErr(`Could not save: ${errText(e)}`)
        setSaving(false)
      })
  }
  const archive = () => {
    if (!armed) {
      setArmed(true)
      return
    }
    setArmed(false)
    setArchiving(true)
    setErr(null)
    archiveProj(p.id)
      .then(() => {
        toast(`Archived ${p.name}. Show archived brings it back.`, { ms: 5000 })
        onSaved()
        onArchived()
      })
      .catch((e: unknown) => {
        setErr(`Could not archive it: ${errText(e)}`)
        setArchiving(false)
      })
  }

  const statusOptions: { value: ProjStatus; label: string; icon: IconName | ReactNode }[] = [
    { value: 'active', label: 'Active', icon: 'working' },
    { value: 'paused', label: 'Paused', icon: 'idle' },
  ]
  if (init.status === 'archived') statusOptions.push({ value: 'archived', label: 'Archived', icon: <PIcon name="archive" tone={draft.status === 'archived' ? 'ink' : 'dim'} /> })

  return (
    <form className="vc-edit vp-settings vl-build-on" onSubmit={(e) => { e.preventDefault(); save() }} data-no-swipe>
      <label className="vc-flabel">
        <span>Name</span>
        <input className="vc-field" value={draft.name} maxLength={LIMITS.projectName} onChange={(e) => set('name', e.target.value)} autoComplete="off" />
      </label>
      <label className="vc-flabel">
        <span>Next action</span>
        <input className="vc-field" value={draft.nextAction} maxLength={LIMITS.nextAction} onChange={(e) => set('nextAction', e.target.value)} autoComplete="off" />
      </label>
      <label className="vc-flabel">
        <span>Summary</span>
        <textarea className="vc-field" value={draft.summary} maxLength={LIMITS.summary} rows={4} onChange={(e) => set('summary', e.target.value)} />
      </label>
      <div className="vc-flabel">
        <span>Status</span>
        <Segmented<ProjStatus>
          className="vc-edit-seg"
          options={statusOptions as { value: ProjStatus; label: string; icon: IconName }[]}
          value={draft.status}
          onChange={(v) => set('status', v)}
        />
        {init.status === 'archived' && <small className="vp-hint">Archived. Pick Active or Paused and save to restore it.</small>}
      </div>
      <AreaPlates value={draft.area} onChange={(a) => set('area', a)} />
      <FolderSelect value={draft.targetKey} onChange={(k) => set('targetKey', k)} />
      <div className="vc-flabel">
        <span>Exposure</span>
        <Segmented<Exposure>
          className="vc-edit-seg"
          options={[{ value: 'tailnet', label: 'Tailnet only', icon: 'service' }, { value: 'anywhere', label: 'Anywhere', icon: 'online' }]}
          value={draft.exposure}
          onChange={(v) => set('exposure', v)}
        />
        <small className="vp-hint">{EXPOSURE_NOTE[draft.exposure]}</small>
      </div>
      <div className="vp-toggles">
        <Toggle
          label="File contents"
          note={draft.allowSnapshots ? 'Pinned files can keep a copy of their contents here.' : 'Only paths and links are pinned. No contents are stored.'}
          on={draft.allowSnapshots}
          onChange={(v) => set('allowSnapshots', v)}
        />
        <Toggle
          label="Session edits"
          note={draft.sessionEdits ? 'Sessions can change this page.' : 'Sessions are blocked from changing this page.'}
          on={draft.sessionEdits}
          onChange={(v) => set('sessionEdits', v)}
        />
      </div>
      <div className="vc-edit-acts">
        <Press className="vl-btn vc-edit-save" disabled={!can} onPress={save}>
          <Icon name={saving ? 'refresh' : 'done'} size={15} tone="ink" className={saving ? 'vl-pulse' : undefined} />{saving ? 'Saving' : 'Save'}
        </Press>
        <Press className="vc-sact" disabled={saving || archiving} onPress={onClose}>Cancel</Press>
        {init.status !== 'archived' && (
          <Press
            className="vc-sact vp-archive"
            data-tone={armed ? 'acc2' : undefined}
            data-busy={archiving || undefined}
            disabled={saving || archiving}
            title={armed ? 'Tap again to archive it' : 'Take it off the list. Its page and history are kept.'}
            onPress={archive}
          >
            <PIcon name="archive" tone={armed ? 'acc2' : 'dim'} />{archiving ? 'Archiving' : armed ? 'Archive?' : 'Archive'}
          </Press>
        )}
      </div>
      <Err msg={err} />
    </form>
  )
}

// ---------- link an existing session ----------

const LINK_SHOWN = 30
// a client area never mixes with another or with anything else; server and
// personal do, and so does a session from a folder with no area
const MIXABLE = [...MIXABLE_AREAS, '']

export function LinkSessionPicker({ projectId, area, linked, inputRef, onClose, onLinked }: {
  projectId: string
  area: string
  linked: ReadonlySet<string>
  /** focused by the opening tap (the phone's keyboard comes up only inside it) */
  inputRef: RefObject<HTMLInputElement | null>
  onClose: () => void
  onLinked: () => void
}) {
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  // the board's own cache entry (the classic board and v2 search share it)
  const board = useQuery({ queryKey: ['sessionList'], queryFn: fetchSessionList, staleTime: 60_000, refetchInterval: false })
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const all = board.data?.installed ? board.data.sessions : []
    return all
      // thor only: the project page lists thor's rows, so a link from elsewhere would vanish
      .filter((s) => s.host === 'thor' && !linked.has(s.sessionId))
      .filter((s) => (isClientArea(area) ? s.area === area : MIXABLE.includes(s.area)))
      .filter((s) => !needle || `${s.title} ${s.project} ${s.cwd ?? ''}`.toLowerCase().includes(needle))
      .sort((a, b) => (b.lastActivityUtc ?? '').localeCompare(a.lastActivityUtc ?? ''))
      .slice(0, LINK_SHOWN)
  }, [board.data, linked, q, area])

  const link = (id: string, title: string) => {
    if (busy) return
    setBusy(id)
    setErr(null)
    linkProjSession(projectId, id)
      .then(() => {
        toast(`Linked "${title}"`)
        onLinked()
        onClose()
      })
      .catch((e: unknown) => setErr(`Could not link "${title}": ${errText(e)}`))
      .finally(() => setBusy(null))
  }

  return (
    <div className="vp-link" data-no-swipe>
      <div className="vc-search vp-link-search">
        <Icon name="search" size={15} tone={q ? 'fg' : 'dim'} className="vc-search-icon" />
        <input
          ref={inputRef}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
          placeholder="Search sessions to link"
          aria-label="Search sessions to link"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <Press className="vc-search-x" aria-label="Close" title="Close" onPress={onClose}><Icon name="stop" size={15} tone="dim" /></Press>
      </div>
      <Err msg={err} />
      {board.isLoading ? (
        <p className="vc-pd-none">Reading the board</p>
      ) : board.isError || (board.data && !board.data.installed) ? (
        <p className="vc-pd-none">The session board did not answer</p>
      ) : rows.length === 0 ? (
        <p className="vc-pd-none">{q ? 'No session matches' : `No unlinked ${areaName(area)} sessions on thor`}</p>
      ) : (
        <div className="vc-rows vp-link-rows">
          {rows.map((s) => {
            const last = s.lastActivityUtc ? Date.parse(s.lastActivityUtc) : 0
            const title = s.title || s.sessionId.slice(0, 8)
            return (
              <Press
                key={s.sessionId}
                className="vp-link-row"
                data-busy={busy === s.sessionId || undefined}
                disabled={busy !== null}
                title="Link it to this project"
                onPress={() => link(s.sessionId, title)}
              >
                <PIcon name="link" size={14} tone={busy === s.sessionId ? 'fg' : 'dim'} className={busy === s.sessionId ? 'vl-pulse' : undefined} />
                <span className="vc-row-main">
                  <span className="vc-row-title">{title}</span>
                  <span className="vc-row-sub">
                    <span>{[s.project, s.area && !isClientArea(area) ? areaName(s.area) : '', last ? `${ago(last)} ago` : '', s.live ? 'running' : '', s.done ? 'done' : ''].filter(Boolean).join(' · ')}</span>
                  </span>
                </span>
              </Press>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---------- session actions ----------

/** The strip under a linked session: move here, stop, done or undo, and a two-tap unlink. */
export function SessionActions({ canMove, canStop, canDone, done, busy, onMove, onStop, onDone, onUnlink }: {
  /** running in a window on thor, not in a pane here */
  canMove: boolean
  canStop: boolean
  /** the board knows it, so it can be marked done */
  canDone: boolean
  done: boolean
  busy: boolean
  onMove: () => void
  onStop: () => void
  onDone: () => void
  onUnlink: () => void
}) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(t)
  }, [armed])
  return (
    <div className="vp-sacts" data-no-swipe>
      {canMove && (
        <Press className="vc-sact" data-main disabled={busy} title="Stop it in its window on thor and pick the conversation up here" onPress={onMove}>
          <PIcon name="move" tone="fg" />Move here
        </Press>
      )}
      {canStop && (
        <Press className="vc-sact" disabled={busy} title="Stop it. The conversation stays resumable." onPress={onStop}>
          <Icon name="stop" size={14} tone="dim" />Stop
        </Press>
      )}
      {canDone && (
        <Press className="vc-sact" disabled={busy} title={done ? 'Put it back on the list' : 'Finished with it. Hides it.'} onPress={onDone}>
          <Icon name={done ? 'undo' : 'done'} size={14} tone="dim" />{done ? 'Undo done' : 'Done'}
        </Press>
      )}
      <Press
        className="vc-sact"
        data-tone={armed ? 'acc2' : undefined}
        disabled={busy}
        title={armed ? 'Tap again to take it off this project' : 'Take it off this project. The session itself is untouched.'}
        onPress={() => {
          if (!armed) {
            setArmed(true)
            return
          }
          setArmed(false)
          onUnlink()
        }}
      >
        <PIcon name="unlink" tone={armed ? 'acc2' : 'dim'} />{armed ? 'Unlink?' : 'Unlink'}
      </Press>
    </div>
  )
}

// ---------- notes: the markdown and links tabs, read-only ----------

export type NoteTab = { id: string; kind: 'markdown' | 'links'; title: string; n: number }

/** One row per notes or links tab; a tap opens it in place. The full doc is read only once one opens. */
export function ProjectNotes({ projectId, tabs }: { projectId: string; tabs: NoteTab[] }) {
  const [open, setOpen] = useState<string | null>(null)
  // the classic page's own cache entry, never persisted (bodies run to 64 KB)
  const doc = useQuery({ queryKey: PROJ_KEYS.doc(projectId), queryFn: () => fetchProjDoc(projectId), enabled: open !== null, staleTime: 5_000 })
  if (!tabs.length) return null
  const tab = open ? doc.data?.tabs.find((t) => t.id === open) : undefined
  return (
    <section className="vc-pd-sec">
      <SecHead icon={<PIcon name="note" />} label="Notes" n={tabs.length} />
      <div className="vc-rows">
        {tabs.map((t) => {
          const on = open === t.id
          return (
            <div key={t.id} className="vp-note" data-open={on || undefined}>
              <Press className="vp-note-row" aria-expanded={on} onPress={() => setOpen((o) => (o === t.id ? null : t.id))}>
                <PIcon name={t.kind === 'links' ? 'link' : 'note'} size={14} tone={on ? 'fg' : 'dim'} />
                <span className="vp-note-t">{t.title}</span>
                {t.kind === 'links' && <small>{t.n}</small>}
                <Icon name="go" size={14} tone="dim" className="vp-note-caret" />
              </Press>
              {on && (
                <div className="vp-note-body">
                  {!tab ? (
                    <p className="vc-pd-none">{doc.isError ? `Could not read it: ${errText(doc.error)}` : 'Loading'}</p>
                  ) : tab.kind === 'markdown' ? (
                    tab.body.trim() ? <Markdown className="vp-md">{tab.body}</Markdown> : <p className="vc-pd-none">Empty</p>
                  ) : (
                    <LinkList items={tab.items as LinkItem[]} />
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function LinkList({ items }: { items: LinkItem[] }) {
  if (!items.length) return <p className="vc-pd-none">No links</p>
  return (
    <ul className="vp-links">
      {items.map((l) => {
        const href = safeHref(l.url)
        return (
          <li key={l.id}>
            {href ? <a href={href} target="_blank" rel="noopener noreferrer">{l.label || l.url}</a> : <span>{l.label || l.url}</span>}
            <small>{l.url}</small>
          </li>
        )
      })}
    </ul>
  )
}
