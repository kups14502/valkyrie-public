import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { KEY_RE, MIXABLE_AREAS, type Area } from './projectTypes.js'

// odin's private area table, ~/.config/valkyrie/project-areas.json, next to the
// public-guard denylist and for the same reason: the names in it are
// businesses. It holds the client areas a project can sit in (display order)
// and rules that move a session row into one of them by its cwd:
//
//   { "clientAreas": ["work"],
//     "sessionRules": [{ "match": "<regex on cwd>", "fromArea": "work", "area": "..." }] }
//
// A rule needs every condition it names; the first that matches wins. thor's
// capture table routes two businesses to one 'work' area, which is right for the
// vault and wrong for a project page that must keep their clients apart, so the
// split happens here and the capture routing stays as it is.
//
// Read once at start: restart the API after an edit. A missing or broken file
// means one client area, 'work', and no rules.

type Rule = { re: RegExp | null; fromArea: string | null; area: Area }

const FILE = process.env.PROJECT_AREAS_FILE || path.join(homedir(), '.config', 'valkyrie', 'project-areas.json')

function load(): { clientAreas: Area[]; rules: Rule[] } {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(FILE, 'utf8'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[areas] unreadable', FILE, (e as Error).message)
    return { clientAreas: ['work'], rules: [] }
  }
  const o = (raw && typeof raw === 'object' ? raw : {}) as { clientAreas?: unknown; sessionRules?: unknown }
  const clientAreas = (Array.isArray(o.clientAreas) ? o.clientAreas : [])
    .filter((a): a is string => typeof a === 'string' && KEY_RE.test(a) && !MIXABLE_AREAS.includes(a))
  const rules: Rule[] = []
  for (const r of Array.isArray(o.sessionRules) ? o.sessionRules : []) {
    const x = (r && typeof r === 'object' ? r : {}) as { match?: unknown; fromArea?: unknown; area?: unknown }
    if (typeof x.area !== 'string' || !KEY_RE.test(x.area)) continue
    let re: RegExp | null = null
    if (typeof x.match === 'string') {
      try { re = new RegExp(x.match, 'i') } catch { console.warn('[areas] bad match regex for', x.area); continue }
    }
    rules.push({ re, fromArea: typeof x.fromArea === 'string' ? x.fromArea : null, area: x.area })
  }
  return { clientAreas: clientAreas.length ? [...new Set(clientAreas)] : ['work'], rules }
}

const cfg = load()

export const AREAS: readonly Area[] = [...MIXABLE_AREAS, ...cfg.clientAreas]

// The area a session row is shown under, for the board and for linking it to a
// project. The host's own area when no rule applies.
export function sessionArea(area: string, cwd: string | null | undefined): string {
  for (const r of cfg.rules) {
    if (r.fromArea !== null && r.fromArea !== area) continue
    if (r.re && !r.re.test(cwd ?? '')) continue
    return r.area
  }
  return area
}
