import { Router } from 'express'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const router = Router()

const FILE = '/home/brendon/game/narrative.json'

type Choice = { label: string; targetId: string | null }
type Node = {
  id: string
  title: string
  body: string
  choices: Choice[]
  tags: string[]
  createdAt: string
  updatedAt: string
}
type Tree = {
  version: number
  rootId: string | null
  nodes: Node[]
}

const EMPTY_TREE: Tree = { version: 1, rootId: null, nodes: [] }

async function readTree(): Promise<Tree> {
  try {
    const raw = await fs.readFile(FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<Tree>
    return {
      version: typeof parsed.version === 'number' ? parsed.version : 1,
      rootId: typeof parsed.rootId === 'string' ? parsed.rootId : null,
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes as Node[] : [],
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY_TREE
    throw err
  }
}

async function writeTree(tree: Tree): Promise<void> {
  await fs.mkdir(path.dirname(FILE), { recursive: true })
  await fs.writeFile(FILE, JSON.stringify(tree, null, 2), 'utf8')
}

function validate(tree: unknown): tree is Tree {
  if (!tree || typeof tree !== 'object') return false
  const t = tree as Tree
  if (typeof t.version !== 'number') return false
  if (t.rootId !== null && typeof t.rootId !== 'string') return false
  if (!Array.isArray(t.nodes)) return false
  for (const n of t.nodes) {
    if (typeof n.id !== 'string' || !n.id) return false
    if (typeof n.title !== 'string') return false
    if (typeof n.body !== 'string') return false
    if (!Array.isArray(n.choices)) return false
    for (const c of n.choices) {
      if (typeof c.label !== 'string') return false
      if (c.targetId !== null && typeof c.targetId !== 'string') return false
    }
    if (!Array.isArray(n.tags)) return false
  }
  return true
}

router.get('/narrative', async (_req, res) => {
  try {
    const tree = await readTree()
    res.json(tree)
  } catch (err) {
    res.status(500).json({ error: 'failed to read narrative', detail: (err as Error).message })
  }
})

router.put('/narrative', async (req, res) => {
  const incoming = req.body
  if (!validate(incoming)) {
    return res.status(400).json({ error: 'invalid tree shape' })
  }
  const now = new Date().toISOString()
  const existing = await readTree().catch(() => EMPTY_TREE)
  const existingById = new Map(existing.nodes.map((n) => [n.id, n]))
  const normalised: Node[] = incoming.nodes.map((n) => {
    const prev = existingById.get(n.id)
    return {
      ...n,
      id: n.id || randomUUID(),
      createdAt: prev?.createdAt ?? n.createdAt ?? now,
      updatedAt: now,
    }
  })
  const tree: Tree = {
    version: 1,
    rootId: incoming.rootId,
    nodes: normalised,
  }
  try {
    await writeTree(tree)
    res.json(tree)
  } catch (err) {
    res.status(500).json({ error: 'failed to write narrative', detail: (err as Error).message })
  }
})

export default router
