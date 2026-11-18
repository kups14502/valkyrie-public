// The git repos on odin that Projects (routes/projects.ts) and the activity
// feed (routes/activity.ts) read, in display order. A feature adds its own
// through index.ts (BackendFeature.repos).
const REPOS: string[] = [
  '/home/brendon/valkyrie',
  '/home/brendon/msp-platform',
  '/home/brendon/trading',
  '/home/brendon/infra',
]

/** Adds repos once each: right after `after` when that one is listed, else at the end. */
export function addTrackedRepos(extra: { path: string; after?: string }[]): void {
  for (const r of extra) {
    if (REPOS.includes(r.path)) continue
    const i = r.after ? REPOS.indexOf(r.after) : -1
    if (i >= 0) REPOS.splice(i + 1, 0, r.path)
    else REPOS.push(r.path)
  }
}

export const trackedRepos = (): readonly string[] => REPOS
