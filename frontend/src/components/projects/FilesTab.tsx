import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, Eye, File, FileText, Link as LinkIcon, Plus, Send, Trash2 } from 'lucide-react'
import { apiErrorText } from '../../lib/api'
import { copyText } from '../../lib/clipboard'
import { relIso } from '../../lib/term'
import {
  LIMITS, PROJ_KEYS, fetchProjFileContent, pinProjFile, unpinProjFile,
  type FileKind, type FileRef, type ProjectTabProps, type ProjectTerm,
} from '../../lib/projectsApi'
import { Dropdown } from '../Dropdown'
import { Markdown, safeHref } from '../Markdown'
import { ArmButton } from './TabTools'
import { BTN_ACCENT, BTN_GHOST, BTN_TEXT, FIELD, LABEL, Sheet } from './Sheet'

const ago = (iso: string | null): string => {
  const r = relIso(iso)
  return !r ? '' : r === 'now' ? 'just now' : `${r} ago`
}

const kb = (bytes: number | null): string => `${Math.max(1, Math.round((bytes ?? 0) / 1024))} KB`

const whereTo = (href: string): string => {
  if (href.startsWith('/')) return href
  try {
    return new URL(href).host || href
  } catch {
    return href
  }
}

// A path with a space is quoted so the shell in the pane reads it as one
// argument. The trailing space lets the next word be typed straight after it.
const forTerminal = (relPath: string): string => (relPath.includes(' ') ? `"${relPath}" ` : `${relPath} `)

// The narrow form for the files column beside the tabs: label and path on two
// lines, actions as icons that show on hover. The label itself does the most
// useful thing the file allows: view, open, or copy the path.
const ICON = 'inline-flex h-8 w-7 shrink-0 items-center justify-center text-[var(--color-text-faint)] transition hover:text-[var(--color-accent)] disabled:opacity-30'

export function CompactFileRow({ projectId, file, term, onView }: {
  projectId: string
  file: FileRef
  term: ProjectTerm
  onView: (f: FileRef) => void
}) {
  const qc = useQueryClient()
  const [copied, setCopied] = useState(false)
  const [armed, setArmed] = useState(false)
  const unpin = useMutation({
    mutationFn: () => unpinProjFile(projectId, file.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: PROJ_KEYS.doc(projectId) })
      void qc.invalidateQueries({ queryKey: PROJ_KEYS.events(projectId) })
    },
  })
  const href = file.kind === 'url' && file.url ? safeHref(file.url) : null
  const Icon = file.kind === 'doc' ? FileText : file.kind === 'url' ? LinkIcon : File
  const sub = file.kind === 'path' ? file.relPath ?? '' : file.kind === 'url' ? (href ? whereTo(href) : '[blocked link]') : 'doc'
  const viewable = (file.kind === 'doc' || file.kind === 'path') && file.hasContent

  const copy = async () => {
    if (!file.relPath) return
    if (await copyText(file.relPath)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }
  const primary = () => {
    if (viewable) onView(file)
    else if (href && !href.startsWith('/')) window.open(href, '_blank', 'noopener,noreferrer')
    else if (href) window.location.assign(href)
    else void copy()
  }

  return (
    <li className={`group flex items-start gap-2 py-1.5${unpin.isPending ? ' opacity-40' : ''}`}>
      <Icon size={13} className="mt-0.5 shrink-0 text-[var(--color-text-faint)]" />
      <button
        type="button"
        onClick={primary}
        title={[file.note, viewable ? 'View it' : href ? 'Open it' : 'Copy the path'].filter(Boolean).join('\n')}
        className="min-w-0 flex-1 text-left"
      >
        <span className="block truncate text-[13px] text-[var(--color-text)]">{copied ? 'path copied' : file.label}</span>
        <span className="block truncate font-mono text-[10px] text-[var(--color-text-faint)]">{sub}</span>
      </button>
      <div className="flex shrink-0 items-center lg:opacity-0 lg:transition-opacity lg:group-hover:opacity-100 lg:group-focus-within:opacity-100">
        {file.kind === 'path' && term.canSend && file.relPath && (
          <button type="button" onClick={() => term.send(forTerminal(file.relPath ?? ''))} title="Type the path into the open session" aria-label="Send to the session" className={ICON}>
            <Send size={12} />
          </button>
        )}
        {file.kind === 'path' && (
          <button type="button" onClick={() => void copy()} title="Copy the path" aria-label="Copy the path" className={ICON}>
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
        )}
        <button
          type="button"
          disabled={unpin.isPending}
          onClick={() => { if (armed) { setArmed(false); unpin.mutate() } else { setArmed(true); setTimeout(() => setArmed(false), 4000) } }}
          title={armed ? 'Click again to unpin it' : 'Unpin it. The activity tab can undo it.'}
          aria-label="Unpin"
          className={`${ICON} ${armed ? 'text-[var(--color-danger)]' : 'hover:text-[var(--color-danger)]'}`}
        >
          <Trash2 size={12} />
        </button>
      </div>
    </li>
  )
}

function FileRow({ projectId, file, term, onView }: {
  projectId: string
  file: FileRef
  term: ProjectTerm
  onView: (f: FileRef) => void
}) {
  const qc = useQueryClient()
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const unpin = useMutation({
    mutationFn: () => unpinProjFile(projectId, file.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: PROJ_KEYS.doc(projectId) })
      void qc.invalidateQueries({ queryKey: PROJ_KEYS.events(projectId) })
    },
    onError: (e: unknown) => setError(apiErrorText(e, 'could not unpin it')),
  })

  const href = file.kind === 'url' && file.url ? safeHref(file.url) : null
  const Icon = file.kind === 'doc' ? FileText : file.kind === 'url' ? LinkIcon : File
  const sub = file.kind === 'path'
    ? file.relPath ?? ''
    : file.kind === 'url'
      ? href ? whereTo(href) : '[blocked link]'
      : `doc · ${kb(file.contentBytes)}`
  const meta = [
    file.kind === 'path' && file.hasContent && file.capturedAt ? `captured ${ago(file.capturedAt)}` : '',
    file.createdBy.startsWith('session:') ? '[by session]' : '',
  ].filter(Boolean).join(' · ')

  const copy = async () => {
    if (!file.relPath) return
    if (await copyText(file.relPath)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  return (
    <li className={`flex flex-wrap items-start gap-x-3 gap-y-1 py-2.5${unpin.isPending ? ' opacity-40' : ''}`}>
      <Icon size={14} className="mt-0.5 shrink-0 text-[var(--color-text-faint)]" />
      <div className="min-w-0 flex-1 basis-[calc(100%-2rem)] sm:basis-auto">
        <div className="truncate text-sm text-[var(--color-text)]">{file.label}</div>
        <div className="truncate font-mono text-[11px] text-[var(--color-text-faint)]" title={file.relPath ?? file.url ?? undefined}>{sub}</div>
        {file.note && <div className="mt-0.5 break-words text-[11px] text-[var(--color-text-dim)]">{file.note}</div>}
        {meta && <div className="mt-0.5 text-[10px] text-[var(--color-text-faint)]">{meta}</div>}
        {error && <div className="mt-1 text-[11px] text-[var(--color-danger)]">{error}</div>}
      </div>
      <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-0.5">
        {file.kind === 'path' && (
          <button type="button" onClick={() => void copy()} title="Copy the path" className={BTN_TEXT}>
            {copied ? <Check size={11} /> : <Copy size={11} />} {copied ? 'copied' : 'copy'}
          </button>
        )}
        {file.kind === 'path' && term.canSend && file.relPath && (
          <button
            type="button"
            onClick={() => term.send(forTerminal(file.relPath ?? ''))}
            title="Type the path into the open session, without pressing Enter"
            className={BTN_TEXT}
          >
            <Send size={11} /> send
          </button>
        )}
        {file.kind === 'url' && href && (
          href.startsWith('/') ? (
            <Link to={href} className={BTN_TEXT}>open</Link>
          ) : (
            <a href={href} target="_blank" rel="noopener noreferrer" className={BTN_TEXT}>open</a>
          )
        )}
        {(file.kind === 'doc' || file.kind === 'path') && file.hasContent && (
          <button type="button" onClick={() => onView(file)} className={BTN_TEXT}>
            <Eye size={11} /> view
          </button>
        )}
        <ArmButton
          label="unpin"
          icon={<Trash2 size={11} />}
          disabled={unpin.isPending}
          title="Unpin it. The activity tab can undo it."
          onConfirm={() => unpin.mutate()}
        />
      </div>
    </li>
  )
}

export function FileViewer({ projectId, file, onClose }: { projectId: string; file: FileRef; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  // A session can re-pin the same path at any time, so every open refetches.
  const q = useQuery({
    queryKey: PROJ_KEYS.file(projectId, file.id),
    queryFn: () => fetchProjFileContent(projectId, file.id),
    staleTime: 0,
    refetchInterval: false,
  })

  const copy = async () => {
    if (!q.data) return
    if (await copyText(q.data.content)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  return (
    <Sheet
      title={file.label}
      onClose={onClose}
      footer={(
        <>
          <button type="button" disabled={!q.data} onClick={() => void copy()} className={BTN_GHOST}>
            {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'copied' : 'copy'}
          </button>
          {q.data?.capturedAt && (
            <span className="text-[11px] text-[var(--color-text-faint)]">captured {ago(q.data.capturedAt)}</span>
          )}
        </>
      )}
    >
      {file.relPath && <div className="mb-3 truncate font-mono text-[11px] text-[var(--color-text-faint)]">{file.relPath}</div>}
      {q.isLoading ? (
        <div className="text-xs text-[var(--color-text-dim)]">&gt; loading</div>
      ) : q.isError ? (
        <div className="text-xs text-[var(--color-danger)]">{apiErrorText(q.error, 'could not read the contents')}</div>
      ) : q.data?.contentType === 'markdown' ? (
        <Markdown>{q.data.content}</Markdown>
      ) : (
        <pre className="whitespace-pre-wrap break-words text-[12px] text-[var(--color-text)]">{q.data?.content ?? ''}</pre>
      )}
    </Sheet>
  )
}

const KIND_OPTIONS = [
  { value: 'path', label: 'path' },
  { value: 'url', label: 'url' },
  { value: 'doc', label: 'doc' },
]

const KIND_HINT: Record<FileKind, string> = {
  path: 'A file in the project folder on thor, relative to it.',
  url: 'A web link, or a /path inside Valkyrie.',
  doc: 'Text kept here on odin, readable from the phone.',
}

export function AddFileSheet({ projectId, allowSnapshots, onClose }: { projectId: string; allowSnapshots: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const [kind, setKind] = useState<FileKind>('path')
  const [label, setLabel] = useState('')
  const [relPath, setRelPath] = useState('')
  const [url, setUrl] = useState('')
  const [note, setNote] = useState('')
  const [content, setContent] = useState('')
  const [error, setError] = useState('')

  const href = safeHref(url)
  const docOff = kind === 'doc' && !allowSnapshots
  // A label is optional where the target already names itself.
  const fallbackLabel = kind === 'path'
    ? relPath.trim().split(/[\\/]/).filter(Boolean).pop() ?? ''
    : kind === 'url' && href ? whereTo(href) : ''
  const finalLabel = label.trim() || fallbackLabel
  const ready = !docOff && finalLabel !== '' && (
    kind === 'path' ? relPath.trim() !== ''
      : kind === 'url' ? href !== null
      : content.trim() !== ''
  )

  const pin = useMutation({
    mutationFn: () => pinProjFile(projectId, {
      kind,
      label: finalLabel,
      note: note.trim() || undefined,
      ...(kind === 'path' ? { relPath: relPath.trim() } : {}),
      ...(kind === 'url' ? { url: url.trim() } : {}),
      ...(kind === 'doc' ? { content, contentType: 'markdown' as const } : {}),
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: PROJ_KEYS.doc(projectId) })
      void qc.invalidateQueries({ queryKey: PROJ_KEYS.events(projectId) })
      onClose()
    },
    onError: (e: unknown) => setError(apiErrorText(e, 'could not pin it')),
  })

  return (
    <Sheet
      title="add file"
      onClose={onClose}
      footer={(
        <>
          <button type="button" disabled={!ready || pin.isPending} onClick={() => pin.mutate()} className={BTN_ACCENT}>
            <Plus size={12} /> {pin.isPending ? 'pinning' : 'pin it'}
          </button>
          <button type="button" onClick={onClose} className={BTN_GHOST}>cancel</button>
        </>
      )}
    >
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (ready) pin.mutate() }}>
        <div>
          <span className={LABEL}>kind</span>
          <Dropdown value={kind} options={KIND_OPTIONS} onChange={(v) => { setKind(v as FileKind); setError('') }} />
          <div className="mt-1 text-[11px] text-[var(--color-text-faint)]">{KIND_HINT[kind]}</div>
        </div>
        <label className="block">
          <span className={LABEL}>label</span>
          <input
            value={label}
            maxLength={LIMITS.fileLabel}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={fallbackLabel || 'what it is'}
            className={FIELD}
          />
        </label>
        {kind === 'path' && (
          <label className="block">
            <span className={LABEL}>path in the project folder</span>
            <input
              value={relPath}
              maxLength={LIMITS.relPath}
              onChange={(e) => setRelPath(e.target.value)}
              placeholder="docs/plan.md"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className={`font-mono ${FIELD}`}
            />
          </label>
        )}
        {kind === 'url' && (
          <label className="block">
            <span className={LABEL}>url</span>
            <input
              value={url}
              maxLength={LIMITS.url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://... or /path"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className={`font-mono ${FIELD}`}
            />
            {url.trim() && !href && (
              <span className="mt-1 block text-[11px] text-[var(--color-warning)]">Only http, https, mailto and /paths inside Valkyrie are allowed.</span>
            )}
          </label>
        )}
        <label className="block">
          <span className={LABEL}>note</span>
          <input
            value={note}
            maxLength={LIMITS.fileNote}
            onChange={(e) => setNote(e.target.value)}
            placeholder="optional"
            className={FIELD}
          />
        </label>
        {kind === 'doc' && (
          <label className="block">
            <span className={LABEL}>content (markdown)</span>
            <textarea
              value={content}
              maxLength={LIMITS.fileContent}
              onChange={(e) => setContent(e.target.value)}
              disabled={docOff}
              placeholder={docOff ? 'file contents are off for this project' : ''}
              className={`min-h-48 resize-y disabled:opacity-40 ${FIELD}`}
            />
            {docOff && (
              <span className="mt-1 block text-[11px] text-[var(--color-warning)]">
                file contents are off for this project. Pin the path or a link instead.
              </span>
            )}
          </label>
        )}
        {error && <div className="text-xs text-[var(--color-danger)]">{error}</div>}
      </form>
    </Sheet>
  )
}

export function FilesTab({ projectId, doc, term, compact = false }: ProjectTabProps & { compact?: boolean }) {
  const [viewing, setViewing] = useState<FileRef | null>(null)
  const [adding, setAdding] = useState(false)
  const files = doc.files
  const sheets = (
    <>
      {viewing && <FileViewer projectId={projectId} file={viewing} onClose={() => setViewing(null)} />}
      {adding && (
        <AddFileSheet projectId={projectId} allowSnapshots={doc.project.allowSnapshots} onClose={() => setAdding(false)} />
      )}
    </>
  )

  if (compact) {
    return (
      <div>
        {files.length === 0 ? (
          <div className="py-2 text-[11px] text-[var(--color-text-faint)]">Nothing pinned yet. Ask a session to pin the key files.</div>
        ) : (
          <ul>
            {files.map((f) => <CompactFileRow key={f.id} projectId={projectId} file={f} term={term} onView={setViewing} />)}
          </ul>
        )}
        <button
          type="button"
          disabled={files.length >= LIMITS.filesPerProject}
          onClick={() => setAdding(true)}
          className={`mt-1 ${BTN_TEXT}`}
        >
          <Plus size={11} /> pin a file
        </button>
        {sheets}
      </div>
    )
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-[11px] text-[var(--color-text-faint)]">
          {files.length} pinned{files.length >= LIMITS.filesPerProject ? ' (full)' : ''}
        </span>
        <button
          type="button"
          disabled={files.length >= LIMITS.filesPerProject}
          onClick={() => setAdding(true)}
          className={BTN_GHOST}
        >
          <Plus size={12} /> add file
        </button>
      </div>

      {files.length === 0 ? (
        <div className="py-3 text-[11px] text-[var(--color-text-faint)]">Nothing pinned yet.</div>
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {files.map((f) => (
            <FileRow key={f.id} projectId={projectId} file={f} term={term} onView={setViewing} />
          ))}
        </ul>
      )}

      <div className="mt-3 text-[11px] text-[var(--color-text-faint)]">
        Sessions pin files with the valkyrie tools; ask one to refresh the pinned files.
      </div>

      {sheets}
    </div>
  )
}
