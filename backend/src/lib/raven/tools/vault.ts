import { spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { nyToday } from '../../tasksStore.js'
import type { RavenToolCtx } from '../types.js'
import { filesUrl, thorGet } from './thorfiles.js'
import { clip, et, needBrendon, RavenToolError, toolRun } from './util.js'

// Brendon's Obsidian vault. The vault itself is on thor, and search, read,
// recent and list ask thor first (project-files GET /vault/*), so today's
// notes are there. When thor does not answer (off, asleep), they read odin's
// read-only copy instead (refreshed nightly, VAULT_DIR) and say so. A new note
// is written on thor (POST /vault/note); when thor does not answer, nothing is
// written and nothing is queued.
//
// The area folders are read at run time, never named here.

const vaultDir = () => process.env.RAVEN_VAULT_DIR || '/home/brendon/vault'
const rgBin = () => process.env.RAVEN_RG_BIN || '/usr/bin/rg'
/** The words a fallback answer carries. */
const copyNote = (why: string) => `odin's nightly copy: ${why}, so today's notes can be missing`

const MAX_HITS = 40
const READ_MAX = 60 * 1024
const RECENT_MAX = 40
const AREA_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/

async function root(): Promise<string> {
  try {
    return await fsp.realpath(vaultDir())
  } catch {
    throw new RavenToolError("the vault copy is not on odin (it is mirrored nightly from thor)")
  }
}

/** The top-level folders of the copy (the areas, the daily notes, the inbox...). */
async function areaDirs(r: string): Promise<string[]> {
  const out: string[] = []
  for (const d of await fsp.readdir(r, { withFileTypes: true })) {
    if (d.name.startsWith('.') || d.name.startsWith('_')) continue
    if (d.isDirectory() || (d.isSymbolicLink() && (await fsp.stat(path.join(r, d.name)).then((s) => s.isDirectory(), () => false)))) out.push(d.name)
  }
  return out.sort()
}

/** "work" or "10" or the folder's own name, to the folder. */
async function areaDir(r: string, area: string): Promise<string> {
  const dirs = await areaDirs(r)
  const a = area.trim().toLowerCase()
  const hit = dirs.find((d) => d.toLowerCase() === a)
    ?? dirs.find((d) => d.toLowerCase().replace(/^\d+-/, '') === a)
    ?? dirs.find((d) => /^\d+-/.test(d) && d.split('-')[0] === a)
  if (!hit) throw new RavenToolError(`no vault area "${area}". Areas: ${dirs.join(', ')}`)
  return hit
}

// A query reads as a regex only when it uses regex syntax a person would not type by accident.
export const looksLikeRegex = (q: string): boolean => /\\[bdwsBDWS]|\.\*|\.\+|\[[^\]]+\]|\(\?|\w\|\w|^\^|\$$/.test(q)

type Hit = { file: string; line: number; text: string }

function rg(r: string, query: string, where: string, fixed: boolean): Promise<{ hits: Hit[]; more: boolean; bad: boolean }> {
  return new Promise((resolve, reject) => {
    const args = [
      '--null', '--line-number', '--with-filename', '--no-heading', '--color', 'never', '--ignore-case',
      '--max-count', '5', '--max-columns', '300', '--max-columns-preview', '--sortr', 'modified', '--glob', '*.md',
      ...(fixed ? ['--fixed-strings'] : []), '--', query, where,
    ]
    const p = spawn(rgBin(), args, { cwd: r, stdio: ['ignore', 'pipe', 'pipe'] })
    const hits: Hit[] = []
    let more = false
    let buf = ''
    let err = ''
    const timer = setTimeout(() => p.kill('SIGKILL'), 15_000)
    const line = (l: string) => {
      const z0 = l.indexOf('\0')
      if (z0 < 0) return
      const m = /^(\d+):(.*)$/s.exec(l.slice(z0 + 1))
      if (!m) return
      if (hits.length >= MAX_HITS) { more = true; p.kill('SIGTERM'); return }
      hits.push({ file: l.slice(0, z0).replace(/^\.\//, ''), line: Number(m[1]), text: clip(m[2].trim(), 240) })
    }
    p.stdout.setEncoding('utf8')
    p.stdout.on('data', (d: string) => {
      buf += d
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1) }
    })
    p.stderr.on('data', (d) => { err += String(d) })
    p.on('error', (e) => { clearTimeout(timer); reject(new RavenToolError(`vault search could not run (${e.message})`)) })
    p.on('close', (code) => {
      clearTimeout(timer)
      if (buf) line(buf)
      // 1 is "no match"; 2 with a regex is a pattern rg could not read
      resolve({ hits, more, bad: code === 2 && !fixed && hits.length === 0 && /regex|parse/i.test(err) })
    })
  })
}

/** The path inside the copy, or a refusal. Symlinks are followed and must stay inside too. */
async function inside(r: string, rel: string): Promise<string> {
  const lexical = path.resolve(r, rel)
  if (lexical !== r && !lexical.startsWith(r + path.sep)) throw new RavenToolError('that path is outside the vault')
  let real: string
  try {
    real = await fsp.realpath(lexical)
  } catch {
    throw new RavenToolError(`no note at ${rel}`)
  }
  if (!real.startsWith(r + path.sep)) throw new RavenToolError('that path is outside the vault')
  return real
}

async function walk(r: string): Promise<string[]> {
  const all = await fsp.readdir(r, { recursive: true }) as string[]
  return all.filter((f) => f.endsWith('.md') && !f.split(path.sep).some((p) => p.startsWith('.')))
}

/** A note's path from what Raven has: a path, a path without .md, a [[wiki link]], or a bare note name. */
async function findNote(r: string, given: string): Promise<string> {
  let rel = given.trim().replace(/^\[\[|\]\]$/g, '').replace(/[|#].*$/, '').trim()
  if (!rel) throw new RavenToolError('name a note')
  const base = vaultDir().replace(/\/+$/, '')
  if (path.isAbsolute(rel)) {
    if (rel.startsWith(`${base}/`)) rel = rel.slice(base.length + 1)
    else if (rel.startsWith(`${r}/`)) rel = rel.slice(r.length + 1)
    else throw new RavenToolError('that path is outside the vault')
  }
  const tries = path.extname(rel) ? [rel] : [rel, `${rel}.md`]
  for (const t of tries) {
    const lexical = path.resolve(r, t)
    if (lexical !== r && !lexical.startsWith(r + path.sep)) throw new RavenToolError('that path is outside the vault')
    if (await fsp.stat(lexical).then((s) => s.isFile(), () => false)) return inside(r, t)
  }
  if (!rel.includes('/')) {
    const want = (path.extname(rel) ? rel : `${rel}.md`).toLowerCase()
    const hit = (await walk(r)).find((f) => path.basename(f).toLowerCase() === want)
    if (hit) return inside(r, hit)
  }
  return inside(r, tries[tries.length - 1])
}

const DATE_RE = /^(\d{4}-\d{2}-\d{2})/

async function titleOf(file: string, fallback: string): Promise<string> {
  try {
    const fh = await fsp.open(file, 'r')
    try {
      const buf = Buffer.alloc(1024)
      const { bytesRead } = await fh.read(buf, 0, 1024, 0)
      const head = buf.subarray(0, bytesRead).toString('utf8')
      const m = /^title:\s*["']?(.+?)["']?\s*$/m.exec(head)
      return m ? m[1] : fallback
    } finally {
      await fh.close()
    }
  } catch {
    return fallback
  }
}

export function registerVaultTools(server: McpServer, ctx: RavenToolCtx): void {
  server.registerTool('vault_search', {
    description: "Search Brendon's Obsidian vault, live on thor (odin's nightly copy only when thor does not answer, and the answer says so). "
      + 'Case-insensitive; plain text unless the query is clearly a regex. area narrows it to one top folder ("work", "daily", or the folder '
      + 'name). Newest notes first, up to 40 hits. For his other files on thor use thor_files_search.',
    inputSchema: { query: z.string().min(2).max(200), area: z.string().max(40).optional(), limit: z.number().int().min(1).max(MAX_HITS).optional() },
  }, (a) => toolRun(async () => {
    const live = await thorGet<{ hits: Hit[]; more?: boolean; area?: string }>('/vault/search', {
      q: a.query, area: a.area, limit: a.limit, mode: looksLikeRegex(a.query) ? 'regex' : 'text',
    })
    if (live.ok) {
      if (!live.body.hits.length) return `No note in the vault${a.area ? ` (${live.body.area ?? a.area})` : ''} has "${a.query}".`
      return { hits: live.body.hits, more: live.body.more }
    }
    const r = await root()
    const where = a.area ? await areaDir(r, a.area) : '.'
    const regex = looksLikeRegex(a.query)
    let res = await rg(r, a.query, where, !regex)
    if (res.bad) res = await rg(r, a.query, where, true)
    const hits = res.hits.slice(0, a.limit ?? MAX_HITS)
    if (!hits.length) return `No note in the vault${a.area ? ` (${where})` : ''} has "${a.query}" (${copyNote(live.why)}).`
    return { hits, more: res.more || hits.length < res.hits.length || undefined, source: copyNote(live.why) }
  }))

  server.registerTool('vault_read', {
    description: 'Read one vault note, live on thor, by its path from vault_search, vault_recent or vault_list (a [[wiki link]] or a bare note '
      + "name works too), 60 KB a call (offset reads on). Falls back to odin's nightly copy when thor does not answer.",
    inputSchema: { path: z.string().min(1).max(400), offset: z.number().int().min(0).optional() },
  }, (a) => toolRun(async () => {
    const live = await thorGet<{ path: string; text: string; next?: number | null; size: number }>('/vault/read', { path: a.path, offset: a.offset })
    if (live.ok) {
      const b = live.body
      return `${b.path}\n\n${b.text}${b.next != null ? `\n\n[more: call again with offset ${b.next} of ${b.size} bytes]` : ''}`
    }
    const r = await root()
    const file = await findNote(r, a.path)
    const st = await fsp.stat(file)
    if (!st.isFile()) throw new RavenToolError(`${a.path} is a folder; vault_search or vault_recent lists notes`)
    const fh = await fsp.open(file, 'r')
    let buf: Buffer
    try {
      buf = Buffer.alloc(Math.min(st.size, READ_MAX))
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
      buf = buf.subarray(0, bytesRead)
    } finally {
      await fh.close()
    }
    if (buf.includes(0)) throw new RavenToolError(`${path.relative(r, file)} is not a text note`)
    const text = buf.toString('utf8')
    return `${path.relative(r, file)}\n\n${text}${st.size > READ_MAX ? `\n\n[cut at 60 KB of ${Math.round(st.size / 1024)} KB]` : ''}\n\n[${copyNote(live.why)}]`
  }))

  server.registerTool('vault_list', {
    description: 'List one folder of the vault, live on thor (no path: the top folders, the areas). Notes and subfolders, with when each note changed.',
    inputSchema: { path: z.string().max(400).optional() },
  }, (a) => toolRun(async () => {
    const rel = a.path?.trim().replace(/^\/+|\/+$/g, '') ?? ''
    const live = await thorGet<{ rel: string; entries: { name: string; dir: boolean; size: number; mtime: number }[]; truncated?: boolean }>('/vault/list', { rel })
    if (live.ok) {
      return {
        folder: live.body.rel || '(the vault)',
        entries: live.body.entries.map((e) => (e.dir ? `${e.name}/` : `${e.name} (changed ${et(e.mtime)})`)),
        truncated: live.body.truncated,
      }
    }
    const r = await root()
    const dir = rel ? await inside(r, rel) : r
    const ents = await fsp.readdir(dir, { withFileTypes: true }).catch(() => { throw new RavenToolError(`no vault folder at ${rel}`) })
    return {
      folder: rel || '(the vault)',
      entries: ents.filter((d) => !d.name.startsWith('.')).map((d) => (d.isDirectory() ? `${d.name}/` : d.name)).sort(),
      source: copyNote(live.why),
    }
  }))

  server.registerTool('vault_recent', {
    description: 'The vault notes changed in the last few days, newest first, live on thor (session notes, daily notes, anything he edited). '
      + "Falls back to odin's nightly copy (session and daily notes only) when thor does not answer.",
    inputSchema: { days: z.number().int().min(1).max(30).optional() },
  }, (a) => toolRun(async () => {
    const live = await thorGet<{ notes: { path: string; mtime: number; title: string }[]; more?: boolean }>('/vault/recent', { days: a.days ?? 3 })
    if (live.ok) return { notes: live.body.notes.map((n) => ({ path: n.path, title: n.title, changed: et(n.mtime) })), more: live.body.more }
    const r = await root()
    const cutoff = nyToday(Date.now() - (a.days ?? 3) * 86_400_000)
    const notes = (await walk(r)).flatMap((f) => {
      const base = path.basename(f)
      const date = DATE_RE.exec(base)?.[1]
      const daily = /^\d{4}-\d{2}-\d{2}\.md$/.test(base)
      const session = f.split(path.sep).includes('Sessions')
      return date && date >= cutoff && (daily || session) ? [{ f, date, daily }] : []
    })
    const withTime = await Promise.all(notes.map(async (n) => ({ ...n, mtime: await fsp.stat(path.join(r, n.f)).then((s) => s.mtimeMs, () => 0) })))
    withTime.sort((x, y) => y.date.localeCompare(x.date) || y.mtime - x.mtime)
    const top = withTime.slice(0, RECENT_MAX)
    const out = await Promise.all(top.map(async (n) => ({
      path: n.f.split(path.sep).join('/'),
      kind: n.daily ? 'daily' : 'session',
      date: n.date,
      title: n.daily ? n.date : await titleOf(path.join(r, n.f), path.basename(n.f, '.md').replace(DATE_RE, '').replace(/^-/, '').replace(/-/g, ' ')),
    })))
    const today = nyToday()
    return { notes: out, more: withTime.length > RECENT_MAX || undefined, source: copyNote(live.why), note: out.some((n) => n.date === today) ? undefined : 'nothing from today in the copy' }
  }))

  server.registerTool('vault_note', {
    description: 'Write a NEW note into the vault on thor (title, markdown text, optional area folder). Fails, with nothing queued, when thor does not answer. '
      + "Only when Brendon's message asks.",
    inputSchema: { title: z.string().min(1).max(120), text: z.string().min(1).max(20_000), area: z.string().max(40).optional() },
  }, (a) => toolRun(async () => {
    needBrendon(ctx, 'Writing a vault note')
    // thor turns area into a folder of the vault: one folder name, never a path
    const area = a.area?.trim() || undefined
    if (area !== undefined && !AREA_RE.test(area)) throw new RavenToolError('area is one vault folder name ("work", "inbox" or a folder like 10-Work), not a path')
    const token = process.env.PROJECT_FILES_TOKEN || ''
    if (!token) throw new RavenToolError("thor's file service is not set up on odin (PROJECT_FILES_TOKEN), so the note was not written")
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 15_000)
    let status = 0
    type NoteAnswer = { path?: unknown; error?: unknown }
    let body: NoteAnswer | null = null
    try {
      const r = await fetch(`${filesUrl()}/vault/note`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ title: a.title, text: a.text, area }),
        signal: ac.signal,
      })
      status = r.status
      body = await r.json().catch(() => null) as NoteAnswer | null
    } catch {
      throw new RavenToolError('thor is not answering (it can be off or asleep), so the note was not written. Nothing is queued.')
    } finally {
      clearTimeout(timer)
    }
    if (status === 404 && !body?.path) throw new RavenToolError("thor's file service cannot write vault notes yet, so the note was not written")
    if (status !== 200 && status !== 201) throw new RavenToolError(`thor did not write the note: ${typeof body?.error === 'string' ? body.error : `answered ${status}`}`)
    if (typeof body?.path !== 'string') throw new RavenToolError('thor answered without a path; the note may not exist')
    ctx.acted()
    return { written: body.path, note: 'on thor now (vault_read reads it there at once); the copy on odin gets it tonight' }
  }))
}
