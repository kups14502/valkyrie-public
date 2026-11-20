import { Router, type Request, type Response } from 'express'
import { requireStrongAuth, viaCloudflare } from '../middleware/auth.js'
import { InboxError } from '../lib/inboxStore.js'
import { mailForInbox, mailboxes, syncMailbox, unreadMail } from '../lib/mailStore.js'

// Mail rows from thor's sync job (lib/mailStore.ts has the rules). The sync
// takes strong auth (thor is a trusted tailnet device); reading takes the
// usual auth, and private mailboxes stay off Cloudflare.

const router = Router()

function h(fn: (req: Request, res: Response) => unknown) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res)
    } catch (e) {
      const known = e instanceof InboxError
      if (!known) console.error('[mail]', (e as Error).message)
      if (res.headersSent) return
      res.status(known ? 400 : 500).json({ error: known ? (e as Error).message : 'internal error' })
    }
  }
}

router.post('/mail/sync', requireStrongAuth, h(async (req, res) => {
  res.json({ ok: true, ...(await syncMailbox(req.body ?? {})) })
}))

router.get('/mail', h((req, res) => {
  const hide = viaCloudflare(req)
  res.json({ mailboxes: mailboxes(hide), unread: unreadMail(hide) })
}))

// one inbox item's mail with its whole text (the inbox reads it when the item opens)
router.get('/mail/item/:inboxId', h((req, res) => {
  const id = Number(req.params.inboxId)
  if (!Number.isSafeInteger(id) || id < 1) throw new InboxError('inboxId must be a positive whole number')
  const m = mailForInbox(id, viaCloudflare(req))
  if (!m) return res.status(404).json({ error: 'no mail for that item' })
  res.json(m)
}))

export default router
