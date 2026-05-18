import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Card, Stat } from '../components/Card'
import { fetchNarrative, saveNarrative, type NarrativeNode, type NarrativeTree } from '../lib/api'

const newId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `n_${Math.random().toString(36).slice(2)}_${Date.now()}`
}

const makeNode = (): NarrativeNode => {
  const now = new Date().toISOString()
  return {
    id: newId(),
    title: 'untitled',
    body: '',
    choices: [],
    tags: [],
    createdAt: now,
    updatedAt: now,
  }
}

function computeHealth(tree: NarrativeTree) {
  const ids = new Set(tree.nodes.map((n) => n.id))
  const reachable = new Set<string>()
  const visit = (id: string) => {
    if (reachable.has(id) || !ids.has(id)) return
    reachable.add(id)
    const node = tree.nodes.find((n) => n.id === id)
    if (!node) return
    for (const c of node.choices) if (c.targetId) visit(c.targetId)
  }
  if (tree.rootId) visit(tree.rootId)
  const orphans = tree.nodes.filter((n) => !reachable.has(n.id) && n.id !== tree.rootId).length
  const deadEnds = tree.nodes.filter((n) => n.choices.length === 0).length
  const dangling = tree.nodes.reduce((acc, n) => acc + n.choices.filter((c) => !c.targetId || !ids.has(c.targetId)).length, 0)
  return { total: tree.nodes.length, orphans, deadEnds, dangling, reachable: reachable.size }
}

export default function Game() {
  const qc = useQueryClient()
  const remote = useQuery({ queryKey: ['narrative'], queryFn: fetchNarrative, refetchInterval: false, staleTime: 60_000 })

  const [tree, setTree] = useState<NarrativeTree | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)

  // initial hydrate from server
  useEffect(() => {
    if (remote.data && !tree) setTree(remote.data)
  }, [remote.data, tree])

  const save = useMutation({
    mutationFn: saveNarrative,
    onSuccess: (data) => {
      setTree(data)
      setDirty(false)
      qc.setQueryData(['narrative'], data)
    },
  })

  const update = (next: NarrativeTree) => {
    setTree(next)
    setDirty(true)
  }

  const health = useMemo(() => (tree ? computeHealth(tree) : null), [tree])

  if (!tree) {
    return (
      <div className="space-y-8">
        <div>
          <div className="text-[11px] uppercase tracking-[0.35em] text-[var(--color-text-faint)]">Ops</div>
          <h1 className="mt-2 text-3xl font-semibold tracking-[0.08em]">Narrative</h1>
        </div>
        <Card><div className="text-sm text-[var(--color-text-dim)]">Loading…</div></Card>
      </div>
    )
  }

  const addNode = () => {
    const node = makeNode()
    const next: NarrativeTree = {
      ...tree,
      nodes: [...tree.nodes, node],
      rootId: tree.rootId ?? node.id,
    }
    update(next)
    setExpandedId(node.id)
  }

  const updateNode = (id: string, patch: Partial<NarrativeNode>) => {
    const next: NarrativeTree = {
      ...tree,
      nodes: tree.nodes.map((n) => (n.id === id ? { ...n, ...patch, updatedAt: new Date().toISOString() } : n)),
    }
    update(next)
  }

  const deleteNode = (id: string) => {
    if (!confirm('Delete this node? Choices pointing here will become unlinked.')) return
    const next: NarrativeTree = {
      version: tree.version,
      rootId: tree.rootId === id ? null : tree.rootId,
      nodes: tree.nodes
        .filter((n) => n.id !== id)
        .map((n) => ({
          ...n,
          choices: n.choices.map((c) => (c.targetId === id ? { ...c, targetId: null } : c)),
        })),
    }
    update(next)
    if (expandedId === id) setExpandedId(null)
  }

  const setRoot = (id: string) => update({ ...tree, rootId: id })

  return (
    <div className="space-y-8">
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.35em] text-[var(--color-text-faint)]">Ops</div>
          <h1 className="mt-2 text-3xl font-semibold tracking-[0.08em] text-[var(--color-text)]">Narrative</h1>
        </div>
        <div className="flex items-center gap-2">
          {dirty && <span className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-warning)]">[unsaved]</span>}
          <button
            type="button"
            onClick={() => save.mutate(tree)}
            disabled={!dirty || save.isPending}
            className="border border-[var(--color-accent)] bg-[color:rgba(45,212,191,0.08)] px-3 py-1 text-xs uppercase tracking-[0.18em] text-[var(--color-accent)] transition disabled:opacity-40"
          >
            {save.isPending ? 'saving…' : 'save'}
          </button>
          <button
            type="button"
            onClick={addNode}
            className="border border-[var(--color-border)] bg-[color:rgba(255,255,255,0.02)] px-3 py-1 text-xs uppercase tracking-[0.18em] text-[var(--color-text-dim)] transition hover:text-[var(--color-text)]"
          >
            + node
          </button>
        </div>
      </div>

      {health && (
        <Card title="Tree health">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
            <Stat label="Nodes" value={health.total} sub="total" />
            <Stat label="Reachable" value={health.reachable} sub="from root" />
            <Stat label="Orphans" value={health.orphans} sub="unreachable" />
            <Stat label="Dead ends" value={health.deadEnds} sub="no choices" />
            <Stat label="Dangling" value={health.dangling} sub="broken targets" />
          </div>
        </Card>
      )}

      {save.error && (
        <div className="border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 text-xs text-[var(--color-danger)]">
          save failed: {(save.error as Error).message}
        </div>
      )}

      {tree.nodes.length === 0 ? (
        <Card>
          <div className="space-y-2 text-sm text-[var(--color-text-dim)]">
            <div>$ narrative --new</div>
            <div>// empty tree — tap + node to begin</div>
          </div>
        </Card>
      ) : (
        <div className="space-y-3">
          {[...tree.nodes].sort((a, b) => {
            if (a.id === tree.rootId) return -1
            if (b.id === tree.rootId) return 1
            return a.title.localeCompare(b.title)
          }).map((node) => {
            const expanded = expandedId === node.id
            const isRoot = node.id === tree.rootId
            return (
              <div key={node.id} className="border border-[var(--color-border)] bg-[var(--color-surface)]">
                <button
                  type="button"
                  onClick={() => setExpandedId(expanded ? null : node.id)}
                  className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-semibold text-[var(--color-text)]">{node.title || 'untitled'}</span>
                      {isRoot && <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-accent)]">[root]</span>}
                      {node.choices.length === 0 && <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-warning)]">[dead end]</span>}
                      {node.tags.map((t) => (
                        <span key={t} className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-faint)]">#{t}</span>
                      ))}
                    </div>
                    <div className="mt-0.5 line-clamp-2 text-xs text-[var(--color-text-dim)]">
                      {node.body || <span className="italic">empty body</span>}
                    </div>
                    {node.choices.length > 0 && (
                      <div className="mt-1 text-[11px] text-[var(--color-text-faint)]">
                        {node.choices.length} choice{node.choices.length === 1 ? '' : 's'}
                      </div>
                    )}
                  </div>
                  <span className="shrink-0 text-[var(--color-text-faint)]">{expanded ? '−' : '+'}</span>
                </button>

                {expanded && (
                  <div className="space-y-4 border-t border-[var(--color-border)] px-4 py-4">
                    <div className="space-y-1">
                      <label className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-faint)]">Title</label>
                      <input
                        type="text"
                        value={node.title}
                        onChange={(e) => updateNode(node.id, { title: e.target.value })}
                        className="w-full border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-faint)]">Body</label>
                      <textarea
                        value={node.body}
                        onChange={(e) => updateNode(node.id, { body: e.target.value })}
                        rows={5}
                        className="w-full resize-y border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm leading-relaxed text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none"
                      />
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <label className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-faint)]">Choices</label>
                        <button
                          type="button"
                          onClick={() => updateNode(node.id, { choices: [...node.choices, { label: '', targetId: null }] })}
                          className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-accent)]"
                        >
                          + choice
                        </button>
                      </div>
                      {node.choices.length === 0 && (
                        <div className="text-[11px] italic text-[var(--color-text-faint)]">none — this is a dead end</div>
                      )}
                      {node.choices.map((c, idx) => (
                        <div key={idx} className="flex flex-wrap gap-2">
                          <input
                            type="text"
                            placeholder="choice label"
                            value={c.label}
                            onChange={(e) => {
                              const choices = node.choices.map((cc, i) => (i === idx ? { ...cc, label: e.target.value } : cc))
                              updateNode(node.id, { choices })
                            }}
                            className="min-w-0 flex-1 border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-xs text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none"
                          />
                          <select
                            value={c.targetId ?? ''}
                            onChange={(e) => {
                              const val = e.target.value
                              const choices = node.choices.map((cc, i) =>
                                i === idx ? { ...cc, targetId: val === '' ? null : val } : cc
                              )
                              updateNode(node.id, { choices })
                            }}
                            className="border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-xs text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none"
                          >
                            <option value="">→ unlinked</option>
                            {tree.nodes.filter((n) => n.id !== node.id).map((n) => (
                              <option key={n.id} value={n.id}>→ {n.title || n.id.slice(0, 6)}</option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={() => {
                              const choices = node.choices.filter((_, i) => i !== idx)
                              updateNode(node.id, { choices })
                            }}
                            className="border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-text-dim)] hover:text-[var(--color-danger)]"
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>

                    <div className="space-y-1">
                      <label className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-faint)]">Tags (comma-separated)</label>
                      <input
                        type="text"
                        value={node.tags.join(', ')}
                        onChange={(e) => updateNode(node.id, {
                          tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean),
                        })}
                        className="w-full border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-xs text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none"
                      />
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
                      {!isRoot ? (
                        <button
                          type="button"
                          onClick={() => setRoot(node.id)}
                          className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-accent)]"
                        >
                          make root
                        </button>
                      ) : <span />}
                      <button
                        type="button"
                        onClick={() => deleteNode(node.id)}
                        className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-danger)]"
                      >
                        delete node
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
