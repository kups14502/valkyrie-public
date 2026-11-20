import { api } from './api'

// Mail rows synced from thor and odin (backend/src/routes/mail.ts): each mailbox's unread count and the
// unread Focused mail of the last few days (sender, subject, a preview and the Outlook link), and one
// inbox item's mail with its whole text.

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

/** The mail behind an inbox item (backend lib/mailStore.ts MailBody). */
export type MailItem = {
  mailbox: string
  label: string
  fromName: string
  fromAddress: string
  subject: string
  receivedAt: string
  preview: string
  /** the plain text; null when only the preview came through */
  body: string | null
  /** the message's own link (Outlook on the web), null when its mailbox has none for one message */
  webLink: string | null
  /** the mailbox's web mail (iCloud Mail), only when the message has no link of its own */
  web: string | null
}

export const fetchMailItem = async (inboxId: number): Promise<MailItem> =>
  (await api.get<MailItem>(`/mail/item/${inboxId}`)).data
