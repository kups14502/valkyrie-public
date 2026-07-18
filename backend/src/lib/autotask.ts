import { readFileSync } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'

// Minimal Autotask REST client for the one thing the Valkyrie backend does
// with write access: create a ticket from a work email (user-triggered, one
// click, Work mailboxes only). Reuses the same API creds the email-assistant
// scanner uses — read from its env file so there's a single source of truth.

const ENV_PATH = path.join(homedir(), 'email-assistant', 'config', 'email-assistant.env')

type AutotaskCreds = { zone: string; code: string; user: string; secret: string }

function readCreds(): AutotaskCreds | null {
  try {
    const env: Record<string, string> = {}
    for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('#') || !t.includes('=')) continue
      const i = t.indexOf('=')
      env[t.slice(0, i).trim()] = t.slice(i + 1).trim()
    }
    const zone = (env.AUTOTASK_ZONE_URL || '').replace(/\/$/, '')
    const code = env.AUTOTASK_INTEGRATION_CODE || ''
    const user = env.AUTOTASK_USERNAME || ''
    const secret = env.AUTOTASK_SECRET || ''
    if (!zone || !code || !user || !secret) return null
    return { zone, code, user, secret }
  } catch {
    return null
  }
}

function headers(c: AutotaskCreds) {
  return {
    'ApiIntegrationCode': c.code,
    'UserName': c.user,
    'Secret': c.secret,
    'Content-Type': 'application/json',
  }
}

export function autotaskConfigured(): boolean {
  return readCreds() !== null
}

const emailAddr = (raw: string) => (raw.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0] || '').toLowerCase()

// Look up an Autotask contact by email to attribute the ticket to the right
// company. Returns the company + contact ids, or null when the sender isn't a
// known contact (e.g. an internal address) — the caller then refuses.
export async function findContactByEmail(rawSender: string): Promise<{ companyID: number; contactID: number } | null> {
  const c = readCreds()
  const email = emailAddr(rawSender)
  if (!c || !email) return null
  const body = JSON.stringify({
    filter: [{ op: 'eq', field: 'emailAddress', value: email }],
    IncludeFields: ['id', 'companyID', 'isActive'],
  })
  const resp = await fetch(`${c.zone}/Contacts/query`, { method: 'POST', headers: headers(c), body })
  if (!resp.ok) return null
  const data = await resp.json() as { items?: { id: number; companyID: number; isActive: boolean }[] }
  const hit = (data.items ?? []).find((x) => x.isActive) ?? (data.items ?? [])[0]
  return hit ? { companyID: hit.companyID, contactID: hit.id } : null
}

export type CreatedTicket = { id: number; ticketNumber: string }

export async function createTicket(input: {
  companyID: number
  contactID?: number
  title: string
  description: string
}): Promise<CreatedTicket> {
  const c = readCreds()
  if (!c) throw new Error('Autotask not configured')
  const due = new Date(Date.now() + 3 * 86_400_000).toISOString() // SLA overrides if one applies
  const body = JSON.stringify({
    companyID: input.companyID,
    ...(input.contactID ? { contactID: input.contactID } : {}),
    title: input.title.slice(0, 255),
    description: input.description.slice(0, 8000),
    status: 1,        // New
    priority: 2,      // Medium
    queueID: 0, // Triage
    dueDateTime: due,
  })
  const resp = await fetch(`${c.zone}/Tickets`, { method: 'POST', headers: headers(c), body })
  if (!resp.ok) throw new Error(`Autotask create failed: ${resp.status} ${(await resp.text().catch(() => '')).slice(0, 200)}`)
  const created = await resp.json() as { itemId?: number }
  const id = created.itemId
  if (!id) throw new Error('Autotask create returned no id')
  // Fetch the assigned ticket number for display / linking.
  let ticketNumber = String(id)
  try {
    const g = await fetch(`${c.zone}/Tickets/${id}`, { headers: headers(c) })
    if (g.ok) {
      const t = await g.json() as { item?: { ticketNumber?: string } }
      if (t.item?.ticketNumber) ticketNumber = t.item.ticketNumber
    }
  } catch { /* fall back to id */ }
  return { id, ticketNumber }
}
