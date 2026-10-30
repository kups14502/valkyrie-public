import { readFileSync } from 'node:fs'
import path from 'node:path'
import { CONF_DIR, franchiseConf, franchiseKeys } from './workConfig.js'

// Autotask for the work agents: each franchise's own PSA instance, read and
// (on Brendon's approval only) written. Franchises run separate Autotask
// instances, not companies in one, so ids (companies, resources, queues) mean
// nothing across them: every call names its franchise, and nothing here ever
// falls back from one to another.
//
// Which franchises exist, and everything named about them, is in odin's
// private work-agents.json (lib/workConfig.ts). Each one's credentials are a
// file beside it, mode 600, holding AUTOTASK_ZONE_URL,
// AUTOTASK_INTEGRATION_CODE, AUTOTASK_USERNAME and AUTOTASK_SECRET.

export type Franchise = string
export const franchises = franchiseKeys

export class PsaError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

type Meta = { file: string; label: string; brendon: number; role?: number; category?: number; web: string }

function meta(f: Franchise): Meta {
  const c = franchiseConf(f)
  if (!c) throw new PsaError(404, `no franchise ${f}`)
  return { file: c.envFile, label: c.label, brendon: c.brendonResource, role: c.brendonRole, category: c.ticketCategory, web: c.web }
}

export const franchiseLabel = (f: Franchise) => franchiseConf(f)?.label ?? f
export const brendonResource = (f: Franchise) => meta(f).brendon
export const ticketUrl = (f: Franchise, id: number) =>
  `${meta(f).web}/Autotask/AutotaskExtend/ExecuteCommand.aspx?Code=OpenTicketDetail&TicketID=${id}`

type Creds = { base: string; headers: Record<string, string> }
const credCache = new Map<Franchise, Creds>()

function creds(f: Franchise): Creds {
  const hit = credCache.get(f)
  if (hit) return hit
  let raw = ''
  try {
    raw = readFileSync(path.join(CONF_DIR, meta(f).file), 'utf8')
  } catch {
    throw new PsaError(503, `${meta(f).label} Autotask is not configured on odin (${meta(f).file} missing)`)
  }
  const env: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#') || !t.includes('=')) continue
    env[t.slice(0, t.indexOf('=')).trim()] = t.slice(t.indexOf('=') + 1).trim()
  }
  const base = (env.AUTOTASK_ZONE_URL || '').replace(/\/$/, '')
  if (!base || !env.AUTOTASK_INTEGRATION_CODE || !env.AUTOTASK_USERNAME || !env.AUTOTASK_SECRET) {
    throw new PsaError(503, `${meta(f).label} Autotask credentials are incomplete in ${meta(f).file}`)
  }
  const c: Creds = {
    base,
    headers: {
      ApiIntegrationCode: env.AUTOTASK_INTEGRATION_CODE,
      UserName: env.AUTOTASK_USERNAME,
      Secret: env.AUTOTASK_SECRET,
      'Content-Type': 'application/json',
    },
  }
  credCache.set(f, c)
  return c
}

/** True when the franchise's credential file is present (the poller skips the other). */
export function psaConfigured(f: Franchise): boolean {
  try { creds(f); return true } catch { return false }
}

async function at<T>(f: Franchise, pathOrUrl: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<T> {
  const c = creds(f)
  const url = pathOrUrl.startsWith('https://') ? pathOrUrl : c.base + pathOrUrl
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), init.timeoutMs ?? 25_000)
  let r: globalThis.Response
  try {
    r = await fetch(url, {
      method: init.method ?? 'GET',
      headers: { ...c.headers, ...(init.headers ?? {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: ac.signal,
    })
  } catch (e) {
    throw new PsaError(502, `${meta(f).label} Autotask did not answer (${(e as Error).name === 'AbortError' ? 'timed out' : (e as Error).message})`)
  } finally {
    clearTimeout(timer)
  }
  const text = await r.text()
  if (!r.ok) {
    let msg = text.slice(0, 300)
    try {
      const j = JSON.parse(text) as { errors?: string[] }
      if (j.errors?.length) msg = j.errors.join('; ').slice(0, 300)
    } catch { /* not json */ }
    throw new PsaError(r.status >= 500 ? 502 : r.status, `${meta(f).label} Autotask ${r.status}: ${msg || r.statusText}`)
  }
  return (text ? JSON.parse(text) : {}) as T
}

type Filter = { op: string; field?: string; value?: unknown; items?: Filter[] }
type Page<T> = { items?: T[]; item?: T; pageDetails?: { nextPageUrl?: string | null } }

/** An Autotask query, following pages up to maxItems. */
async function query<T>(f: Franchise, entity: string, filter: Filter[], opts: { fields?: string[]; maxItems?: number } = {}): Promise<T[]> {
  const out: T[] = []
  const max = opts.maxItems ?? 500
  let page = await at<Page<T>>(f, `/${entity}/query`, {
    method: 'POST',
    body: { filter, MaxRecords: Math.min(500, max), ...(opts.fields ? { IncludeFields: opts.fields } : {}) },
  })
  for (;;) {
    out.push(...(page.items ?? []))
    const next = page.pageDetails?.nextPageUrl
    if (!next || out.length >= max) break
    page = await at<Page<T>>(f, next)
  }
  return out.slice(0, max)
}

// ---------------------------------------------------------- picklists ----

type Pick = { value: string; label: string; isActive: boolean }
type Picklists = { status: Map<number, string>; priority: Map<number, string>; queue: Map<number, string>; at: number }
const PICK_TTL = 6 * 3_600_000
const pickCache = new Map<Franchise, Picklists>()

export async function picklists(f: Franchise): Promise<Picklists> {
  const hit = pickCache.get(f)
  if (hit && Date.now() - hit.at < PICK_TTL) return hit
  const info = await at<{ fields: { name: string; picklistValues?: Pick[] }[] }>(f, '/Tickets/entityInformation/fields')
  const map = (name: string) => new Map((info.fields.find((x) => x.name === name)?.picklistValues ?? [])
    .map((v) => [Number(v.value), v.label] as const))
  const p: Picklists = { status: map('status'), priority: map('priority'), queue: map('queueID'), at: Date.now() }
  pickCache.set(f, p)
  return p
}

const valueOf = (m: Map<number, string>, label: string): number | null => {
  for (const [k, v] of m) if (v.toLowerCase() === label.toLowerCase()) return k
  return null
}

export async function statusValue(f: Franchise, label: string): Promise<number> {
  const v = valueOf((await picklists(f)).status, label)
  if (v === null) throw new PsaError(400, `${meta(f).label} Autotask has no status "${label}"`)
  return v
}

/** The status and queue labels, so an agent can name them. */
export async function labels(f: Franchise): Promise<{ statuses: string[]; priorities: string[]; queues: string[] }> {
  const p = await picklists(f)
  return { statuses: [...p.status.values()], priorities: [...p.priority.values()], queues: [...p.queue.values()] }
}

// ------------------------------------------------------ names, cached ----

const NAME_TTL = 6 * 3_600_000
const companyCache = new Map<Franchise, { at: number; byId: Map<number, { name: string; web: string; active: boolean }> }>()
const resourceCache = new Map<Franchise, { at: number; byId: Map<number, string> }>()

export async function companies(f: Franchise): Promise<Map<number, { name: string; web: string; active: boolean }>> {
  const hit = companyCache.get(f)
  if (hit && Date.now() - hit.at < NAME_TTL) return hit.byId
  const rows = await query<{ id: number; companyName: string; webAddress: string | null; isActive: boolean }>(
    f, 'Companies', [{ op: 'gte', field: 'id', value: 0 }], { fields: ['id', 'companyName', 'webAddress', 'isActive'], maxItems: 3000 })
  const byId = new Map(rows.map((c) => [c.id, { name: c.companyName, web: c.webAddress ?? '', active: c.isActive }]))
  companyCache.set(f, { at: Date.now(), byId })
  return byId
}

export async function resources(f: Franchise): Promise<Map<number, string>> {
  const hit = resourceCache.get(f)
  if (hit && Date.now() - hit.at < NAME_TTL) return hit.byId
  const rows = await query<{ id: number; firstName: string; lastName: string }>(
    f, 'Resources', [{ op: 'gte', field: 'id', value: 0 }], { fields: ['id', 'firstName', 'lastName'], maxItems: 500 })
  const byId = new Map(rows.map((r) => [r.id, `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim()]))
  resourceCache.set(f, { at: Date.now(), byId })
  return byId
}

export async function findCompanies(f: Franchise, text: string): Promise<{ id: number; name: string; active: boolean }[]> {
  const needle = text.trim().toLowerCase()
  if (!needle) return []
  return [...(await companies(f)).entries()]
    .filter(([, c]) => c.name.toLowerCase().includes(needle))
    .slice(0, 20)
    .map(([id, c]) => ({ id, name: c.name, active: c.active }))
}

export type Contact = { id: number; companyId: number; company: string; name: string; email: string; active: boolean }

type ContactRow = { id: number; companyID: number; firstName: string; lastName: string; emailAddress: string | null; isActive: number | boolean }

async function toContacts(f: Franchise, rows: ContactRow[]): Promise<Contact[]> {
  const co = await companies(f)
  return rows.map((c) => ({
    id: c.id, companyId: c.companyID, company: co.get(c.companyID)?.name ?? `company ${c.companyID}`,
    name: `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim(), email: c.emailAddress ?? '', active: Boolean(c.isActive),
  }))
}

export async function contactsByEmail(f: Franchise, email: string): Promise<Contact[]> {
  const e = email.trim()
  if (!e.includes('@')) return []
  const rows = await query<ContactRow>(f, 'Contacts', [{ op: 'eq', field: 'emailAddress', value: e }],
    { fields: ['id', 'companyID', 'firstName', 'lastName', 'emailAddress', 'isActive'], maxItems: 10 })
  return toContacts(f, rows)
}

/** Every active contact's email, for routing mail by sender (the poller refreshes it daily). */
export async function allContacts(f: Franchise): Promise<Contact[]> {
  const rows = await query<ContactRow>(f, 'Contacts', [{ op: 'eq', field: 'isActive', value: 1 }],
    { fields: ['id', 'companyID', 'firstName', 'lastName', 'emailAddress', 'isActive'], maxItems: 5000 })
  return toContacts(f, rows.filter((c) => c.emailAddress))
}

// ------------------------------------------------------------ tickets ----

export type TicketRow = {
  id: number; ticketNumber: string; title: string; description: string | null
  status: number; priority: number; queueID: number | null; companyID: number; contactID: number | null
  assignedResourceID: number | null; createDate: string; lastActivityDate: string | null
  dueDateTime: string | null; completedDate: string | null
}

const TICKET_FIELDS = ['id', 'ticketNumber', 'title', 'description', 'status', 'priority', 'queueID', 'companyID', 'contactID',
  'assignedResourceID', 'createDate', 'lastActivityDate', 'dueDateTime', 'completedDate']

export type Ticket = {
  franchise: Franchise; id: number; number: string; title: string; description: string
  status: string; statusValue: number; priority: string; queue: string; queueId: number | null
  companyId: number; company: string; contactId: number | null; assignee: string | null; assigneeId: number | null
  mine: boolean; created: string; lastActivity: string | null; due: string | null; completed: string | null; url: string
}

export async function describe(f: Franchise, rows: TicketRow[]): Promise<Ticket[]> {
  const [p, co, res] = await Promise.all([picklists(f), companies(f), resources(f)])
  return rows.map((t) => ({
    franchise: f, id: t.id, number: t.ticketNumber, title: t.title ?? '', description: (t.description ?? '').slice(0, 4000),
    status: p.status.get(t.status) ?? String(t.status), statusValue: t.status,
    priority: p.priority.get(t.priority) ?? String(t.priority),
    queue: t.queueID ? p.queue.get(t.queueID) ?? String(t.queueID) : '', queueId: t.queueID,
    companyId: t.companyID, company: co.get(t.companyID)?.name ?? `company ${t.companyID}`, contactId: t.contactID,
    assignee: t.assignedResourceID ? res.get(t.assignedResourceID) ?? String(t.assignedResourceID) : null,
    assigneeId: t.assignedResourceID, mine: t.assignedResourceID === meta(f).brendon,
    created: t.createDate, lastActivity: t.lastActivityDate, due: t.dueDateTime, completed: t.completedDate,
    url: ticketUrl(f, t.id),
  }))
}

/** The queue every franchise skips: monitoring noise, hundreds of open tickets at one franchise. */
export async function monitoringQueue(f: Franchise): Promise<number | null> {
  return valueOf((await picklists(f)).queue, 'Monitoring Alert')
}

/** Every open ticket outside the monitoring queue. */
export async function openTickets(f: Franchise): Promise<Ticket[]> {
  const complete = await statusValue(f, 'Complete')
  const mon = await monitoringQueue(f)
  const filter: Filter[] = [{ op: 'noteq', field: 'status', value: complete }]
  if (mon !== null) filter.push({ op: 'noteq', field: 'queueID', value: mon })
  return describe(f, await query<TicketRow>(f, 'Tickets', filter, { fields: TICKET_FIELDS, maxItems: 1500 }))
}

/** Tickets with activity after an instant, any status, outside the monitoring queue. */
export async function ticketsChangedSince(f: Franchise, iso: string): Promise<Ticket[]> {
  const mon = await monitoringQueue(f)
  const filter: Filter[] = [{ op: 'gt', field: 'lastActivityDate', value: iso }]
  if (mon !== null) filter.push({ op: 'noteq', field: 'queueID', value: mon })
  return describe(f, await query<TicketRow>(f, 'Tickets', filter, { fields: TICKET_FIELDS, maxItems: 500 }))
}

export async function getTicket(f: Franchise, idOrNumber: string | number): Promise<Ticket> {
  const s = String(idOrNumber).trim()
  const filter: Filter[] = /^T\d{8}\.\d{4}$/i.test(s)
    ? [{ op: 'eq', field: 'ticketNumber', value: s.toUpperCase() }]
    : /^\d+$/.test(s) ? [{ op: 'eq', field: 'id', value: Number(s) }] : []
  if (!filter.length) throw new PsaError(400, 'pass a ticket id or a number like T20261029.0001')
  const rows = await query<TicketRow>(f, 'Tickets', filter, { fields: TICKET_FIELDS, maxItems: 1 })
  if (!rows.length) throw new PsaError(404, `no ${meta(f).label} ticket ${s}`)
  return (await describe(f, rows))[0]
}

export type Note = { id: number; title: string; text: string; by: string; at: string; internal: boolean }

export async function ticketNotes(f: Franchise, ticketId: number, limit = 15): Promise<Note[]> {
  const rows = await query<{ id: number; title: string; description: string; createDateTime: string; creatorResourceID: number | null; creatorContactID: number | null; publish: number }>(
    f, 'TicketNotes', [{ op: 'eq', field: 'ticketID', value: ticketId }], { maxItems: 200 })
  const res = await resources(f)
  return rows
    .sort((a, b) => Date.parse(b.createDateTime) - Date.parse(a.createDateTime))
    .slice(0, limit)
    .map((n) => ({
      id: n.id, title: n.title ?? '', text: (n.description ?? '').slice(0, 3000),
      by: n.creatorResourceID ? res.get(n.creatorResourceID) ?? `resource ${n.creatorResourceID}` : n.creatorContactID ? `contact ${n.creatorContactID}` : 'unknown',
      at: n.createDateTime, internal: n.publish !== 1,
    }))
}

export async function searchTickets(f: Franchise, o: { text?: string; companyId?: number; includeClosed?: boolean; days?: number; limit?: number }): Promise<Ticket[]> {
  const filter: Filter[] = []
  if (o.text?.trim()) filter.push({ op: 'contains', field: 'title', value: o.text.trim() })
  if (o.companyId) filter.push({ op: 'eq', field: 'companyID', value: o.companyId })
  if (!o.includeClosed) filter.push({ op: 'noteq', field: 'status', value: await statusValue(f, 'Complete') })
  filter.push({ op: 'gt', field: 'createDate', value: new Date(Date.now() - (o.days ?? 120) * 86_400_000).toISOString() })
  const mon = await monitoringQueue(f)
  if (mon !== null) filter.push({ op: 'noteq', field: 'queueID', value: mon })
  const rows = await query<TicketRow>(f, 'Tickets', filter, { fields: TICKET_FIELDS, maxItems: Math.min(50, o.limit ?? 25) })
  return describe(f, rows.sort((a, b) => Date.parse(b.createDate) - Date.parse(a.createDate)))
}

// ------------------------------------------------------------- writes ----
// Only ever called by an approved proposal (lib/agentActions.ts), never by an
// agent's own tool call.

/** An internal note (techs only, never the client), written as Brendon where the instance allows it. */
export async function addInternalNote(f: Franchise, ticketId: number, title: string, text: string): Promise<{ id: number }> {
  const body = { ticketID: ticketId, title: title.slice(0, 250), description: text.slice(0, 30_000), noteType: 3, publish: 2 }
  try {
    const r = await at<{ itemId: number }>(f, `/Tickets/${ticketId}/Notes`, {
      method: 'POST', body, headers: { ImpersonationResourceId: String(meta(f).brendon) },
    })
    return { id: r.itemId }
  } catch (e) {
    // an API user without impersonation rights: post as the API user instead
    if (!(e instanceof PsaError) || e.status >= 500) throw e
    const r = await at<{ itemId: number }>(f, `/Tickets/${ticketId}/Notes`, { method: 'POST', body })
    return { id: r.itemId }
  }
}

async function brendonRole(f: Franchise): Promise<number> {
  const known = meta(f).role
  if (known) return known
  const rows = await query<{ roleID: number; isDefault: boolean; isActive: boolean }>(
    f, 'ResourceServiceDeskRoles', [{ op: 'eq', field: 'resourceID', value: meta(f).brendon }], { maxItems: 20 })
  const role = rows.find((r) => r.isDefault && r.isActive) ?? rows.find((r) => r.isActive)
  if (!role) throw new PsaError(400, `Brendon has no service desk role in ${meta(f).label} Autotask`)
  return role.roleID
}

export type TicketPatch = { status?: string; priority?: string; assignToBrendon?: boolean; due?: string }

export async function updateTicket(f: Franchise, ticketId: number, patch: TicketPatch): Promise<Ticket> {
  const p = await picklists(f)
  const body: Record<string, unknown> = { id: ticketId }
  if (patch.status) {
    const v = valueOf(p.status, patch.status)
    if (v === null) throw new PsaError(400, `no status "${patch.status}"`)
    body.status = v
  }
  if (patch.priority) {
    const v = valueOf(p.priority, patch.priority)
    if (v === null) throw new PsaError(400, `no priority "${patch.priority}"`)
    body.priority = v
  }
  if (patch.assignToBrendon) {
    // both or the update 500s
    body.assignedResourceID = meta(f).brendon
    body.assignedResourceRoleID = await brendonRole(f)
  }
  if (patch.due) body.dueDateTime = new Date(patch.due).toISOString()
  await at(f, '/Tickets', { method: 'PATCH', body })
  return getTicket(f, ticketId)
}

export type NewTicket = { companyId: number; title: string; description: string; priority?: string; contactId?: number | null; queue?: string }

/**
 * A new ticket. With a contact, Autotask's "ticket created" rule emails that
 * contact, which is why this only runs from an approved proposal.
 */
export async function createTicket(f: Franchise, t: NewTicket): Promise<Ticket> {
  const p = await picklists(f)
  const queue = valueOf(p.queue, t.queue || 'Help Desk') ?? valueOf(p.queue, 'Help Desk')
  const priority = valueOf(p.priority, t.priority || 'Medium') ?? 2
  const body: Record<string, unknown> = {
    companyID: t.companyId, title: t.title.slice(0, 255), description: t.description.slice(0, 8000),
    status: await statusValue(f, 'New'), priority, queueID: queue, ticketType: 1,
    assignedResourceID: meta(f).brendon, assignedResourceRoleID: await brendonRole(f),
    dueDateTime: new Date(Date.now() + 2 * 86_400_000).toISOString(),
  }
  if (meta(f).category) body.ticketCategory = meta(f).category
  if (t.contactId) body.contactID = t.contactId
  const r = await at<{ itemId: number }>(f, '/Tickets', { method: 'POST', body })
  return getTicket(f, r.itemId)
}
