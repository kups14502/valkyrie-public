import { api } from './api'

// Mail rows synced from thor (backend/src/routes/mail.ts): each mailbox's unread count and the unread
// Focused mail of the last few days. Sender, subject, a preview and the Outlook link; never the body.

export type Mailbox = { key: string; label: string; source: string; unread: number | null; syncedAt: string | null; stale: boolean; error: string | null }

export type MailMessage = {
  mailbox: string
  label: string
  fromName: string
  fromAddress: string
  subject: string
  preview: string
  receivedAt: string
  isRead: boolean
  webLink: string | null
  flagged: boolean
  important: boolean
}

export type MailPage = { mailboxes: Mailbox[]; unread: MailMessage[] }

export const fetchMail = async (): Promise<MailPage> => (await api.get<MailPage>('/mail')).data
