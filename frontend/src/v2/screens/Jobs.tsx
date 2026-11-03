import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { Button, Press, toast } from '../kit/ui'
import type { ScreenProps } from '../kit/shell'
import { useTick } from '../kit/data'
import { apiErrorText } from '../../lib/api'
import { addDayKey, nyDayKey } from '../../lib/taskDue'
import { fetchJobs, setOutcome, skipJob, type Job, type JobView, type JobsPage as JobsData, type Outcome } from '../../lib/jobsApi'
import './jobs.css'

// The Jobs tab (/m/jobs/<applied|held|skipped>): what the auto-apply runner on odin sent
// (backend/src/routes/jobs.ts reads its SQLite file). Applied groups by the New
// York day it went out; a row opens to mark what came back (Interview,
// Rejected, Offer, Withdrawn), the posting, the resume used and any written
// answers the form got. Held is what the runner stopped on, with the reason and
// the form to finish by hand or Skip so the runner leaves it alone. Skipped is
// everything it passed on or could not reach. The line on top says how many
// went out today against the daily cap and when the next run starts.

const OUTCOMES: { id: Outcome; label: string }[] = [
  { id: 'interview', label: 'Interview' },
  { id: 'offer', label: 'Offer' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'withdrawn', label: 'Withdrawn' },
]

const REGIONS = ['TX/FL', 'NC/PA', 'Remote', 'Other']

const NY_DAY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' })
const NY_TIME = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })

const ATS: Record<string, string> = { greenhouse: 'Greenhouse', ashby: 'Ashby', lever: 'Lever', workday: 'Workday' }

/** Why a held or skipped row stopped, in his words rather than the runner's prefixes. */
function reason(j: Job): string {
  const d = j.detail.replace(/^(unknown(?: on '[^']+')?|fit|still empty|refused): /, '').replace(/\s*\|\|\s*/g, ' · ')
  if (j.status === 'closed') return 'Posting closed'
  if (j.status === 'limit') return 'Employer application limit'
  return d || j.status
}

function openUrl(u: string | null) {
  if (u) window.open(u, '_blank', 'noopener,noreferrer')
}

// The tab's sub-tabs (v2/App.tsx SCREENS): one per view
export const JOB_SUBS: { id: JobView; label: string }[] = [
  { id: 'applied', label: 'Applied' },
  { id: 'held', label: 'Held' },
  { id: 'skipped', label: 'Skipped' },
]

export default function Jobs({ active, sub }: ScreenProps) {
  const view: JobView = sub === 'held' || sub === 'skipped' ? sub : 'applied'
  return (
    <div className="vl-screen">
      <JobsScreen view={view} active={active} />
    </div>
  )
}

function JobsScreen({ view, active }: { view: JobView; active: boolean }) {
  const [params, setParams] = useSearchParams()
  const qc = useQueryClient()
  const now = useTick(60_000)
  const region = params.get('region')
  const [openId, setOpenId] = useState<string | null>(null)

  const key = ['jobs', view] as const
  const q = useQuery({
    queryKey: key,
    queryFn: () => fetchJobs(view),
    enabled: active,
    refetchInterval: () => (document.hidden || !active ? false : 60_000),
    refetchOnWindowFocus: true,
  })
  const all = useMemo(() => q.data?.items ?? [], [q.data])
  const counts = q.data?.counts

  const setParam = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(params)
    for (const [k, v] of Object.entries(next)) {
      if (v == null) p.delete(k)
      else p.set(k, v)
    }
    setParams(p, { replace: true, state: window.history.state?.usr })
  }

  const refresh = () => { void qc.invalidateQueries({ queryKey: ['jobs'] }) }
  const patchList = (fn: (j: Job) => Job | null) => {
    qc.setQueryData<JobsData>(key, (d) => d && { ...d, items: d.items.map(fn).filter((x): x is Job => x !== null) })
  }
  const fail = (what: string) => (e: unknown) => toast(`${what}: ${apiErrorText(e, 'Valkyrie did not answer')}`, { ms: 4000 })

  const mark = useMutation({
    mutationFn: ({ j, outcome }: { j: Job; outcome: Outcome | null }) => setOutcome(j.jobId, outcome),
    onMutate: ({ j, outcome }) => patchList((x) => (x.jobId === j.jobId ? { ...x, outcome, outcomeAt: outcome ? Date.now() : null } : x)),
    onSuccess: (_r, { j, outcome }) => {
      const label = OUTCOMES.find((o) => o.id === outcome)?.label
      toast(label ? `${j.company}: ${label}` : `${j.company}: cleared`, {
        action: { label: 'Undo', run: () => mark.mutate({ j, outcome: j.outcome }) },
      })
    },
    onError: fail('Could not mark it'),
    onSettled: refresh,
  })

  const skip = useMutation({
    mutationFn: (j: Job) => skipJob(j.jobId),
    onMutate: (j) => patchList((x) => (x.jobId === j.jobId ? null : x)),
    onSuccess: (_r, j) => toast(`Skipped: ${j.company}`),
    onError: fail('Could not skip it'),
    onSettled: refresh,
  })

  const shown = useMemo(() => all.filter((j) => !region || j.region === region), [all, region])
  const regions = useMemo(() => REGIONS.filter((r) => all.some((j) => j.region === r)), [all])

  // Applied groups by the New York day it went out; the other views are one list
  const groups = useMemo(() => {
    if (view !== 'applied') return [{ id: 'all', label: '', jobs: shown }]
    const today = nyDayKey(now)
    const yesterday = addDayKey(today, -1)
    const by = new Map<string, Job[]>()
    for (const j of shown) {
      const k = j.at ? nyDayKey(j.at) : 'unknown'
      by.set(k, [...(by.get(k) ?? []), j])
    }
    return [...by.entries()].map(([k, jobs]) => ({
      id: k,
      label: k === today ? 'Today' : k === yesterday ? 'Yesterday' : k === 'unknown' ? 'Earlier' : NY_DAY.format(jobs[0].at!),
      jobs,
    }))
  }, [shown, view, now])

  const status = q.isError && !q.data
    ? `Applications are not answering: ${apiErrorText(q.error, 'no reply from Valkyrie')}`
    : !q.data ? 'Reading applications' : null

  return (
    <div className="jb">
      {counts && q.data && (
        <p className="jb-sum">
          <span>{counts.applied} applied</span>
          <span data-on={counts.today > 0 || undefined}>{counts.today} of {q.data.cap} today</span>
          {counts.replies > 0 && <span data-on="">{counts.replies} {counts.replies === 1 ? 'reply' : 'replies'}</span>}
          <span>{counts.held} held</span>
          <span>{counts.skipped} skipped</span>
          <span>Next run {q.data.runs}</span>
        </p>
      )}

      {regions.length > 1 && (
        <div className="jb-chips" role="group" aria-label="Regions">
          <Press className="jb-chip" data-on={!region || undefined} onPress={() => setParam({ region: null })}>All</Press>
          {regions.map((r) => (
            <Press key={r} className="jb-chip" data-on={r === region || undefined} onPress={() => setParam({ region: r === region ? null : r })}>
              {r}
              <span className="jb-chip-n">{all.filter((j) => j.region === r).length}</span>
            </Press>
          ))}
        </div>
      )}

      {status && <p className="jb-quiet">{status}</p>}
      {q.data && shown.length === 0 && (
        <p className="jb-quiet">{view === 'held' ? 'Nothing held.' : view === 'skipped' ? 'Nothing skipped.' : 'Nothing sent yet.'}</p>
      )}

      {groups.filter((g) => g.jobs.length > 0).map((g) => (
        <section key={g.id} className="jb-group">
          {g.label && <h2 className="jb-ghead"><span>{g.label}</span><span className="jb-gn">{g.jobs.length}</span></h2>}
          <div className="jb-rows">
            {g.jobs.map((j) => {
              const open = j.jobId === openId
              return (
                <div key={j.jobId} className="jb-row" data-open={open || undefined}>
                  <Press className="jb-main" aria-expanded={open} onPress={() => setOpenId(open ? null : j.jobId)}>
                    <span className="jb-what">
                      <span className="jb-co">{j.company}</span>
                      <span className="jb-title">{j.title}</span>
                      {view !== 'applied' && <span className="jb-why">{reason(j)}</span>}
                    </span>
                    <span className="jb-meta">
                      {j.outcome
                        ? <span className="jb-out" data-out={j.outcome}>{OUTCOMES.find((o) => o.id === j.outcome)?.label}</span>
                        : <span className="jb-region">{j.region}</span>}
                      {j.at && <span className="jb-time">{view === 'applied' ? NY_TIME.format(j.at) : NY_DAY.format(j.at)}</span>}
                    </span>
                  </Press>
                  {open && (
                    <Detail
                      j={j}
                      view={view}
                      busy={mark.isPending || skip.isPending}
                      onOutcome={(o) => mark.mutate({ j, outcome: o === j.outcome ? null : o })}
                      onSkip={() => { setOpenId(null); skip.mutate(j) }}
                    />
                  )}
                </div>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}

/** An open row: what came back (applied), or why it stopped and what to do about it. */
function Detail({ j, view, busy, onOutcome, onSkip }: {
  j: Job
  view: JobView
  busy: boolean
  onOutcome: (o: Outcome) => void
  onSkip: () => void
}) {
  const where = [j.location, ATS[j.ats] ?? j.ats, j.resume && `${j.resume} resume`].filter(Boolean).join(' · ')
  return (
    <div className="jb-detail">
      {view === 'applied' && (
        <div className="jb-outs" role="group" aria-label="What came back">
          {OUTCOMES.map((o) => (
            <Press
              key={o.id}
              className="jb-pick"
              data-on={o.id === j.outcome || undefined}
              data-out={o.id}
              aria-pressed={o.id === j.outcome}
              disabled={busy}
              onPress={() => onOutcome(o.id)}
            >
              {o.label}
            </Press>
          ))}
        </div>
      )}
      {view !== 'applied' && <p className="jb-reason">{reason(j)}</p>}
      <div className="jb-acts">
        {view === 'held' && j.form && <Button kind="line" icon="popout" onPress={() => openUrl(j.form)}>Open form</Button>}
        {j.posting && <Button kind="link" onPress={() => openUrl(j.posting)}>Posting</Button>}
        {view === 'held' && <Button kind="link" onPress={onSkip}>Skip</Button>}
        <span className="jb-where">{where}</span>
      </div>
      {j.answers.length > 0 && (
        <div className="jb-answers">
          <span className="jb-k">What the form was told</span>
          {j.answers.map((x, i) => (
            <div key={i} className="jb-ans">
              {x.q && <p className="jb-q">{x.q}</p>}
              <p className="jb-a">{x.a}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
