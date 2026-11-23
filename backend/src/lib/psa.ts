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
    .map((v) => [Number(v.value), v.label.trim()] as const))
  const p: Picklists = { status: map('status'), priority: map('priority'), queue: map('queueID'), at: Date.now() }
  pickCache.set(f, p)
  return p
}

/** Work types (Autotask billing codes of use type 1), the labels a time entry takes. */
const workCache = new Map<Franchise, { at: number; byId: Map<number, string> }>()
export async function workTypes(f: Franchise): Promise<Map<number, string>> {
  const hit = workCache.get(f)
  if (hit && Date.now() - hit.at < PICK_TTL) return hit.byId
  const rows = await query<{ id: number; name: string; useType: number; isActive: boolean }>(
    f, 'BillingCodes', [{ op: 'eq', field: 'useType', value: 1 }, { op: 'eq', field: 'isActive', value: true }],
    { fields: ['id', 'name', 'useType', 'isActive'], maxItems: 200 })
  const byId = new Map(rows.map((r) => [r.id, (r.name ?? '').trim()] as const))
  workCache.set(f, { at: Date.now(), byId })
  return byId
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

/** The status, priority, queue and work type labels, so an agent can name them. */
export async function labels(f: Franchise): Promise<{ statuses: string[]; priorities: string[]; queues: string[]; workTypes: string[] }> {
  const [p, w] = await Promise.all([picklists(f), workTypes(f).catch(() => new Map<number, string>())])
  return { statuses: [...p.status.values()], priorities: [...p.priority.values()], queues: [...p.queue.values()], workTypes: [...w.values()] }
}

// ------------------------------------------------------ New York time ----
// Agents write times as New York wall time; Autotask stores UTC.

const NY_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
})
const NY_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })

function nyOffsetMs(ms: number): number {
  const parts = NY_PARTS.formatToParts(ms)
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second')) - ms
}

/**
 * An instant from what an agent wrote: an ISO time with a zone as it is, else New York wall time
 * (YYYY-MM-DD HH:mm, or a bare date at `dateOnlyHour` o'clock).
 */
export function nyTimeToIso(s: string, dateOnlyHour = 17): string {
  const t = s.trim()
  if (/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(t)) {
    const ms = Date.parse(t)
    if (Number.isNaN(ms)) throw new PsaError(400, `not a time: ${s}`)
    return new Date(ms).toISOString()
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?$/.exec(t)
  if (!m) throw new PsaError(400, `not a time: ${s} (write YYYY-MM-DD or YYYY-MM-DDTHH:mm, New York time)`)
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), m[4] ? Number(m[4]) : dateOnlyHour, m[5] ? Number(m[5]) : 0)
  let ms = wall - nyOffsetMs(wall)
  ms = wall - nyOffsetMs(ms)
  return new Date(ms).toISOString()
}

const nyDate = (ms: number) => NY_DATE.format(ms)
const nyLabel = (iso: string | null | undefined) =>
  iso ? `${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(Date.parse(iso))} ET` : 'none'

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

/** Techs (Autotask resources) whose name contains the text, for assigning a ticket. */
export async function findResources(f: Franchise, text: string): Promise<{ id: number; name: string; brendon: boolean }[]> {
  const needle = text.trim().toLowerCase()
  return [...(await resources(f)).entries()]
    .filter(([, n]) => !needle || n.toLowerCase().includes(needle))
    .slice(0, 30)
    .map(([id, name]) => ({ id, name, brendon: id === meta(f).brendon }))
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

const CONTACT_FIELDS = ['id', 'companyID', 'firstName', 'lastName', 'emailAddress', 'isActive']

export async function contactsByEmail(f: Franchise, email: string): Promise<Contact[]> {
  const e = email.trim()
  if (!e.includes('@')) return []
  const rows = await query<ContactRow>(f, 'Contacts', [{ op: 'eq', field: 'emailAddress', value: e }],
    { fields: CONTACT_FIELDS, maxItems: 10 })
  return toContacts(f, rows)
}

/**
 * Contacts by name and/or company. One word matches a first or last name; two or more match the
 * first word as first name and the last word as last name. With only a company, its contacts.
 */
export async function findContacts(f: Franchise, o: { name?: string; companyId?: number; email?: string }): Promise<Contact[]> {
  if (o.email?.trim()) {
    const hits = await contactsByEmail(f, o.email)
    return o.companyId === undefined ? hits : hits.filter((c) => c.companyId === o.companyId)
  }
  const filter: Filter[] = []
  if (o.companyId !== undefined) filter.push({ op: 'eq', field: 'companyID', value: o.companyId })
  const words = (o.name ?? '').trim().split(/\s+/).filter(Boolean)
  if (words.length === 1) {
    filter.push({ op: 'or', items: [{ op: 'contains', field: 'firstName', value: words[0] }, { op: 'contains', field: 'lastName', value: words[0] }] })
  } else if (words.length > 1) {
    filter.push({ op: 'contains', field: 'firstName', value: words[0] }, { op: 'contains', field: 'lastName', value: words[words.length - 1] })
  }
  if (!filter.length) throw new PsaError(400, 'name a contact, a company id or an email')
  const rows = await query<ContactRow>(f, 'Contacts', filter, { fields: CONTACT_FIELDS, maxItems: 40 })
  return (await toContacts(f, rows)).sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name))
}

export async function getContact(f: Franchise, id: number): Promise<Contact | null> {
  const rows = await query<ContactRow>(f, 'Contacts', [{ op: 'eq', field: 'id', value: id }], { fields: CONTACT_FIELDS, maxItems: 1 })
  return rows.length ? (await toContacts(f, rows))[0] : null
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

/** A tech's service desk role: Brendon's from the config when it is set, else the tech's default active role. */
async function resourceRole(f: Franchise, resourceId: number): Promise<number> {
  const known = resourceId === meta(f).brendon ? meta(f).role : undefined
  if (known) return known
  const rows = await query<{ roleID: number; isDefault: boolean; isActive: boolean }>(
    f, 'ResourceServiceDeskRoles', [{ op: 'eq', field: 'resourceID', value: resourceId }], { maxItems: 20 })
  const role = rows.find((r) => r.isDefault && r.isActive) ?? rows.find((r) => r.isActive)
  if (!role) {
    const who = (await resources(f)).get(resourceId) ?? `resource ${resourceId}`
    throw new PsaError(400, `${who} has no service desk role in ${meta(f).label} Autotask, so a ticket cannot be assigned to them`)
  }
  return role.roleID
}
const brendonRole = (f: Franchise) => resourceRole(f, meta(f).brendon)

/**
 * A ticket change, by name where Autotask has names. companyId moves the ticket to another company:
 * its location becomes the new company's primary one, and a contract, configuration item or contact
 * of the old company is cleared. contactId null (or 0) clears the contact. due is New York time.
 */
export type TicketPatch = {
  status?: string; priority?: string; queue?: string
  assignToBrendon?: boolean; assignTo?: number
  due?: string
  companyId?: number; contactId?: number | null
  title?: string; description?: string; resolution?: string
}

type TicketNow = TicketRow & {
  companyLocationID: number | null; contractID: number | null; configurationItemID: number | null; billingCodeID: number | null; resolution: string | null
}

async function ticketNow(f: Franchise, id: number): Promise<TicketNow> {
  const rows = await query<TicketNow>(f, 'Tickets', [{ op: 'eq', field: 'id', value: id }], {
    fields: [...TICKET_FIELDS, 'companyLocationID', 'contractID', 'configurationItemID', 'billingCodeID', 'resolution'], maxItems: 1,
  })
  if (!rows.length) throw new PsaError(404, `no ${meta(f).label} ticket ${id}`)
  return rows[0]
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export type TicketPlan = { body: Record<string, unknown>; changes: string[]; number: string; closes: boolean }

/**
 * What a change does to the ticket as it is now: the PATCH body, and one line per change for the
 * proposal card. Everything is checked here (the names exist, the contact belongs to the company,
 * the tech has a role), so a change that cannot work is refused before Brendon sees it. No changes
 * means the ticket already is that way.
 */
export async function planTicketUpdate(f: Franchise, ticketId: number, patch: TicketPatch): Promise<TicketPlan> {
  const [t, p, co, res] = await Promise.all([ticketNow(f, ticketId), picklists(f), companies(f), resources(f)])
  const L = meta(f).label
  const body: Record<string, unknown> = { id: ticketId }
  const changes: string[] = []
  const coName = (id: number) => co.get(id)?.name ?? `company ${id}`
  const resName = (id: number | null) => (id ? res.get(id) ?? `resource ${id}` : 'nobody')
  const contactName = async (id: number | null) => {
    if (!id) return 'none'
    const c = await getContact(f, id).catch(() => null)
    return c ? `${c.name}${c.email ? ` <${c.email}>` : ''}` : `contact ${id}`
  }
  const pick = (m: Map<number, string>, label: string, what: string) => {
    const v = valueOf(m, label.trim())
    if (v === null) throw new PsaError(400, `${L} Autotask has no ${what} "${label}"; autotask_labels lists them`)
    return v
  }

  if (patch.status) {
    const v = pick(p.status, patch.status, 'status')
    if (v !== t.status) { body.status = v; changes.push(`Status: ${p.status.get(v)} (was ${p.status.get(t.status) ?? t.status})`) }
  }
  if (patch.priority) {
    const v = pick(p.priority, patch.priority, 'priority')
    if (v !== t.priority) { body.priority = v; changes.push(`Priority: ${p.priority.get(v)} (was ${p.priority.get(t.priority) ?? t.priority})`) }
  }
  if (patch.queue) {
    const v = pick(p.queue, patch.queue, 'queue')
    if (v !== t.queueID) { body.queueID = v; changes.push(`Queue: ${p.queue.get(v)} (was ${t.queueID ? p.queue.get(t.queueID) ?? t.queueID : 'none'})`) }
  }

  // the company first: a contact is checked against the company the ticket ends up in
  let companyId = t.companyID
  if (patch.companyId !== undefined && patch.companyId !== t.companyID) {
    const c = co.get(patch.companyId)
    if (!c) throw new PsaError(400, `no ${L} company ${patch.companyId}; company_find looks one up`)
    if (!c.active) throw new PsaError(400, `${c.name} is inactive in ${L} Autotask`)
    companyId = patch.companyId
    body.companyID = companyId
    changes.push(`Company: ${c.name} (was ${coName(t.companyID)})`)
    const locs = (await query<{ id: number; name: string; isPrimary: boolean; isActive: boolean }>(f, 'CompanyLocations',
      [{ op: 'eq', field: 'companyID', value: companyId }], { fields: ['id', 'name', 'isPrimary', 'isActive'], maxItems: 50 }))
      .filter((l) => l.isActive !== false)
    const loc = locs.find((l) => l.isPrimary) ?? locs[0]
    if (loc?.id !== t.companyLocationID) body.companyLocationID = loc?.id ?? null
    if (t.contractID) { body.contractID = null; changes.push('Contract: cleared (it was the old company\'s)') }
    if (t.configurationItemID) { body.configurationItemID = null; changes.push('Configuration item: cleared (it was the old company\'s)') }
    if (patch.contactId === undefined && t.contactID) {
      body.contactID = null
      changes.push(`Contact: none (was ${await contactName(t.contactID)}, of the old company)`)
    }
  }
  if (patch.contactId !== undefined) {
    const want = patch.contactId || null
    if (want === null && t.contactID) {
      body.contactID = null
      changes.push(`Contact: none (was ${await contactName(t.contactID)})`)
    } else if (want !== null && want !== t.contactID) {
      const c = await getContact(f, want)
      if (!c) throw new PsaError(400, `no ${L} contact ${want}; contact_find looks one up`)
      if (c.companyId !== companyId) {
        throw new PsaError(400, `${c.name} is a contact of ${c.company} (company ${c.companyId}), not of ${coName(companyId)}; pass companyId ${c.companyId} too`)
      }
      if (!c.active) throw new PsaError(400, `${c.name} is an inactive contact in ${L} Autotask`)
      body.contactID = c.id
      changes.push(`Contact: ${c.name}${c.email ? ` <${c.email}>` : ''} (was ${await contactName(t.contactID)})`)
    }
  }

  const assignee = patch.assignTo ?? (patch.assignToBrendon ? meta(f).brendon : undefined)
  if (assignee !== undefined && assignee !== t.assignedResourceID) {
    if (!res.has(assignee)) throw new PsaError(400, `no ${L} resource ${assignee}; resource_find looks one up`)
    // both or the update 500s
    body.assignedResourceID = assignee
    body.assignedResourceRoleID = await resourceRole(f, assignee)
    changes.push(`Assigned: ${resName(assignee)} (was ${resName(t.assignedResourceID)})`)
  }
  if (patch.due?.trim()) {
    const iso = nyTimeToIso(patch.due)
    if (Date.parse(iso) !== Date.parse(t.dueDateTime ?? '')) { body.dueDateTime = iso; changes.push(`Due: ${nyLabel(iso)} (was ${nyLabel(t.dueDateTime)})`) }
  }
  const title = patch.title?.trim().slice(0, 255)
  if (title && title !== (t.title ?? '').trim()) { body.title = title; changes.push(`Title: ${title} (was ${t.title || 'none'})`) }
  const description = patch.description?.trim().slice(0, 8000)
  if (description && description !== (t.description ?? '').trim()) {
    body.description = description
    changes.push(`Description, new: ${clip(description, 600)}`)
  }
  const resolution = patch.resolution?.trim().slice(0, 32_000)
  if (resolution && resolution !== (t.resolution ?? '').trim()) { body.resolution = resolution; changes.push(`Resolution: ${clip(resolution, 600)}`) }

  const closes = typeof body.status === 'number' && (p.status.get(body.status) ?? '').toLowerCase() === 'complete'
  return { body, changes, number: t.ticketNumber, closes }
}

/** Applies a change, re-planned against the ticket as it is at that moment. */
export async function updateTicket(f: Franchise, ticketId: number, patch: TicketPatch): Promise<{ ticket: Ticket; changes: string[] }> {
  const plan = await planTicketUpdate(f, ticketId, patch)
  if (plan.changes.length) await at(f, '/Tickets', { method: 'PATCH', body: plan.body })
  return { ticket: await getTicket(f, ticketId), changes: plan.changes }
}

/**
 * Time on a ticket, as Brendon: hours, the summary (what the contact sees on the ticket), optional
 * internal notes. start is New York time; without it the entry ends at `nowMs`. The work type is
 * by name, else the ticket's own.
 */
export type TimeEntryInput = { hours: number; summary: string; internalNotes?: string; workType?: string; start?: string; nonBillable?: boolean }

export async function planTimeEntry(f: Franchise, ticketId: number, e: TimeEntryInput, nowMs = Date.now()): Promise<{ body: Record<string, unknown>; changes: string[]; number: string; start: string }> {
  const hours = Math.round(Number(e.hours) * 100) / 100
  if (!(hours >= 0.05 && hours <= 12)) throw new PsaError(400, 'hours must be between 0.05 and 12')
  const summary = (e.summary ?? '').trim()
  if (summary.length < 3) throw new PsaError(400, 'a time entry needs a summary of the work')
  const [t, types, res, role] = await Promise.all([ticketNow(f, ticketId), workTypes(f), resources(f), brendonRole(f)])
  const startMs = e.start?.trim() ? Date.parse(nyTimeToIso(e.start, 9)) : nowMs - hours * 3_600_000
  const endMs = startMs + Math.round(hours * 3_600_000)
  if (endMs > nowMs + 10 * 60_000) throw new PsaError(400, 'a time entry cannot end in the future')
  let billingCodeID: number | null = null
  if (e.workType?.trim()) {
    billingCodeID = valueOf(types, e.workType.trim())
    if (billingCodeID === null) throw new PsaError(400, `${meta(f).label} Autotask has no work type "${e.workType}"; autotask_labels lists them`)
  } else if (t.billingCodeID && types.has(t.billingCodeID)) {
    billingCodeID = t.billingCodeID
  }
  const internal = e.internalNotes?.trim()
  const body: Record<string, unknown> = {
    ticketID: ticketId, resourceID: meta(f).brendon, roleID: role,
    dateWorked: `${nyDate(startMs)}T00:00:00Z`,
    startDateTime: new Date(startMs).toISOString(), endDateTime: new Date(endMs).toISOString(),
    hoursWorked: hours, summaryNotes: summary.slice(0, 32_000),
    ...(internal ? { internalNotes: internal.slice(0, 32_000) } : {}),
    ...(billingCodeID ? { billingCodeID } : {}),
    ...(e.nonBillable ? { isNonBillable: true } : {}),
  }
  const endLabel = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(endMs)
  const changes = [
    `Time: ${hours} h as ${res.get(meta(f).brendon) ?? 'Brendon'}, ${nyLabel(new Date(startMs).toISOString()).replace(/ ET$/, '')} to ${endLabel} ET`,
    `Work type: ${billingCodeID ? types.get(billingCodeID) : 'none'}${e.nonBillable ? ', non-billable' : ''}`,
    `Summary: ${clip(summary, 600)}`,
    ...(internal ? [`Internal notes: ${clip(internal, 400)}`] : []),
  ]
  return { body, changes, number: t.ticketNumber, start: new Date(startMs).toISOString() }
}

export async function addTimeEntry(f: Franchise, ticketId: number, e: TimeEntryInput): Promise<{ id: number; changes: string[] }> {
  const plan = await planTimeEntry(f, ticketId, e)
  const r = await at<{ itemId: number }>(f, '/TimeEntries', { method: 'POST', body: plan.body })
  return { id: r.itemId, changes: plan.changes }
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
