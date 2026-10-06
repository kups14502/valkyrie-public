import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, Check } from 'lucide-react'
import { apiErrorText, fetchLaunchTargets } from '../../lib/api'
import {
  BASE_AREAS, LIMITS, PROJ_KEYS, archiveProj, projAreasQuery, updateProj,
  type Area, type Exposure, type Project, type ProjectPatch, type ProjStatus,
} from '../../lib/projectsApi'
import { Dropdown } from '../Dropdown'
import { NoFolders } from './NewProjectSheet'
import { BTN_ACCENT, BTN_GHOST, FIELD, LABEL, Sheet } from './Sheet'

type Draft = {
  name: string; summary: string; nextAction: string; status: ProjStatus; area: Area
  targetKey: string; exposure: Exposure; allowSnapshots: boolean; sessionEdits: boolean
}

const EXPOSURE_NOTE: Record<Exposure, string> = {
  tailnet: 'Hidden from anything that reaches Valkyrie through Cloudflare.',
  anywhere: 'Visible wherever you are signed in, Cloudflare included.',
}

function Toggle({ label, note, on, onChange }: { label: string; note: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-xs text-[var(--color-text)]">{label}</div>
        <div className="text-[11px] text-[var(--color-text-faint)]">{note}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={() => onChange(!on)}
        className={`min-h-9 shrink-0 border px-3 text-[10px] uppercase tracking-[0.18em] transition ${
          on
            ? 'border-[var(--color-accent)]/60 text-[var(--color-accent)]'
            : 'border-[var(--color-border)] text-[var(--color-text-faint)]'
        }`}
      >
        {on ? 'on' : 'off'}
      </button>
    </div>
  )
}

export function ProjectEditSheet({ project, onClose }: { project: Project; onClose: () => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  // Frozen at open. Save sends only what was changed here, so a summary or
  // next action a session rewrote while the sheet sat open is not put back.
  const [initial] = useState<Draft>(() => ({
    name: project.name, summary: project.summary, nextAction: project.nextAction, status: project.status,
    area: project.area, targetKey: project.targetKey, exposure: project.exposure,
    allowSnapshots: project.allowSnapshots, sessionEdits: project.sessionEdits,
  }))
  const [draft, setDraft] = useState<Draft>(initial)
  const [error, setError] = useState('')
  const [archiveArmed, setArchiveArmed] = useState(false)
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }))

  useEffect(() => {
    if (!archiveArmed) return
    const t = setTimeout(() => setArchiveArmed(false), 4000)
    return () => clearTimeout(t)
  }, [archiveArmed])

  const areas = useQuery(projAreasQuery).data ?? BASE_AREAS
  const targets = useQuery({
    queryKey: ['launchTargets', 'thor'],
    queryFn: () => fetchLaunchTargets('thor'),
    staleTime: 60_000,
    refetchInterval: false,
  })

  const patch = (): ProjectPatch => {
    const out: ProjectPatch = {}
    if (draft.name.trim() !== initial.name) out.name = draft.name.trim()
    if (draft.summary !== initial.summary) out.summary = draft.summary
    if (draft.nextAction !== initial.nextAction) out.nextAction = draft.nextAction
    if (draft.status !== initial.status && draft.status !== 'archived') out.status = draft.status
    if (draft.area !== initial.area) out.area = draft.area
    if (draft.targetKey !== initial.targetKey) out.targetKey = draft.targetKey
    if (draft.exposure !== initial.exposure) out.exposure = draft.exposure
    if (draft.allowSnapshots !== initial.allowSnapshots) out.allowSnapshots = draft.allowSnapshots
    if (draft.sessionEdits !== initial.sessionEdits) out.sessionEdits = draft.sessionEdits
    return out
  }
  const dirty = Object.keys(patch()).length > 0

  const save = useMutation({
    mutationFn: () => updateProj(project.id, patch()),
    onSuccess: (doc) => {
      qc.setQueryData(PROJ_KEYS.doc(project.id), doc)
      void qc.invalidateQueries({ queryKey: PROJ_KEYS.events(project.id) })
      void qc.invalidateQueries({ queryKey: PROJ_KEYS.list })
      onClose()
    },
    onError: (e: unknown) => setError(apiErrorText(e, 'could not save the project')),
  })

  const archive = useMutation({
    mutationFn: () => archiveProj(project.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: PROJ_KEYS.list })
      navigate('/projects')
    },
    onError: (e: unknown) => setError(apiErrorText(e, 'could not archive the project')),
  })

  const loaded = targets.data ?? []
  const folderOptions = loaded.map((t) => ({ value: t.key, label: t.exists ? t.label : `${t.label} [missing]` }))
  if (!loaded.some((t) => t.key === draft.targetKey)) {
    // An empty list is a failed read, not proof the folder is gone.
    folderOptions.unshift({ value: draft.targetKey, label: loaded.length > 0 ? `${draft.targetKey} [missing]` : draft.targetKey })
  }
  const statusOptions = [
    { value: 'active', label: 'active' },
    { value: 'paused', label: 'paused' },
    ...(initial.status === 'archived' ? [{ value: 'archived', label: 'archived' }] : []),
  ]

  return (
    <Sheet
      title="edit project"
      onClose={onClose}
      footer={(
        <>
          <button
            type="button"
            disabled={!dirty || !draft.name.trim() || save.isPending}
            onClick={() => save.mutate()}
            className={BTN_ACCENT}
          >
            <Check size={13} /> {save.isPending ? 'saving' : 'save'}
          </button>
          <button type="button" onClick={onClose} className={BTN_GHOST}>cancel</button>
          {project.status !== 'archived' && (
            <button
              type="button"
              disabled={archive.isPending}
              onClick={() => (archiveArmed ? archive.mutate() : setArchiveArmed(true))}
              title={archiveArmed ? 'Click again to archive' : 'Take it off the list. Its page and history are kept.'}
              className={`ml-auto inline-flex min-h-10 items-center gap-2 border px-3 text-[10px] uppercase tracking-[0.16em] transition disabled:opacity-40 ${
                archiveArmed
                  ? 'border-[var(--color-danger)] bg-[var(--color-danger)]/10 text-[var(--color-danger)]'
                  : 'border-[var(--color-border)] text-[var(--color-text-faint)] hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]'
              }`}
            >
              <Archive size={12} /> {archive.isPending ? 'archiving' : archiveArmed ? 'archive?' : 'archive'}
            </button>
          )}
        </>
      )}
    >
      <form
        className="space-y-4"
        onSubmit={(e) => { e.preventDefault(); if (dirty && draft.name.trim()) save.mutate() }}
      >
        <label className="block">
          <span className={LABEL}>name</span>
          <input value={draft.name} onChange={(e) => set('name', e.target.value)} maxLength={LIMITS.projectName} className={FIELD} />
        </label>
        <label className="block">
          <span className={LABEL}>next action</span>
          <input value={draft.nextAction} onChange={(e) => set('nextAction', e.target.value)} maxLength={LIMITS.nextAction} className={FIELD} />
        </label>
        <label className="block">
          <span className={LABEL}>summary</span>
          <textarea
            value={draft.summary}
            onChange={(e) => set('summary', e.target.value)}
            maxLength={LIMITS.summary}
            rows={3}
            className={`${FIELD} resize-y`}
          />
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <span className={LABEL}>status</span>
            <Dropdown value={draft.status} options={statusOptions} onChange={(v) => set('status', v as ProjStatus)} />
          </div>
          <div>
            <span className={LABEL}>area</span>
            <Dropdown value={draft.area} options={areas.map((a) => ({ value: a, label: a }))} onChange={(v) => set('area', v as Area)} />
          </div>
          <div>
            <span className={LABEL}>folder on thor</span>
            <Dropdown value={draft.targetKey} options={folderOptions} onChange={(v) => set('targetKey', v)} />
            {targets.isSuccess && !targets.isFetching && loaded.length === 0 && (
              <NoFolders onRetry={() => void targets.refetch()} />
            )}
          </div>
          <div>
            <span className={LABEL}>exposure</span>
            <Dropdown
              value={draft.exposure}
              options={[{ value: 'tailnet', label: 'tailnet only' }, { value: 'anywhere', label: 'anywhere' }]}
              onChange={(v) => set('exposure', v as Exposure)}
            />
          </div>
        </div>
        <p className="text-[11px] text-[var(--color-text-faint)]">{EXPOSURE_NOTE[draft.exposure]}</p>

        <div className="space-y-3 border-t border-[var(--color-border)] pt-4">
          <Toggle
            label="file contents"
            note={draft.allowSnapshots ? 'Pinned files can keep a copy of their contents here.' : 'Only paths and links are pinned. No contents are stored.'}
            on={draft.allowSnapshots}
            onChange={(v) => set('allowSnapshots', v)}
          />
          <Toggle
            label="session edits"
            note={draft.sessionEdits ? 'Sessions can change this page.' : 'Sessions are blocked from changing this page.'}
            on={draft.sessionEdits}
            onChange={(v) => set('sessionEdits', v)}
          />
        </div>

        {error && <div className="text-xs text-[var(--color-danger)]">{error}</div>}
      </form>
    </Sheet>
  )
}
