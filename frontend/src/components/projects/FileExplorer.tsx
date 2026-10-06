import { createElement, useCallback, useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, Folder, FolderOpen, Pin, PinOff, Plus, RefreshCw } from 'lucide-react'
import { apiErrorText } from '../../lib/api'
import {
  PROJ_KEYS, fetchProjTree, pinProjFile, unpinProjFile,
  type FileRef, type FsEntry, type ProjectDoc, type ProjectTerm,
} from '../../lib/projectsApi'
import { AddFileSheet, CompactFileRow, FileViewer } from './FilesTab'
import { fmtBytes, iconFor } from './fileKinds'

// The files column, laid out like VS Code's explorer: the pinned files as a
// tree of their real paths, then the whole project folder, read from thor one
// folder at a time as it is opened. A file opens in the middle column.

const ROW = 'group flex h-7 min-w-0 cursor-pointer select-none items-center gap-1 pr-1 text-[13px] transition-colors sm:h-[22px]'
const ROW_IDLE = 'text-[var(--color-text-dim)] hover:bg-[rgba(var(--color-accent-rgb),0.06)] hover:text-[var(--color-text)]'
const ROW_ON = 'bg-[rgba(var(--color-accent-rgb),0.14)] text-[var(--color-accent)]'
// The vertical guide each level of nesting hangs from, as in VS Code.
const GUIDE = 'ml-[9px] border-l border-[var(--color-border)] pl-[3px]'
const ACT = 'inline-flex h-6 w-6 shrink-0 items-center justify-center text-[var(--color-text-faint)] transition hover:text-[var(--color-accent)] lg:opacity-0 lg:group-hover:opacity-100'

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)

type Ctx = {
  projectId: string
  openFile: string | null
  onOpenFile: (rel: string) => void
  pinnedByPath: Map<string, FileRef>
  togglePin: (rel: string) => void
  expanded: Set<string>
  toggle: (key: string) => void
}

function FileLine({ ctx, rel, name, size, label }: { ctx: Ctx; rel: string; name: string; size?: number; label?: string }) {
  const pinned = ctx.pinnedByPath.has(rel)
  return (
    <div
      role="treeitem"
      aria-selected={ctx.openFile === rel}
      tabIndex={0}
      onClick={() => ctx.onOpenFile(rel)}
      onKeyDown={(e) => { if (e.key === 'Enter') ctx.onOpenFile(rel) }}
      title={[rel, size !== undefined ? fmtBytes(size) : '', label && label !== name ? label : ''].filter(Boolean).join('\n')}
      className={`${ROW} ${ctx.openFile === rel ? ROW_ON : ROW_IDLE} pl-[18px]`}
    >
      {createElement(iconFor(name), { size: 13, className: 'shrink-0 opacity-70' })}
      <span className="min-w-0 truncate">{name}</span>
      {label && label !== name && <span className="min-w-0 truncate text-[11px] text-[var(--color-text-faint)]">{label}</span>}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); ctx.togglePin(rel) }}
        title={pinned ? 'Unpin it' : 'Pin it to the top of this list'}
        aria-label={pinned ? 'Unpin' : 'Pin'}
        className={`${ACT} ml-auto`}
      >
        {pinned ? <PinOff size={12} /> : <Pin size={12} />}
      </button>
    </div>
  )
}

function DirLine({ ctx, keyId, name, open, children }: { ctx: Ctx; keyId: string; name: string; open: boolean; children: ReactNode }) {
  return (
    <div role="group">
      <div
        role="treeitem"
        aria-expanded={open}
        tabIndex={0}
        onClick={() => ctx.toggle(keyId)}
        onKeyDown={(e) => { if (e.key === 'Enter') ctx.toggle(keyId) }}
        className={`${ROW} ${ROW_IDLE}`}
      >
        <ChevronRight size={13} className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        {open
          ? <FolderOpen size={13} className="shrink-0 text-[var(--color-accent-2)]" />
          : <Folder size={13} className="shrink-0 text-[var(--color-accent-2)]" />}
        <span className="min-w-0 truncate">{name}</span>
      </div>
      {open && <div className={GUIDE}>{children}</div>}
    </div>
  )
}

// One folder of the real project folder, fetched when it is first opened.
function FolderChildren({ ctx, rel }: { ctx: Ctx; rel: string }) {
  const q = useQuery({
    queryKey: PROJ_KEYS.tree(ctx.projectId, rel),
    queryFn: () => fetchProjTree(ctx.projectId, rel),
    staleTime: 30_000,
    refetchInterval: false,
    retry: false,
  })
  if (q.isLoading) return <div className="h-6 pl-[18px] text-[11px] leading-6 text-[var(--color-text-faint)]">loading</div>
  if (q.isError) {
    return (
      <div className="py-1 pl-[18px] text-[11px] text-[var(--color-danger)]">
        {apiErrorText(q.error, 'could not read this folder')}
        <button type="button" onClick={() => void q.refetch()} className="ml-2 underline">retry</button>
      </div>
    )
  }
  const entries = q.data?.entries ?? []
  if (entries.length === 0) return <div className="h-6 pl-[18px] text-[11px] leading-6 text-[var(--color-text-faint)]">empty</div>
  return (
    <>
      {entries.map((e: FsEntry) => {
        const r = join(rel, e.name)
        return e.dir
          ? (
            <DirLine key={r} ctx={ctx} keyId={`d:${r}`} name={e.name} open={ctx.expanded.has(`d:${r}`)}>
              <FolderChildren ctx={ctx} rel={r} />
            </DirLine>
          )
          : <FileLine key={r} ctx={ctx} rel={r} name={e.name} size={e.size} />
      })}
      {q.data?.truncated && <div className="pl-[18px] text-[11px] text-[var(--color-text-faint)]">more files not shown</div>}
    </>
  )
}

// The pinned paths as a tree. A folder holding only one folder is drawn as
// one row ("a/b/c"), as VS Code's compact folders do.
type PNode = { name: string; path: string; dirs: Map<string, PNode>; files: { name: string; file: FileRef }[] }

function buildPinned(files: FileRef[]): PNode {
  const root: PNode = { name: '', path: '', dirs: new Map(), files: [] }
  for (const f of files) {
    if (f.kind !== 'path' || !f.relPath) continue
    const segs = f.relPath.split('/').filter(Boolean)
    let node = root
    for (const seg of segs.slice(0, -1)) {
      let next = node.dirs.get(seg)
      if (!next) {
        next = { name: seg, path: join(node.path, seg), dirs: new Map(), files: [] }
        node.dirs.set(seg, next)
      }
      node = next
    }
    node.files.push({ name: segs[segs.length - 1], file: f })
  }
  return root
}

function PinnedNode({ ctx, node }: { ctx: Ctx; node: PNode }) {
  const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  const files = [...node.files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  return (
    <>
      {dirs.map((d) => {
        let label = d.name
        let at = d
        while (at.files.length === 0 && at.dirs.size === 1) {
          at = [...at.dirs.values()][0]
          label += '/' + at.name
        }
        // Pinned folders start open, so what is remembered is a close.
        const keyId = `p:${at.path}:closed`
        return (
          <DirLine key={keyId} ctx={ctx} keyId={keyId} name={label} open={!ctx.expanded.has(keyId)}>
            <PinnedNode ctx={ctx} node={at} />
          </DirLine>
        )
      })}
      {files.map((f) => (
        <FileLine key={f.file.id} ctx={ctx} rel={f.file.relPath as string} name={f.name} label={f.file.label} />
      ))}
    </>
  )
}

function Section({ title, open, onToggle, actions, children }: {
  title: string
  open: boolean
  onToggle: () => void
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div>
      <div className="group flex h-7 items-center">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex h-7 min-w-0 flex-1 items-center gap-1 text-left text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-text-dim)] transition hover:text-[var(--color-text)]"
        >
          <ChevronRight size={12} className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
          <span className="truncate">{title}</span>
        </button>
        {actions}
      </div>
      {open && <div role="tree">{children}</div>}
    </div>
  )
}

export function FileExplorer({ projectId, doc, term, openFile, onOpenFile }: {
  projectId: string
  doc: ProjectDoc
  term: ProjectTerm
  openFile: string | null
  onOpenFile: (rel: string) => void
}) {
  const qc = useQueryClient()
  const storeKey = `valkyrie-proj-tree-${projectId}`
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(sessionStorage.getItem(storeKey) ?? '[]') as string[]) } catch { return new Set() }
  })
  const [sections, setSections] = useState({ pinned: true, other: true, folder: true })
  const [viewing, setViewing] = useState<FileRef | null>(null)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')

  const toggle = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      try { sessionStorage.setItem(storeKey, JSON.stringify([...next])) } catch { /* private mode */ }
      return next
    })
  }, [storeKey])

  const pathPins = useMemo(() => doc.files.filter((f) => f.kind === 'path' && f.relPath), [doc.files])
  const otherPins = doc.files.filter((f) => f.kind !== 'path')
  const pinnedByPath = useMemo(() => new Map(pathPins.map((f) => [f.relPath as string, f])), [pathPins])
  const pinnedTree = useMemo(() => buildPinned(pathPins), [pathPins])

  const pin = useMutation({
    mutationFn: async (rel: string) => {
      const held = pinnedByPath.get(rel)
      if (held) return unpinProjFile(projectId, held.id)
      return pinProjFile(projectId, { kind: 'path', relPath: rel, label: rel.split('/').pop() ?? rel })
    },
    onSuccess: () => {
      setError('')
      void qc.invalidateQueries({ queryKey: PROJ_KEYS.doc(projectId) })
      void qc.invalidateQueries({ queryKey: PROJ_KEYS.events(projectId) })
    },
    onError: (e: unknown) => setError(apiErrorText(e, 'could not change the pin')),
  })

  const ctx: Ctx = {
    projectId, openFile, onOpenFile, pinnedByPath, togglePin: (rel) => pin.mutate(rel), expanded, toggle,
  }
  // The folder's own name, once thor has answered. Same cache entry as the
  // top level of the tree below, so this is not a second request.
  const rootName = useQuery({
    queryKey: PROJ_KEYS.tree(projectId, ''),
    queryFn: () => fetchProjTree(projectId, ''),
    staleTime: 30_000,
    refetchInterval: false,
    retry: false,
  }).data?.root
  const refresh = () => void qc.invalidateQueries({ queryKey: ['proj', 'tree', projectId] })
  const flip = (k: keyof typeof sections) => setSections((s) => ({ ...s, [k]: !s[k] }))

  return (
    <div className="space-y-1">
      {error && <div className="text-[11px] text-[var(--color-danger)]">{error}</div>}
      {pathPins.length > 0 && (
        <Section title="pinned" open={sections.pinned} onToggle={() => flip('pinned')}>
          <PinnedNode ctx={ctx} node={pinnedTree} />
        </Section>
      )}
      {otherPins.length > 0 && (
        <Section title="links and notes" open={sections.other} onToggle={() => flip('other')}>
          <ul>
            {otherPins.map((f) => <CompactFileRow key={f.id} projectId={projectId} file={f} term={term} onView={setViewing} />)}
          </ul>
        </Section>
      )}
      <Section
        title={rootName ?? 'project folder'}
        open={sections.folder}
        onToggle={() => flip('folder')}
        actions={(
          <>
            <button type="button" onClick={refresh} title="Read the folder again" aria-label="Refresh" className={ACT}>
              <RefreshCw size={12} />
            </button>
            <button type="button" onClick={() => setAdding(true)} title="Pin a link or a note" aria-label="Pin a link or a note" className={ACT}>
              <Plus size={13} />
            </button>
          </>
        )}
      >
        <FolderChildren ctx={ctx} rel="" />
      </Section>
      {pathPins.length === 0 && (
        <div className="pt-1 text-[11px] text-[var(--color-text-faint)]">Pin a file with its pin icon to keep it at the top.</div>
      )}
      {viewing && <FileViewer projectId={projectId} file={viewing} onClose={() => setViewing(null)} />}
      {adding && <AddFileSheet projectId={projectId} allowSnapshots={doc.project.allowSnapshots} onClose={() => setAdding(false)} />}
    </div>
  )
}
