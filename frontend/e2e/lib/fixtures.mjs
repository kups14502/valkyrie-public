// Stand-ins for the API, for the tests that need a known state (a light that
// is on, a session that is live, a service that is down). Generic names only:
// this repo is public. Each builder returns a fresh, mutable state, and the
// write tests change it the way the real backend would, so the screen's
// refetch after a write reads back what was written.

const iso = (ms) => new Date(ms).toISOString()

// ---------- lights (Home Assistant through /api/lights) ----------

export function lightsState() {
  const bulb = (entity_id, name, on, extra = {}) => ({
    entity_id, name, on, unavailable: false, brightness: on ? 128 : null, rgb_color: on ? [255, 217, 160] : null,
    color_temp_kelvin: null, color_mode: on ? 'rgb' : null, supported_color_modes: ['rgb', 'color_temp'], min_kelvin: 2000, max_kelvin: 6500,
    ...extra,
  })
  return [
    bulb('light.e2e_desk', 'Desk', true),
    bulb('light.e2e_lamp', 'Lamp', false),
    bulb('light.e2e_strip', 'Strip', false, { unavailable: true }),
  ]
}

/** Applies a /api/lights/turn body to the state, the way Home Assistant would. */
export function applyLight(state, u) {
  const ids = Array.isArray(u.entity_id) ? u.entity_id : [u.entity_id]
  for (const l of state) {
    if (!ids.includes(l.entity_id) || l.unavailable) continue
    l.on = u.state === 'on'
    if (!l.on) continue
    if (u.brightness != null) l.brightness = u.brightness
    if (l.brightness == null) l.brightness = 128
    if (u.rgb_color) { l.rgb_color = u.rgb_color; l.color_temp_kelvin = null; l.color_mode = 'rgb' }
    if (u.color_temp_kelvin) { l.color_temp_kelvin = u.color_temp_kelvin; l.rgb_color = null; l.color_mode = 'color_temp' }
    if (!l.rgb_color && !l.color_temp_kelvin) { l.rgb_color = [255, 217, 160]; l.color_mode = 'rgb' }
  }
}

// ---------- Thor RGB ----------

export function rgbState(state = 'dark') {
  const at = iso(Date.now() - 3 * 3_600_000)
  return { state, openrgb: true, storm: state === 'lit', tasks: { relight: { lastRun: at, lastResult: 0 }, dark: { lastRun: at, lastResult: 0 } } }
}

// ---------- the daily tracker ----------

export const shiftKey = (key, days) => {
  const [y, m, d] = key.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + days))
  return t.toISOString().slice(0, 10)
}

/** taken[tracker][dateKey] = ISO time or undefined. Yesterday is done for all three, so no Yesterday/Today picker shows late at night. */
export function trackerState() {
  return { taken: { supplements: {}, exercise: {}, sf: {} }, streak: 3 }
}

export function trackerWindow(st, tracker, date, today) {
  const days = [-1, 0, 1].map((k) => {
    const key = shiftKey(date, k)
    const yesterday = key === shiftKey(today, -1)
    const at = st.taken[tracker][key] ?? (yesterday ? iso(Date.now() - 86_400_000) : undefined)
    return { date: key, taken: !!at, takenAt: at ?? null }
  })
  return { date, today, days, streak: st.streak }
}

// ---------- launch targets, hosts that can start sessions, odin ----------

export const TARGETS = {
  targets: [
    { key: 'alpha', label: 'Alpha', exists: true, phone: true, project: false, group: null },
    { key: 'beta', label: 'Beta (notes)', exists: true, phone: true, project: false, group: null },
    { key: 'gamma', label: 'Gamma', exists: true, phone: false, project: false, group: null },
  ],
}

export const SESSION_HOSTS = {
  hosts: [{ host: 'thor', configured: true, reachable: true, canLaunch: true, canPage: true, detail: null }],
}

export const ODIN_TARGETS = { host: 'odin', ready: true, detail: null, source: 'config', targets: [{ key: 'home', label: 'Odin home' }] }

/** What POST /api/terminal/sessions answers: a pane name and its row. */
export function termOpened(body) {
  const name = 'vk-e2e0000a01'
  const now = Date.now()
  return {
    name,
    session: {
      name, label: body.label ?? body.target ?? 'e2e', mode: body.mode ?? 'new', host: body.host ?? 'thor', target: body.target ?? '',
      sessionId: '', createdAt: now, activityAt: now, clients: 0, dead: false, deadStatus: null, deadText: '', size: '80x24', projectId: '',
    },
    conversationId: '0e2e0000-0000-4000-8000-000000000001',
    runId: null,
  }
}

// ---------- the session board ----------

export const LIVE_ID = '0e2e0000-0000-4000-8000-00000000000a'
export const CLOSED_ID = '0e2e0000-0000-4000-8000-00000000000b'

export function boardState() {
  const now = Date.now()
  const row = (sessionId, title, live, activity, ago) => ({
    sessionId, title, titleFromClaude: true, project: 'e2e-folder', area: 'personal', launchGroup: null, host: 'thor', cwd: null,
    lastActivityUtc: iso(now - ago), bytes: 1000, live, onDesk: live, activity, disposition: 'open', resumeCommand: `claude --resume ${sessionId}`,
  })
  return {
    sessions: [
      row(LIVE_ID, 'E2E live session', true, 'working', 20_000),
      row(CLOSED_ID, 'E2E closed session', false, 'closed', 3_600_000),
    ],
    hookRunsSkipped: 0,
  }
}

// ---------- services ----------

export function servicesState() {
  return {
    containers: [
      { id: 'e2e1', name: 'e2e-sample', image: 'busybox:latest', state: 'exited', status: 'Exited (1) 5 minutes ago', ports: [], project: null },
      { id: 'e2e2', name: 'e2e-web', image: 'nginx:latest', state: 'running', status: 'Up 2 days', ports: [], project: null },
    ],
    services: [{ name: 'e2e-api.service', load: 'loaded', active: 'active', sub: 'running', description: 'E2E sample API' }],
    systemServices: [],
    timers: [],
  }
}

// ---------- media request search ----------

export const SEARCH = {
  results: [{
    kind: 'movie', title: 'E2E Sample Film', artist: null, year: 2001, overview: 'A film that exists only in the e2e suite.', poster: null,
    tmdbId: 990001, tvdbId: null, foreignAlbumId: null, inLibrary: false, downloaded: false,
  }],
}

// ---------- keeping thor quiet ----------

/**
 * Stand-ins for the reads that go through to thor (the session board, launch
 * targets, Thor RGB). Thor's agent answers them one at a time (the 390 KB board
 * takes about 1.6 s each), so every extra page reading them makes the route
 * tests wait in its queue. Tests that are not about that data use these.
 */
export function quietThor(page) {
  const ok = (body) => ({ status: 200, body })
  page.mock('/api/session-board', () => ok({ sessions: [], hookRunsSkipped: 0 }))
  page.mock('/api/hosts/thor/sessions', () => ok({ sessions: [], hookRunsSkipped: 0 }))
  page.mock('/api/hosts/thor/launch-targets', () => ok(TARGETS))
  page.mock('/api/hosts/thor/rgb', () => ok(rgbState('lit')))
  page.mock('/api/session-hosts', () => ok(SESSION_HOSTS))
  page.mock('/api/terminal/sessions', () => ok([]))
}

// ---------- trade bot ----------

/**
 * A trade status built from the real one (read once through the probe), with
 * at least two days of history so the chart draws. `bump` shifts the equity
 * and the 7-day change, so a reader can tell one read from the next.
 */
export function tradeStatus(real, bump = 0) {
  const t = structuredClone(real ?? {})
  t.generated_at = iso(Date.now())
  t.market ??= { is_open: false, reason: 'weekend' }
  t.up ??= true
  t.up_detail ??= 'all arms healthy'
  t.spend ??= { total_usd: 1, today_usd: 0, calls_total: 1, calls_today: 0 }
  t.experiment ??= { live_trips: 1, target_trips: 100, rules_ok: true }
  t.portfolio ??= {}
  t.stale = false
  const base = typeof t.portfolio.live_equity === 'number' ? t.portfolio.live_equity : 1000
  t.portfolio.live_equity = Math.round((base + bump) * 100) / 100
  t.portfolio.live_equity_source = 'sample'
  t.portfolio.live_equity_age_min = 1
  t.history ??= {}
  if (!Array.isArray(t.history.points) || t.history.points.length < 4) {
    const day = 86_400_000
    const t0 = Date.parse('2026-10-12T14:00:00Z')
    t.history.points = [0, 1, 2, 3].flatMap((d) => [0, 2, 4].map((h) => ({ ts: iso(t0 + d * day + h * 3_600_000), total: base + d * 3 - h })))
  }
  t.history.window_days ??= 7
  const chg = typeof t.history.change_usd === 'number' ? t.history.change_usd : -12.5
  t.history.change_usd = Math.round((chg + bump) * 100) / 100
  t.history.change_pct ??= -0.5
  return t
}
