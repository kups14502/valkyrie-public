import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { RavenToolCtx } from '../types.js'
import { et, needBrendon, RavenToolError, toolRun } from './util.js'

// Brendon's own files on thor, live and read-only, through thor's project-files
// service (GET /files/list, /files/read, /files/search; the vault's routes are
// used by vault.ts). thor allows his Documents, Desktop and Downloads and
// C:\Thor, refuses the places secrets live (C:\Thor\secrets, AppData, .ssh,
// key and token files, .env) and redacts secrets in what it sends. A file is
// read 60 KB a call; a .docx comes as its text; other binaries only say what
// they are. These tools run only in a run Brendon's own message started.

export const filesUrl = (): string => process.env.PROJECT_FILES_URL
  || `http://${process.env.THOR_LAUNCHER_HOST || '100.118.7.57'}:8767`

/** thor answered: its JSON. thor did not (off, asleep, no token, an older service without the route): why, for a fallback. */
export type ThorAnswer<T> = { ok: true; body: T } | { ok: false; why: string }

/**
 * A GET on thor's file service. A refusal thor gives (403, a missing file, a
 * bad path) throws RavenToolError with thor's own words; only "not reachable"
 * comes back as { ok: false }, so the vault can fall back to odin's copy.
 */
export async function thorGet<T>(route: string, params: Record<string, string | number | boolean | undefined>, timeoutMs = 25_000): Promise<ThorAnswer<T>> {
  const token = process.env.PROJECT_FILES_TOKEN || ''
  if (!token) return { ok: false, why: "thor's file service is not set up on odin (PROJECT_FILES_TOKEN)" }
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '' && v !== false) q.set(k, v === true ? '1' : String(v))
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  let status = 0
  let body: unknown = null
  try {
    const r = await fetch(`${filesUrl()}${route}?${q}`, { headers: { Authorization: `Bearer ${token}` }, signal: ac.signal })
    status = r.status
    body = await r.json().catch(() => null)
  } catch (e) {
    return { ok: false, why: (e as Error).name === 'AbortError' ? 'thor took too long to answer' : 'thor is not answering (it can be off or asleep)' }
  } finally {
    clearTimeout(timer)
  }
  const error = (body as { error?: unknown } | null)?.error
  // an older service, or anything that is not thor's file service, answers a bare 404
  if (status === 404 && (body === null || error === 'not found')) return { ok: false, why: "thor's file service does not have this route yet" }
  if (status === 401) return { ok: false, why: "thor refused odin's token" }
  if (status !== 200) throw new RavenToolError(`thor: ${typeof error === 'string' ? error : `answered ${status}`}`)
  return { ok: true, body: body as T }
}

/** thor's answer or a RavenToolError: for the file tools, which have no copy to fall back to. */
async function mustGet<T>(route: string, params: Record<string, string | number | boolean | undefined>): Promise<T> {
  const r = await thorGet<T>(route, params)
  if (!r.ok) throw new RavenToolError(`${r.why}, so his files on thor cannot be read right now`)
  return r.body
}

type Entry = { name: string; dir: boolean; size: number; mtime: number }
type Read = { path: string; size: number; mtime: number; offset?: number; next?: number | null; text?: string; binary?: boolean; type?: string; from?: string }

const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

export function registerThorFileTools(server: McpServer, ctx: RavenToolCtx): void {
  server.registerTool('thor_files', {
    description: "List a folder of Brendon's own files on thor, his PC, live. No path: the folders you can read (his Documents, Desktop, Downloads, "
      + 'C:\\Thor). A path is absolute (C:\\Users\\Brendon\\Documents\\Resume) or starts with a root label (Documents\\Resume). Places secrets live '
      + 'are never shown. For notes in his Obsidian vault use the vault_* tools instead.',
    inputSchema: { path: z.string().max(1024).optional() },
  }, (a) => toolRun(async () => {
    needBrendon(ctx, "Reading thor's files")
    const body = await mustGet<{ roots?: { label: string; path: string }[]; vault?: string; path?: string; entries?: Entry[]; truncated?: boolean }>('/files/list', { path: a.path?.trim() || undefined })
    if (body.roots) return { roots: body.roots, vault: body.vault, note: 'list one with path; the vault has its own tools (vault_search, vault_read, vault_list)' }
    return {
      path: body.path,
      entries: (body.entries ?? []).map((e) => (e.dir ? { name: `${e.name}\\`, changed: et(e.mtime) } : { name: e.name, size: kb(e.size), changed: et(e.mtime) })),
      truncated: body.truncated,
    }
  }))

  server.registerTool('thor_file_read', {
    description: "Read one of Brendon's files on thor, live: a text file, or a Word .docx as its text, 60 KB a call (pass offset from the last call's "
      + "next to read on). Other binaries (PDF, images) only say their type and size. Secrets in the text come back as [REDACTED]. Use the path "
      + 'thor_files or thor_files_search gave you.',
    inputSchema: { path: z.string().min(1).max(1024), offset: z.number().int().min(0).optional() },
  }, (a) => toolRun(async () => {
    needBrendon(ctx, "Reading thor's files")
    const r = await mustGet<Read>('/files/read', { path: a.path.trim(), offset: a.offset })
    if (r.binary) return `${r.path} is a .${r.type} file (${kb(r.size)}, changed ${et(r.mtime)}): not readable as text here. If he needs its contents, he can send it to you as an attachment.`
    const more = r.next != null ? `\n\n[more: call again with offset ${r.next}${r.from === 'docx' ? '' : ` of ${r.size} bytes`}]` : ''
    return `${r.path} (changed ${et(r.mtime)})\n\n${r.text ?? ''}${more}`
  }))

  server.registerTool('thor_files_search', {
    description: "Find Brendon's files on thor, live, by name (part of the name, or a pattern like *.docx); content true also searches inside text "
      + 'files. in narrows it to one folder (much faster than every root). Newest first, up to 40. A search of everything stops after about 12 '
      + 'seconds and says partial.',
    inputSchema: { query: z.string().min(2).max(200), in: z.string().max(1024).optional(), content: z.boolean().optional() },
  }, (a) => toolRun(async () => {
    needBrendon(ctx, "Searching thor's files")
    const r = await mustGet<{ files: { path: string; size: number; mtime: number }[]; lines?: { file: string; line: number; text: string }[]; more?: boolean; partial?: boolean }>(
      '/files/search', { q: a.query, in: a.in?.trim() || undefined, content: a.content || undefined },
    )
    if (!r.files.length && !r.lines?.length) return `No file on thor${a.in ? ` under ${a.in}` : ''} matches "${a.query}"${r.partial ? ' (partial: the search stopped early; narrow it with in)' : ''}.`
    return {
      files: r.files.map((f) => ({ path: f.path, size: kb(f.size), changed: et(f.mtime) })),
      lines: r.lines?.length ? r.lines : undefined,
      more: r.more,
      partial: r.partial ? 'the search stopped early; narrow it with in' : undefined,
    }
  }))
}
