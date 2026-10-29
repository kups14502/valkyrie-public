import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Button, Press, Segmented, toast } from '../kit/ui'
import { useTick } from '../kit/data'
import { apiErrorText } from '../../lib/api'
import {
  archiveInbox, fetchInbox, markInboxRead, setInboxPush,
  type InboxItem, type InboxPage as InboxData, type InboxSelection, type InboxView, type PushSetting,
} from '../../lib/inboxApi'
import { PageFrame } from './Calendar'
import './inbox.css'

// The inbox in v2 (/m/inbox): everything odin, thor and Valkyrie itself want to
// tell Brendon, newest first (backend/src/lib/inboxStore.ts has the rules). One
// row per item: a level mark, the title, a line of the body, the source and
// when. A row opens to the whole text, Open (the item's link), Mark unread and
// Archive; opening an unread row reads it. Open / Archive / Sources are text
// tabs; Sources sets each source's push. A push notification lands here with
// ?item=<id>, which opens and reads that row.
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

const full = (iso: string) => `${NY_FULL.format(Date.parse(iso))} ET`

const firstLine = (s: string) => s.split('\n').map((l) => l.trim()).find(Boolean) ?? ''

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
  const handled = useRef<number | null>(null)
  const rowRefs = useRef(new Map<number, HTMLDivElement>())

  const key = ['inbox', view, source ?? ''] as const
  const q = useQuery({
    queryKey: key,
    queryFn: () => fetchInbox(view, source),
    refetchInterval: () => (document.hidden ? false : 15_000),
    refetchOnWindowFocus: true,
  })
  const items = useMemo(() => q.data?.items ?? [], [q.data])
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

  const unread = count?.unread ?? 0
  const shownUnread = items.filter((it) => !it.readAt).length
  const chips = sources.filter((s) => (view === 'open' ? s.open > 0 : true) || s.source === source)
  const status = q.isError && !q.data ? `The inbox is not answering: ${apiErrorText(q.error, 'no reply from Valkyrie')}` : !q.data ? 'Reading the inbox' : null

  return (
    <div className="ib">
      <div className="ib-bar">
        <nav className="ib-tabs" aria-label="Inbox views">
          {TABS.map((t) => (
            <Press
              key={t.id}
              className="ib-tab"
              data-on={t.id === tab || undefined}
              aria-current={t.id === tab ? 'page' : undefined}
              onPress={() => { setOpenId(null); setParam({ view: t.id === 'open' ? null : t.id, item: null }) }}
            >
              {t.label}
              {t.id === 'open' && unread > 0 && <span className="ib-tab-n">{unread}</span>}
            </Press>
          ))}
        </nav>
        {tab === 'open' && items.length > 0 && (
          <div className="ib-bar-acts">
            {shownUnread > 0 && (
              <Button kind="link" onPress={() => read.mutate({ sel: source ? { source } : { all: true }, value: true })}>Mark all read</Button>
            )}
            {items.some((it) => it.readAt) && (
              <Button kind="link" onPress={() => archive.mutate({ sel: source ? { source } : { all: true }, value: true, readOnly: true })}>Archive read</Button>
            )}
          </div>
        )}
      </div>

      {tab !== 'sources' && chips.length > 1 && (
        <div className="ib-chips" role="group" aria-label="Sources">
          <Press className="ib-chip" data-on={!source || undefined} onPress={() => setParam({ source: null, item: null })}>All</Press>
          {chips.map((s) => (
            <Press key={s.source} className="ib-chip" data-on={s.source === source || undefined} onPress={() => setParam({ source: s.source === source ? null : s.source, item: null })}>
              {s.source}
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
                <div className="ib-src-text">
                  <b>{s.source}</b>
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
            <p className="ib-quiet">{view === 'archive' ? 'The archive is empty.' : source ? `Nothing open from ${source}.` : 'Nothing new.'}</p>
          )}
          <div className="ib-rows">
            {items.map((it) => {
              const open = it.id === openId
              const preview = firstLine(it.body)
              return (
                <div
                  key={it.id}
                  ref={(el) => { if (el) rowRefs.current.set(it.id, el); else rowRefs.current.delete(it.id) }}
                  className="ib-row"
                  data-open={open || undefined}
                  data-unread={!it.readAt || undefined}
                  data-level={it.level}
                >
                  <Press className="ib-row-main" aria-expanded={open} onPress={() => toggle(it)}>
                    <span className="ib-mark" aria-label={it.level === 'info' ? undefined : it.level} />
                    <span className="ib-text">
                      <b>
                        {it.title}
                        {it.count > 1 && <i className="ib-count"> ×{it.count}</i>}
                      </b>
                      {preview && !open && <span>{preview}</span>}
                    </span>
                    <span className="ib-meta">
                      <span className="ib-from">{it.source}</span>
                      <time dateTime={it.lastAt} title={full(it.lastAt)}>{when(it.lastAt, now)}</time>
                    </span>
                  </Press>
                  {open && (
                    <div className="ib-detail">
                      {it.body && <Linked text={it.body} />}
                      <div className="ib-acts">
                        {it.url && <Button kind="line" icon="go" onPress={() => openLink(it.url!)}>Open</Button>}
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
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
