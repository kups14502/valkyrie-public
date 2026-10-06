import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronRight, Copy, Download, ExternalLink, Pin, PinOff, Send, TextWrap, X } from 'lucide-react'
import { apiErrorText } from '../../lib/api'
import { copyText } from '../../lib/clipboard'
import {
  PROJ_KEYS, fetchProjFsFile, openProjFsFile, pinProjFile, unpinProjFile,
  type FileRef, type ProjectTerm,
} from '../../lib/projectsApi'
import { Markdown } from '../Markdown'
import { extOf, fmtBytes, viewKind } from './fileKinds'

// A file from the project folder, open in the middle column like an editor
// tab: its path as a breadcrumb, then the file itself. Markdown renders, code
// and text show with line numbers, images and PDFs show as they are, and
// anything else (Word, Excel) opens in its own app on thor.

// A bigger text file shows its start; the rest is one "open on thor" away.
const TEXT_MAX = 2 * 1024 * 1024

const ICON = 'inline-flex h-8 w-8 shrink-0 items-center justify-center text-[var(--color-text-faint)] transition hover:text-[var(--color-accent)] disabled:opacity-30 sm:h-7 sm:w-7'

export function FileView({ projectId, rel, rootName, term, pinned, onClose }: {
  projectId: string
  rel: string
  rootName?: string
  term: ProjectTerm
  pinned: FileRef | undefined
  onClose: () => void
}) {
  const qc = useQueryClient()
  const kind = viewKind(rel)
  const name = rel.split('/').pop() ?? rel
  const segs = rel.split('/').filter(Boolean)
  const [raw, setRaw] = useState(false)
  const [wrap, setWrap] = useState(false)
  const [note, setNote] = useState('')

  // Every open reads it again: a session may have just changed it on thor.
  const q = useQuery({
    queryKey: PROJ_KEYS.fsFile(projectId, rel),
    queryFn: () => fetchProjFsFile(projectId, rel),
    enabled: kind !== 'none',
    staleTime: 0,
    gcTime: 0,
    refetchInterval: false,
    retry: false,
  })
  const blob = q.data

  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    if (!blob || (kind !== 'text' && kind !== 'markdown')) return
    void blob.slice(0, TEXT_MAX).text().then((t) => { if (alive) setText(t) })
    return () => { alive = false }
  }, [blob, kind])

  const url = useMemo(() => (blob && (kind === 'image' || kind === 'pdf') ? URL.createObjectURL(blob) : null), [blob, kind])
  useEffect(() => () => { if (url) URL.revokeObjectURL(url) }, [url])

  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => setNote(''), 2500)
    return () => clearTimeout(t)
  }, [note])

  const openThor = useMutation({
    mutationFn: () => openProjFsFile(projectId, rel),
    onSuccess: () => setNote('opened on thor'),
    onError: (e: unknown) => setNote(apiErrorText(e, 'could not open it on thor')),
  })
  const pin = useMutation({
    mutationFn: async () => {
      if (pinned) await unpinProjFile(projectId, pinned.id)
      else await pinProjFile(projectId, { kind: 'path', relPath: rel, label: name })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: PROJ_KEYS.doc(projectId) })
      void qc.invalidateQueries({ queryKey: PROJ_KEYS.events(projectId) })
    },
    onError: (e: unknown) => setNote(apiErrorText(e, 'could not change the pin')),
  })

  const copy = async () => { if (await copyText(rel)) setNote('path copied') }
  const download = () => {
    void fetchProjFsFile(projectId, rel).then((b) => {
      const a = document.createElement('a')
      a.href = URL.createObjectURL(b)
      a.download = name
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
    }).catch((e: unknown) => setNote(apiErrorText(e, 'could not download it')))
  }

  const lines = text === null ? [] : text.split(/\r?\n/)
  const cut = blob ? blob.size > TEXT_MAX : false

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-w-0 shrink-0 items-center gap-1 border-b border-[var(--color-border)] px-2 py-1">
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden text-[12px] text-[var(--color-text-faint)]" title={rel}>
          {rootName && <span className="shrink-0">{rootName}</span>}
          {segs.map((s, i) => (
            <span key={i} className={`flex min-w-0 items-center gap-0.5 ${i === segs.length - 1 ? 'shrink-0 text-[var(--color-text)]' : 'shrink truncate'}`}>
              {(i > 0 || rootName) && <ChevronRight size={11} className="shrink-0" />}
              <span className="truncate">{s}</span>
            </span>
          ))}
        </div>
        {note && <span className="shrink-0 px-1 text-[11px] text-[var(--color-accent)]">{note}</span>}
        {kind === 'markdown' && (
          <button type="button" onClick={() => setRaw((v) => !v)} className={`${ICON} w-auto px-1.5 text-[10px] uppercase tracking-[0.12em]`} title="Switch between rendered and source">
            {raw ? 'rendered' : 'source'}
          </button>
        )}
        {(kind === 'text' || (kind === 'markdown' && raw)) && (
          <button type="button" onClick={() => setWrap((v) => !v)} className={`${ICON} ${wrap ? 'text-[var(--color-accent)]' : ''}`} title="Wrap long lines" aria-label="Wrap long lines">
            <TextWrap size={13} />
          </button>
        )}
        {term.canSend && (
          <button
            type="button"
            onClick={() => term.send(rel.includes(' ') ? `"${rel}" ` : `${rel} `)}
            className={ICON}
            title="Type the path into the open session"
            aria-label="Send to the session"
          >
            <Send size={13} />
          </button>
        )}
        <button type="button" onClick={() => void copy()} className={ICON} title="Copy the path" aria-label="Copy the path">
          {note === 'path copied' ? <Check size={13} /> : <Copy size={13} />}
        </button>
        <button type="button" disabled={pin.isPending} onClick={() => pin.mutate()} className={ICON} title={pinned ? 'Unpin it' : 'Pin it'} aria-label={pinned ? 'Unpin' : 'Pin'}>
          {pinned ? <PinOff size={13} /> : <Pin size={13} />}
        </button>
        <button type="button" disabled={openThor.isPending} onClick={() => openThor.mutate()} className={ICON} title="Open it in its own app on thor" aria-label="Open on thor">
          <ExternalLink size={13} />
        </button>
        <button type="button" onClick={onClose} className={ICON} title="Close it" aria-label="Close">
          <X size={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {kind === 'none' ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <div className="text-xs text-[var(--color-text-dim)]">No preview for .{extOf(name)} files in the page.</div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button type="button" disabled={openThor.isPending} onClick={() => openThor.mutate()} className="inline-flex min-h-9 items-center gap-1.5 border border-[var(--color-accent)] bg-[rgba(var(--color-accent-rgb),0.10)] px-3 text-[11px] uppercase tracking-[0.14em] text-[var(--color-accent)] sm:min-h-8">
                <ExternalLink size={12} /> open on thor
              </button>
              <button type="button" onClick={download} className="inline-flex min-h-9 items-center gap-1.5 border border-[var(--color-border)] px-2.5 text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-dim)] hover:text-[var(--color-accent)] sm:min-h-8">
                <Download size={12} /> download
              </button>
            </div>
          </div>
        ) : q.isLoading ? (
          <div className="p-4 text-[11px] text-[var(--color-text-faint)]">&gt; loading</div>
        ) : q.isError ? (
          <div className="p-4 text-xs text-[var(--color-danger)]">{apiErrorText(q.error, 'could not read the file')}</div>
        ) : kind === 'image' && url ? (
          <div className="flex min-h-full items-center justify-center p-4">
            <img src={url} alt={name} className="max-h-full max-w-full object-contain" />
          </div>
        ) : kind === 'pdf' && url ? (
          <iframe src={url} title={name} className="h-full w-full border-0 bg-white" />
        ) : kind === 'markdown' && !raw ? (
          <div className="mx-auto max-w-4xl p-4">
            <Markdown>{text ?? ''}</Markdown>
          </div>
        ) : (
          <div className="flex min-w-0 font-mono text-[12px] leading-5">
            {!wrap && (
              <pre aria-hidden className="sticky left-0 shrink-0 select-none border-r border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-2 text-right text-[var(--color-text-faint)]">
                {lines.map((_, i) => i + 1).join('\n')}
              </pre>
            )}
            <pre className={`min-w-0 flex-1 px-3 py-2 text-[var(--color-text)] ${wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'}`}>
              {text}
            </pre>
          </div>
        )}
        {cut && (kind === 'text' || kind === 'markdown') && (
          <div className="border-t border-[var(--color-border)] px-3 py-2 text-[11px] text-[var(--color-text-faint)]">
            Showing the first {fmtBytes(TEXT_MAX)} of {fmtBytes(blob?.size ?? 0)}. Open it on thor for the rest.
          </div>
        )}
      </div>
    </div>
  )
}
