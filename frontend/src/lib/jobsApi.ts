import { api } from './api'

// Job applications (backend/src/routes/jobs.ts): the auto-apply runner's latest
// attempt per job, and the outcomes Brendon marks on the ones that went out.

export type JobView = 'applied' | 'held' | 'skipped'
export type Outcome = 'interview' | 'rejected' | 'offer' | 'withdrawn'

export type Job = {
  jobId: string
  company: string
  title: string
  location: string
  /** 'TX/FL' | 'NC/PA' | 'Remote' | 'Other' */
  region: string
  /** greenhouse, ashby, lever, workday */
  ats: string
  /** the runner's status: applied, needs-review, skipped, closed, failed, limit */
  status: string
  /** epoch ms of the attempt */
  at: number | null
  /** why it was held or skipped, or the confirmation URL */
  detail: string
  form: string | null
  posting: string | null
  resume: string | null
  outcome: Outcome | null
  outcomeAt: number | null
  /** written answers the form got (applied only) */
  answers: { q: string; a: string }[]
}

export type JobsPage = {
  view: JobView
  /** submissions allowed per day */
  cap: number
  /** when the daily run starts, New York time, e.g. "7:00 AM" */
  runs: string
  counts: { applied: number; held: number; skipped: number; today: number; replies: number }
  items: Job[]
}

export const fetchJobs = async (view: JobView): Promise<JobsPage> =>
  (await api.get<JobsPage>('/jobs', { params: { view } })).data

export const setOutcome = async (jobId: string, outcome: Outcome | null): Promise<void> => {
  await api.post(`/jobs/${encodeURIComponent(jobId)}/outcome`, { outcome })
}

export const skipJob = async (jobId: string): Promise<void> => {
  await api.post(`/jobs/${encodeURIComponent(jobId)}/skip`)
}
