import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, Plus, RotateCw } from 'lucide-react'
import { apiErrorText, fetchLaunchTargets } from '../../lib/api'
import { copyText } from '../../lib/clipboard'
import { BASE_AREAS, LIMITS, PROJ_KEYS, createProj, projAreasQuery, type Area } from '../../lib/projectsApi'
import { Dropdown } from '../Dropdown'
import { BTN_ACCENT, BTN_GHOST, BTN_TEXT, FIELD, LABEL, Sheet } from './Sheet'

// The id the backend will derive from the name (projectsStore slug): the same
// steps in the same order, so what the sheet shows is what the URL becomes. A
// taken id gets a -2 suffix there, which only the reply can know.
const projectSlug = (name: string): string =>
  name.normalize('NFKD').toLowerCase().replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '') || 'project'

// The one-liner goes through a Claude session into PowerShell, inside double
// quotes, where $ and the backtick expand and a quote ends the string.
const psSafe = (s: string) => s.replace(/["`$]/g, '').trim()

// Shared with ProjectEditSheet, which reads the same list.
export function NoFolders({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="mt-1.5 flex items-center gap-2 text-[11px] text-[var(--color-warning)]">
      <span className="min-w-0 flex-1">thor listed no folders. Its launcher can be busy or down.</span>
      <button type="button" onClick={onRetry} className={`-my-2 shrink-0 ${BTN_TEXT}`}>
        <RotateCw size={11} /> retry
      </button>
    </div>
  )
}

export function NewProjectSheet({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [area, setArea] = useState<Area>('personal')
  const [targetKey, setTargetKey] = useState('')
  const [summary, setSummary] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  // Shape and key shared with SessionBoard's NewSession, which caches an array
  // here: anything else under this key crashes whichever page reads it second.
  const areas = useQuery(projAreasQuery).data ?? BASE_AREAS
  const targets = useQuery({
    queryKey: ['launchTargets', 'thor'],
    queryFn: () => fetchLaunchTargets('thor'),
    staleTime: 60_000,
    refetchInterval: false,
  })

  const slug = projectSlug(name)
  const oneLiner = `powershell -NoProfile -File C:\\Thor\\tools\\session-board\\Add-LaunchTarget.ps1 -Key ${slug} -Label "${psSafe(name) || slug}" -Path "<folder>"`

  const create = useMutation({
    mutationFn: () => createProj({ name: name.trim(), area, targetKey, summary: summary.trim() || undefined }),
    onSuccess: (doc) => {
      qc.setQueryData(PROJ_KEYS.doc(doc.project.id), doc)
      void qc.invalidateQueries({ queryKey: PROJ_KEYS.list })
      navigate(`/projects/${doc.project.id}`)
    },
    onError: (e: unknown) => setError(apiErrorText(e, 'could not create the project')),
  })

  const copy = async () => {
    if (await copyText(oneLiner)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  const folderOptions = [
    { value: '', label: targets.isLoading ? 'reading folders…' : 'pick a folder' },
    ...(targets.data ?? []).map((t) => ({ value: t.key, label: t.exists ? t.label : `${t.label} [missing]` })),
  ]
  const ready = name.trim() !== '' && targetKey !== '' && !create.isPending
  // fetchLaunchTargets answers [] for any failure, and a project cannot be made
  // without a folder, so an empty list after a read means thor did not answer.
  const noFolders = targets.isSuccess && !targets.isFetching && (targets.data ?? []).length === 0

  return (
    <Sheet
      title="new project"
      onClose={onClose}
      footer={(
        <>
          <button type="button" disabled={!ready} onClick={() => create.mutate()} className={BTN_ACCENT}>
            <Plus size={13} /> {create.isPending ? 'creating' : 'create'}
          </button>
          <button type="button" onClick={onClose} className={BTN_GHOST}>cancel</button>
        </>
      )}
    >
      <form
        className="space-y-4"
        onSubmit={(e) => { e.preventDefault(); if (ready) create.mutate() }}
      >
        <label className="block">
          <span className={LABEL}>name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={LIMITS.projectName}
            autoFocus
            placeholder="what this project is"
            className={FIELD}
          />
          {name.trim() && <span className="mt-1 block font-mono text-[11px] text-[var(--color-text-faint)]">id: {slug}</span>}
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <span className={LABEL}>area</span>
            <Dropdown value={area} options={areas.map((a) => ({ value: a, label: a }))} onChange={(v) => setArea(v as Area)} />
          </div>
          <div>
            <span className={LABEL}>folder on thor</span>
            <Dropdown value={targetKey} options={folderOptions} onChange={setTargetKey} />
            {noFolders && <NoFolders onRetry={() => void targets.refetch()} />}
          </div>
        </div>

        {/* Adding a target does nothing for a launcher that is not answering. */}
        {!noFolders && (
          <div className="space-y-1.5 text-[11px] text-[var(--color-text-dim)]">
            <div>Folder not listed? Ask any Claude session on thor:</div>
            <div className="flex min-w-0 items-start gap-2 border border-[var(--color-border)] px-2.5 py-2">
              <code className="min-w-0 flex-1 break-all font-mono text-[11px] text-[var(--color-text)]">{oneLiner}</code>
              <button
                type="button"
                onClick={() => void copy()}
                aria-label="Copy the command"
                className="-m-1 shrink-0 p-1 text-[var(--color-text-faint)] transition hover:text-[var(--color-accent)]"
              >
                {copied ? <Check size={13} /> : <Copy size={13} />}
              </button>
            </div>
          </div>
        )}

        <label className="block">
          <span className={LABEL}>summary (optional)</span>
          <textarea
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            maxLength={LIMITS.summary}
            rows={3}
            className={`${FIELD} resize-y`}
          />
        </label>

        {error && <div className="text-xs text-[var(--color-danger)]">{error}</div>}
      </form>
    </Sheet>
  )
}
