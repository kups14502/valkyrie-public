import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { DatabaseBackup, FileText, Mail } from 'lucide-react'
import { Button, Panel, Press, Segmented, cx, toast } from '../kit/ui'
import { Icon, type IconRef } from '../kit/icons'
import { useTick } from '../kit/data'
import { apiErrorText } from '../../lib/api'
import { featureIcon } from '../../features/apply'
import { copyText } from '../../lib/clipboard'
import {
  archiveInbox, fetchInbox, markInboxRead, setInboxPush,
  type InboxItem, type InboxLevel, type InboxPage as InboxData, type InboxSelection, type InboxView, type PushSetting,
} from '../../lib/inboxApi'
import { PageFrame } from './Calendar'
import './inbox.css'

// The inbox in v2 (/m/inbox): everything odin, thor and Valkyrie itself want to
// tell Brendon (backend/src/lib/inboxStore.ts has the rules).
//
// The Inbox tab is a board of panels, the dashboard's look (he called the plain
// list "lame", "just a list of mail", 2026-11-18: 143 of 192 open items were
// mail and the alerts drowned in it):
//   Needs you   every warning and alert, alerts first, repeats from one source
//               folded into one row
//   Mail        one block per mailbox, one row per sender; read senders past
//               the first few fold behind "Show n more"
//   Reports     the quiet rest (trade, jobs, accounts), one row per source
// A panel with nothing in it is not drawn. A row with one item opens to its
// text; a row with several opens to its items, each opening in turn. Opening an
// unread item reads it. An open item has Open (its link), Copy, Mark unread and
// Archive. The Archive tab and a source filter show the flat list under day
// headings (Today, Yesterday, Fri, Oct 30) with the same rows. Sources sets
// each source's push. A push notification lands here with ?item=<id>, which
// opens and reads that item.
//
// The list is a plain query, never the v2 localStorage cache: an item can hold
// a sign-in link, and nothing here should outlive the tab.

type Tab = InboxView | 'sources'

const TABS: { id: Tab; label: string }[] = [
  { id: 'open', label: 'Inbox' },
  { id: 'archive', label: 'Archive' },
  { id: 'sources', label: 'Sources' },
]

const PUSH_OPTS: { value: PushSetting; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
]

const URL_RE = /(https?:\/\/[^\s<>"']+)/

const NY_TIME = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })
const NY_DAY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' })
const NY_KEY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
const NY_FULL = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
})

/** "4m", "3h", today's clock, or the date: always New York time. */
function when(iso: string, now: number): string {
  const t = Date.parse(iso)
  const d = now - t
  if (d < 60_000) return 'now'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`
  if (NY_KEY.format(t) === NY_KEY.format(now)) return NY_TIME.format(t)
  if (d < 6 * 86_400_000) return `${NY_DAY.format(t)}, ${NY_TIME.format(t)}`
  return NY_DAY.format(t)
}

const NY_WEEKDAY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' })

/** A row's time under its day heading: "now", "13m", then the clock. */
function clock(iso: string, now: number): string {
  const d = now - Date.parse(iso)
  if (d < 60_000) return 'now'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`
  return NY_TIME.format(Date.parse(iso))
}

const NY_DOW = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' })

/** A row's time on the board, where no day heading sits over it: "13m", today's clock, the weekday, then the date. */
function stamp(iso: string, now: number): string {
  const t = Date.parse(iso)
  const d = now - t
  if (d < 60_000) return 'now'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`
  if (NY_KEY.format(t) === NY_KEY.format(now)) return NY_TIME.format(t)
  return d < 6 * 86_400_000 ? NY_DOW.format(t) : NY_DAY.format(t)
}

/** The heading a row sits under: Today, Yesterday, the weekday and date this week, else the date. */
function dayLabel(iso: string, now: number): string {
  const t = Date.parse(iso)
  const k = NY_KEY.format(t)
  if (k === NY_KEY.format(now)) return 'Today'
  if (k === NY_KEY.format(now - 86_400_000)) return 'Yesterday'
  return now - t < 6 * 86_400_000 ? NY_WEEKDAY.format(t) : NY_DAY.format(t)
}

const full = (iso: string) => `${NY_FULL.format(Date.parse(iso))} ET`

const firstLine = (s: string) => s.split('\n').map((l) => l.trim()).find(Boolean) ?? ''

const SOURCE_LABELS: Record<string, string> = { raid: 'RAID' }

/** A source as a person reads it: "work-mail" is Work mail. */
const sourceLabel = (s: string) => SOURCE_LABELS[s] ?? `${s.charAt(0).toUpperCase()}${s.slice(1)}`.replace(/-/g, ' ')

const isMail = (source: string) => source.endsWith('-mail')

/** Mail is titled "Sender: Subject" (backend lib/mailStore.ts). */
function mailParts(it: InboxItem): { sender: string; subject: string } | null {
  const cut = isMail(it.source) ? it.title.indexOf(': ') : -1
  return cut > 0 ? { sender: it.title.slice(0, cut), subject: it.title.slice(cut + 2) } : null
}

/** A sender's badge: "Pat Example" is PE, "Acme" is AC, an address its first two letters. */
function initials(name: string): string {
  if (name.includes('@')) return name.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '@'
  const w = name.replace(/[^\p{L}\p{N} ]+/gu, ' ').trim().split(/\s+/).filter(Boolean)
  if (!w.length) return '@'
  return (w.length === 1 ? w[0].slice(0, 2) : `${w[0][0]}${w[w.length - 1][0]}`).toUpperCase()
}

const SOURCE_ICONS: Record<string, IconRef> = {
  raid: 'disk', backups: DatabaseBackup, claude: 'ai', trade: 'trades',
  accounts: 'key', reminder: 'clock', plex: 'media', updates: 'update', odin: 'odin', thor: 'thor', tasks: 'tasks',
}
/** Mail, a source's own icon, the icon of the feature tab named like the source, else the inbox. */
const sourceIcon = (source: string): IconRef => (isMail(source) ? Mail : SOURCE_ICONS[source] ?? featureIcon(source) ?? 'inbox')

const LEVEL_RANK: Record<InboxLevel, number> = { alert: 0, warn: 1, info: 2 }
const MAILBOXES = ['work-mail', 'personal-mail', 'support-mail']
/** read senders a mailbox shows before "Show n more" */
const READ_SHOWN = 4

/** One row: an item, or the items one sender or one source sent, newest first. */
type Group = {
  key: string
  items: InboxItem[]
  head: string
  sub: string
  /** a mail sender's initials; without it the row carries the source's icon */
  badge: string | null
  source: string
  level: InboxLevel
  unread: number
  lastAt: string
}

function group(key: string, items: InboxItem[], head: string, sub: string, badge: string | null = null): Group {
  return {
    key, items, head, badge,
    sub: sub === head ? '' : sub,
    source: items[0].source,
    level: items.reduce<InboxLevel>((l, it) => (LEVEL_RANK[it.level] < LEVEL_RANK[l] ? it.level : l), 'info'),
    unread: items.filter((it) => !it.readAt).length,
    lastAt: items[0].lastAt,
  }
}

/** A row for one item, as the flat list shows it: mail by its sender, the rest by title. */
function single(it: InboxItem): Group {
  const m = mailParts(it)
  return m ? group(`i${it.id}`, [it], m.sender, m.subject, initials(m.sender)) : group(`i${it.id}`, [it], it.title, firstLine(it.body))
}

function bucket<T>(list: T[], keyOf: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const x of list) {
    const k = keyOf(x)
    const have = m.get(k)
    if (have) have.push(x)
    else m.set(k, [x])
  }
  return m
}

const unreadFirst = (a: Group, b: Group) => Number(b.unread > 0) - Number(a.unread > 0) || b.lastAt.localeCompare(a.lastAt)

type Board = {
  need: Group[]
  mail: { source: string; groups: Group[]; unread: number; total: number }[]
  reports: Group[]
}

/** The Inbox tab's three panels from the open items (newest first, as the API sends them). */
function board(items: InboxItem[]): Board {
  const loud = items.filter((it) => it.level !== 'info')
  const quiet = items.filter((it) => it.level === 'info')

  // warnings and alerts: mail by sender, the rest by source and level
  const need = [...bucket(loud, (it) => `n:${it.source}:${mailParts(it)?.sender ?? it.level}`)].map(([key, list]) => {
    const m = mailParts(list[0])
    if (m) return group(key, list, m.sender, m.subject, initials(m.sender))
    return group(key, list, list[0].title, firstLine(list[0].body) || (list.length > 1 ? `and ${list.length - 1} earlier` : ''))
  }).sort((a, b) => Number(b.unread > 0) - Number(a.unread > 0) || LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || b.lastAt.localeCompare(a.lastAt))

  const boxes = bucket(quiet.filter((it) => isMail(it.source)), (it) => it.source)
  const order = [...boxes.keys()].sort((a, b) => {
    const ia = MAILBOXES.indexOf(a)
    const ib = MAILBOXES.indexOf(b)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b)
  })
  const mail = order.map((source) => {
    const list = boxes.get(source)!
    const groups = [...bucket(list, (it) => mailParts(it)?.sender ?? it.title)].map(([sender, mine]) =>
      group(`m:${source}:${sender}`, mine, sender, mailParts(mine[0])?.subject ?? firstLine(mine[0].body), initials(sender))).sort(unreadFirst)
    return { source, groups, unread: list.filter((it) => !it.readAt).length, total: list.length }
  })

  const reports = [...bucket(quiet.filter((it) => !isMail(it.source)), (it) => it.source)].map(([source, list]) =>
    group(`r:${source}`, list, sourceLabel(source), list[0].title)).sort(unreadFirst)

  return { need, mail, reports }
}

/** The body as plain text with its links live. */
function Linked({ text }: { text: string }) {
  const parts: ReactNode[] = text.split(URL_RE).map((p, k) =>
    k % 2 ? <a key={k} href={p} target="_blank" rel="noopener noreferrer" className="ib-link">{p.length > 60 ? `${p.slice(0, 58)}…` : p}</a> : p)
  return <p className="ib-note">{parts}</p>
}

export default function InboxPage() {
  // a push tap carries ?item=<id>; a new one starts the screen afresh with that row open
  const [params] = useSearchParams()
  const asked = Number(params.get('item')) || null
  return (
    <PageFrame id="inbox" title="Inbox" icon="inbox" scroll>
      <InboxScreen key={asked ?? 'none'} asked={asked} />
    </PageFrame>
  )
}

function InboxScreen({ asked }: { asked: number | null }) {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const now = useTick(30_000)
  const tab: Tab = params.get('view') === 'archive' ? 'archive' : params.get('view') === 'sources' ? 'sources' : 'open'
  const source = params.get('source')
  const view: InboxView = tab === 'archive' ? 'archive' : 'open'
  // the row he opened; until he opens or closes one, the row a push tap asked for
  const [picked, setOpenId] = useState<number | null | undefined>(undefined)
  const openId = picked !== undefined ? picked : asked
  // the row of several he opened, and the mailboxes showing every read sender
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [more, setMore] = useState<Set<string>>(() => new Set())
  // the Inbox tab without a source filter is the board; it wants every open item
  const onBoard = tab === 'open' && !source
  const handled = useRef<number | null>(null)
  const rowRefs = useRef(new Map<number, HTMLDivElement>())

  const key = ['inbox', view, source ?? ''] as const
  const q = useQuery({
    queryKey: key,
    queryFn: () => fetchInbox(view, source, onBoard ? 500 : undefined),
    refetchInterval: () => (document.hidden ? false : 15_000),
    refetchOnWindowFocus: true,
  })
  const items = useMemo(() => q.data?.items ?? [], [q.data])
  const b = useMemo(() => board(onBoard ? items : []), [onBoard, items])
  const count = q.data?.count
  const sources = q.data?.sources ?? []

  const setParam = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(params)
    for (const [k, v] of Object.entries(next)) {
      if (v == null) p.delete(k)
      else p.set(k, v)
    }
    setParams(p, { replace: true, state: window.history.state?.usr })
  }

  // every change refreshes the list and the strip's count
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['inbox'] })
    void qc.invalidateQueries({ queryKey: ['v2', 'inbox-count'] })
  }
  /** Changes the cached page at once, so a tap never waits on the network. */
  const patchItems = (fn: (it: InboxItem) => InboxItem | null) => {
    qc.setQueryData<InboxData>(key, (d) => d && {
      ...d,
      items: d.items.map(fn).filter((x): x is InboxItem => x !== null),
    })
  }

  const read = useMutation({
    mutationFn: ({ sel, value }: { sel: InboxSelection; value: boolean }) => markInboxRead(sel, value),
    onMutate: ({ sel, value }) => {
      const at = new Date().toISOString()
      patchItems((it) => (sel.all || sel.source === it.source || sel.ids?.includes(it.id) ? { ...it, readAt: value ? it.readAt ?? at : null } : it))
    },
    onError: (e) => toast(`Could not mark it: ${apiErrorText(e, 'Valkyrie did not answer')}`, { ms: 4000 }),
    onSettled: refresh,
  })

  const archive = useMutation({
    mutationFn: ({ sel, value, readOnly }: { sel: InboxSelection; value: boolean; readOnly?: boolean }) => archiveInbox({ ...sel, readOnly }, value),
    onMutate: ({ sel, readOnly }) => {
      patchItems((it) => ((sel.all || sel.source === it.source || sel.ids?.includes(it.id)) && (!readOnly || it.readAt) ? null : it))
    },
    onSuccess: (r, { sel, value }) => {
      if (!r.changed) return
      const ids = sel.ids
      const undo = ids ? () => archive.mutate({ sel: { ids }, value: !value }) : undefined
      const what = r.changed === 1 ? '1 item' : `${r.changed} items`
      toast(value ? `Archived ${what}` : `${what} back in the inbox`, undo ? { action: { label: 'Undo', run: undo } } : undefined)
    },
    onError: (e) => toast(`Could not archive: ${apiErrorText(e, 'Valkyrie did not answer')}`, { ms: 4000 }),
    onSettled: refresh,
  })

  const push = useMutation({
    mutationFn: ({ src, value }: { src: string; value: PushSetting }) => setInboxPush(src, value),
    onMutate: ({ src, value }) => {
      qc.setQueryData<InboxData>(key, (d) => d && { ...d, sources: d.sources.map((s) => (s.source === src ? { ...s, push: value } : s)) })
    },
    onError: (e) => toast(`Could not change push: ${apiErrorText(e, 'Valkyrie did not answer')}`, { ms: 4000 }),
    onSettled: refresh,
  })

  const toggle = (it: InboxItem) => {
    const opening = openId !== it.id
    setOpenId(opening ? it.id : null)
    if (opening && !it.readAt) read.mutate({ sel: { ids: [it.id] }, value: true })
  }

  // A push notification's tap: the row is open already (openId); read it and bring it into view.
  useEffect(() => {
    if (!asked || !q.data || handled.current === asked) return
    const it = q.data.items.find((x) => x.id === asked)
    if (it) {
      handled.current = asked
      if (!it.readAt) read.mutate({ sel: { ids: [it.id] }, value: true })
      requestAnimationFrame(() => rowRefs.current.get(it.id)?.scrollIntoView({ block: 'center' }))
    } else if (view === 'open' && !source) {
      // archived since, or filtered out: look in the archive once
      setParam({ view: 'archive', source: null })
    } else {
      handled.current = asked
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked, q.data])

  const openLink = (url: string) => {
    if (url.startsWith('/')) navigate(url, { state: { v2Back: true } })
    else window.open(url, '_blank', 'noopener,noreferrer')
  }

  const copy = async (it: InboxItem) => {
    toast((await copyText(it.body || it.title)) ? 'Copied' : 'Could not copy. Select the text instead.', { ms: 2500 })
  }

  const toggleGroup = (g: Group) => {
    if (g.items.length === 1) {
      setOpenKey(null)
      toggle(g.items[0])
      return
    }
    const open = openKey === g.key || g.items.some((it) => it.id === openId)
    setOpenKey(open ? null : g.key)
    setOpenId(null)
  }

  const keep = (id: number) => (el: HTMLDivElement | null) => {
    if (el) rowRefs.current.set(id, el)
    else rowRefs.current.delete(id)
  }

  /** An open item: its whole text and what he can do with it. */
  const detail = (it: InboxItem) => (
    <div className="ib-detail">
      {it.body && <Linked text={it.body} />}
      <div className="ib-acts">
        {it.url && <Button kind="line" icon="go" onPress={() => openLink(it.url!)}>Open</Button>}
        <Button kind="link" onPress={() => void copy(it)}>Copy</Button>
        {!it.archivedAt && it.readAt && (
          <Button kind="link" onPress={() => { setOpenId(null); read.mutate({ sel: { ids: [it.id] }, value: false }) }}>Mark unread</Button>
        )}
        <Button kind="link" onPress={() => { setOpenId(null); archive.mutate({ sel: { ids: [it.id] }, value: !it.archivedAt }) }}>
          {it.archivedAt ? 'Back to inbox' : 'Archive'}
        </Button>
      </div>
      <p className="ib-when">
        {it.count > 1 ? `${it.count} times, first ${full(it.firstAt)}, last ${full(it.lastAt)}` : full(it.lastAt)}
        {it.pushedAt ? ' · pushed' : it.pushDetail ? ` · push failed: ${it.pushDetail}` : ''}
      </p>
    </div>
  )

  /** An open row of several: each item on a line, opening in turn, then the whole row's actions. */
  const kids = (g: Group) => {
    const ids = g.items.map((it) => it.id)
    return (
      <div className="ib-kids">
        {g.items.map((it) => {
          const on = it.id === openId
          return (
            <div key={it.id} ref={keep(it.id)} className="ib-kid" data-open={on || undefined} data-unread={!it.readAt || undefined} data-level={it.level}>
              <Press className="ib-kid-main" aria-expanded={on} onPress={() => { setOpenKey(g.key); toggle(it) }}>
                <span className="ib-kid-dot" aria-hidden />
                <span className="ib-kid-text">
                  {mailParts(it)?.subject ?? (it.title === g.head && firstLine(it.body) ? firstLine(it.body) : it.title)}
                  {it.count > 1 && <i className="ib-count"> ×{it.count}</i>}
                </span>
                <time dateTime={it.lastAt} title={full(it.lastAt)}>{when(it.lastAt, now)}</time>
              </Press>
              {on && detail(it)}
            </div>
          )
        })}
        <div className="ib-acts ib-kids-acts">
          {g.unread > 0 && <Button kind="link" onPress={() => read.mutate({ sel: { ids }, value: true })}>Mark {g.unread} read</Button>}
          <Button kind="link" onPress={() => { setOpenKey(null); setOpenId(null); archive.mutate({ sel: { ids }, value: true }) }}>Archive all {ids.length}</Button>
        </div>
      </div>
    )
  }

  /** One row: its mark (a sender's initials or the source's icon), two lines, and what it opens to. */
  const row = (g: Group, time: (iso: string) => string, from: boolean) => {
    const one = g.items.length === 1 ? g.items[0] : null
    const open = one ? one.id === openId : openKey === g.key || g.items.some((it) => it.id === openId)
    // a line taken from the body steps aside once the row is open and shows the whole body
    const sub = open && one && g.sub === firstLine(one.body) ? '' : g.sub
    const n = g.items.reduce((a, it) => a + it.count, 0)
    return (
      <div
        key={g.key}
        ref={one ? keep(one.id) : undefined}
        className="ib-row"
        data-open={open || undefined}
        data-unread={g.unread > 0 || undefined}
        data-level={g.level}
      >
        <Press className="ib-row-main" aria-expanded={open} onPress={() => toggleGroup(g)}>
          <span className="ib-glyph" data-badge={g.badge ? '' : undefined} aria-label={g.level === 'info' ? undefined : g.level} aria-hidden={g.level === 'info' || undefined}>
            {g.badge ?? <Icon name={sourceIcon(g.source)} size={15} tone={g.level === 'alert' ? 'hot' : g.unread > 0 ? 'fg' : 'dim'} glow={g.unread > 0} />}
          </span>
          <span className="ib-text" data-nosub={(!sub && !from) || undefined}>
            <span className="ib-l1">
              <b>
                {g.head}
                {n > 1 && <i className="ib-count"> ×{n}</i>}
              </b>
              <time dateTime={g.lastAt} title={full(g.lastAt)}>{time(g.lastAt)}</time>
            </span>
            {(sub || from) && (
              <span className="ib-l2">
                <span className="ib-sub">{sub}</span>
                {from && <span className="ib-from">{sourceLabel(g.source)}</span>}
              </span>
            )}
          </span>
        </Press>
        {open && one && detail(one)}
        {open && !one && kids(g)}
      </div>
    )
  }

  const unread = count?.unread ?? 0
  const shownUnread = items.filter((it) => !it.readAt).length
  const chips = sources.filter((s) => (view === 'open' ? s.open > 0 : true) || s.source === source)
  const status = q.isError && !q.data ? `The inbox is not answering: ${apiErrorText(q.error, 'no reply from Valkyrie')}` : !q.data ? 'Reading the inbox' : null
  const stampOf = (iso: string) => stamp(iso, now)
  const clockOf = (iso: string) => clock(iso, now)
  const needNew = b.need.reduce((a, g) => a + g.unread, 0)
  const needHot = b.need.some((g) => g.unread > 0 && g.level === 'alert')
  const mailNew = b.mail.reduce((a, m) => a + m.unread, 0)
  const reportNew = b.reports.reduce((a, g) => a + g.unread, 0)

  return (
    <div className="ib" data-board={onBoard || undefined}>
      <div className="ib-bar">
        <nav className="ib-tabs" aria-label="Inbox views">
          {TABS.map((t) => (
            <Press
              key={t.id}
              className="ib-tab"
              data-on={t.id === tab || undefined}
              aria-current={t.id === tab ? 'page' : undefined}
              onPress={() => { setOpenId(null); setOpenKey(null); setParam({ view: t.id === 'open' ? null : t.id, item: null }) }}
            >
              {t.label}
              {t.id === 'open' && unread > 0 && <span className="ib-tab-n">{unread}</span>}
            </Press>
          ))}
        </nav>
        {tab === 'open' && items.length > 0 && (
          <div className="ib-bar-acts">
            {shownUnread > 0 && (
              <Button kind="link" onPress={() => read.mutate({ sel: source ? { source } : { all: true }, value: true })}>Read all</Button>
            )}
            {items.some((it) => it.readAt) && (
              <Button kind="link" onPress={() => archive.mutate({ sel: source ? { source } : { all: true }, value: true, readOnly: true })}>Archive read</Button>
            )}
          </div>
        )}
      </div>

      {tab !== 'sources' && !onBoard && chips.length > 1 && (
        <div className="ib-chips" role="group" aria-label="Sources">
          <Press className="ib-chip" data-on={!source || undefined} onPress={() => setParam({ source: null, item: null })}>All</Press>
          {chips.map((s) => (
            <Press key={s.source} className="ib-chip" data-on={s.source === source || undefined} onPress={() => setParam({ source: s.source === source ? null : s.source, item: null })}>
              {sourceLabel(s.source)}
              {view === 'open' && s.unread > 0 && <span className="ib-chip-n">{s.unread}</span>}
            </Press>
          ))}
        </div>
      )}

      {status && <p className="ib-quiet">{status}</p>}

      {tab === 'sources' ? (
        <div className="ib-sources">
          <p className="ib-hint">Auto pushes warnings and alerts to your phone and keeps info quiet. On and Off override the sender.</p>
          {sources.length === 0 && q.data && <p className="ib-quiet">No sources yet. One appears the first time something posts under it.</p>}
          <div className="ib-rows">
            {sources.map((s) => (
              <div key={s.source} className="ib-src">
                <span className="ib-glyph" aria-hidden><Icon name={sourceIcon(s.source)} size={15} tone={s.unread ? 'fg' : 'dim'} glow={s.unread > 0} /></span>
                <div className="ib-src-text">
                  <b>{sourceLabel(s.source)}</b>
                  <span>{s.open} open{s.unread ? `, ${s.unread} unread` : ''}{s.lastAt ? ` · last ${when(s.lastAt, now)}` : ''}</span>
                </div>
                <Segmented className="ib-push" options={PUSH_OPTS} value={s.push} onChange={(v) => push.mutate({ src: s.source, value: v })} />
              </div>
            ))}
          </div>
        </div>
      ) : (
        <>
          {q.data && items.length === 0 && (
            <p className="ib-quiet">{view === 'archive' ? 'The archive is empty.' : source ? `Nothing open from ${sourceLabel(source)}.` : 'Nothing new.'}</p>
          )}
          {onBoard ? (
            <div className="ib-board">
              {(b.need.length > 0 || b.reports.length > 0) && (
                <div className="ib-col">
                {b.need.length > 0 && (
                  <Panel className={cx('ib-panel ib-need', needHot && 'ib-hot')} icon={needHot ? <Icon name="alert" size={14} tone="hot" glow /> : 'alert'} label="Needs you" lit={needNew > 0} value={needNew || undefined} unit={needNew ? 'new' : undefined}>
                    <div className="ib-rows">{b.need.map((g) => row(g, stampOf, true))}</div>
                  </Panel>
                )}
                {b.reports.length > 0 && (
                  <Panel className="ib-panel ib-reports" icon={FileText} label="Reports" lit={reportNew > 0} value={reportNew || undefined} unit={reportNew ? 'new' : undefined}>
                    <div className="ib-rows">{b.reports.map((g) => row(g, stampOf, false))}</div>
                  </Panel>
                )}
                </div>
              )}
              {b.mail.length > 0 && (
                <Panel className="ib-panel ib-mail" icon={Mail} label="Mail" lit={mailNew > 0} value={mailNew || undefined} unit={mailNew ? 'new' : undefined}>
                  {b.mail.map((box) => {
                    const all = more.has(box.source)
                    const shown: Group[] = []
                    let quiet = 0
                    for (const g of box.groups) {
                      const mustShow = g.unread > 0 || g.key === openKey || g.items.some((it) => it.id === openId)
                      if (!mustShow) quiet++
                      if (all || mustShow || quiet <= READ_SHOWN) shown.push(g)
                    }
                    const hidden = box.groups.length - shown.length
                    return (
                      <section key={box.source} className="ib-box">
                        <h3 className="ib-box-head">
                          <span>{sourceLabel(box.source).replace(/ mail$/, '')}</span>
                          <i>{box.unread > 0 ? `${box.unread} new of ${box.total}` : box.total}</i>
                        </h3>
                        <div className="ib-rows">{shown.map((g) => row(g, stampOf, false))}</div>
                        {(hidden > 0 || (all && quiet > READ_SHOWN)) && (
                          <Press className="ib-more" onPress={() => setMore((m) => { const next = new Set(m); if (all) next.delete(box.source); else next.add(box.source); return next })}>
                            {all ? 'Show fewer' : `Show ${hidden} more read`}
                          </Press>
                        )}
                      </section>
                    )
                  })}
                </Panel>
              )}
            </div>
          ) : (
            <div className="ib-rows ib-flat">
              {items.map((it, i) => {
                const day = dayLabel(it.lastAt, now)
                const newDay = i === 0 || dayLabel(items[i - 1].lastAt, now) !== day
                return (
                  <Fragment key={it.id}>
                    {newDay && <p className="ib-day">{day}</p>}
                    {row(single(it), clockOf, !source)}
                  </Fragment>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}
