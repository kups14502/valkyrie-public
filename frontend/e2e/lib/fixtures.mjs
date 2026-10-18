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

// ---------- AI > Sessions with every group: live, recent, done, open panes ----------

export const BOARD_IDS = {
  live: LIVE_ID,
  closed: CLOSED_ID,
  zeta: '0e2e0000-0000-4000-8000-0000000000c2',
  done1: '0e2e0000-0000-4000-8000-0000000000d1',
  done2: '0e2e0000-0000-4000-8000-0000000000d2',
}

/** A board with one live session, two recent ones (one in a folder named zeta) and two done ones. */
export function fullBoardState() {
  const now = Date.now()
  const row = (sessionId, title, { live = false, activity = 'closed', ago, done = false, project = 'e2e-folder', cwd = null }) => ({
    sessionId, title, titleFromClaude: true, project, area: 'personal', launchGroup: null, host: 'thor', cwd,
    lastActivityUtc: iso(now - ago), bytes: 1000, live, onDesk: live, activity, disposition: done ? 'done' : 'open',
    resumeCommand: `claude --resume ${sessionId}`,
  })
  return {
    sessions: [
      row(BOARD_IDS.live, 'E2E live session', { live: true, activity: 'working', ago: 20_000 }),
      row(BOARD_IDS.closed, 'E2E closed session', { ago: 3_600_000 }),
      row(BOARD_IDS.zeta, 'E2E notes cleanup', { ago: 7_200_000, project: 'e2e-notes', cwd: 'C:\\e2e\\folder-zeta' }),
      row(BOARD_IDS.done1, 'E2E done one', { ago: 5 * 3_600_000, done: true }),
      row(BOARD_IDS.done2, 'E2E done two', { ago: 6 * 3_600_000, done: true }),
    ],
    hookRunsSkipped: 0,
  }
}

/** Two open tmux panes (made-up names; a page heading for one is refused its socket). */
export function panesState() {
  const now = Date.now()
  const pane = (name, label, host, mode, target, age) => ({
    name, label, host, mode, target, sessionId: '', createdAt: now - age, activityAt: now - 60_000,
    clients: 0, dead: false, deadStatus: null, deadText: '', size: '80x24', projectId: '',
  })
  return [
    pane('vk-e2e00000b1', 'E2E shell', 'odin', 'shell', 'home', 600_000),
    pane('vk-e2e00000b2', 'E2E pane', 'thor', 'new', 'alpha', 300_000),
  ]
}

// ---------- a Valkyrie project with a checklist and a reminder ----------

export const PROJ_ID = 'e2e-proj'

export function projState() {
  const now = Date.now()
  const at = iso(now - 3_600_000)
  const project = {
    id: PROJ_ID, name: 'E2E Project', area: 'personal', targetKey: 'alpha', summary: 'A project that exists only in the e2e suite.',
    nextAction: 'Write the e2e test', status: 'active', exposure: 'tailnet', allowSnapshots: false, sessionEdits: false,
    sortOrder: 0, rev: 1, metaRev: 1, createdAt: at, updatedAt: at,
  }
  const item = (id, text) => ({ id, text, done: false, doneAt: null })
  const doc = {
    project,
    tabs: [{
      id: 'tab-e2e1', projectId: PROJ_ID, kind: 'checklist', title: 'Tasks', body: '',
      items: [item('it-e2e1', 'First e2e task'), item('it-e2e2', 'Second e2e task')],
      sortOrder: 0, rev: 1, createdBy: 'ui', updatedBy: 'ui', createdAt: at, updatedAt: at,
    }],
    files: [], automations: [], runs: [], sessions: [],
    reminders: [{ id: 'rem-e2e1', at: iso(now + 3 * 3_600_000), message: 'E2E reminder', state: 'pending', createdBy: 'ui', createdAt: at, canceledAt: null }],
    lastEvent: null,
  }
  return { doc }
}

/** GET /api/proj from the doc. */
export function projList(st) {
  const p = st.doc.project
  const pending = st.doc.reminders.filter((r) => r.state === 'pending').map((r) => r.at).sort()
  return [{
    id: p.id, name: p.name, area: p.area, status: p.status, summary: p.summary, nextAction: p.nextAction, targetKey: p.targetKey,
    exposure: p.exposure, sessionIds: [], nextReminderAt: pending[0] ?? null, updatedAt: p.updatedAt, rev: p.rev, lastEvent: null,
  }]
}

// ---------- the trade bot's full page (/api/tradebot/page) ----------

/**
 * The page System > Trades reads, around the real status (tradeStatus): two
 * open positions, three fills (two legs of one order and a sell), and two
 * judged scans (one executed over the gate, one that wanted no trade).
 */
export function tradePage(real) {
  const now = Date.now()
  const at = (ago) => iso(now - ago)
  const fill = (ago, symbol, side, quantity, price, order) => ({ ts: at(ago), symbol, side, quantity, price, state: 'filled', placed_agent: 'agentic', order_id: order })
  return {
    generated_at: at(0),
    status: tradeStatus(real),
    stale: false,
    broker: {
      generated_at: at(60_000),
      positions: [
        { symbol: 'E2EA', quantity: 3, shares_available_for_sells: 3, average_buy_price: 12.34 },
        { symbol: 'E2EB', quantity: 0.5, shares_available_for_sells: 0, average_buy_price: 101.5 },
      ],
      fills: [
        fill(3_600_000, 'E2EA', 'buy', 2, 12.3, 'e2e-ord-1'),
        fill(3_590_000, 'E2EA', 'buy', 1, 12.42, 'e2e-ord-1'),
        fill(26 * 3_600_000, 'E2EC', 'sell', 4, 20, 'e2e-ord-2'),
      ],
      realized: { pnl_usd: 12.5, round_trips: 3 },
    },
    broker_error: null,
    decisions: [
      { ts: at(3_700_000), arm: 'live', regime: 'risk_on', confidence: 0.82, trade_needed: true, trades_proposed: 1, summary: 'E2E executed scan: one name cleared the gate.', gate: 'executed', cost_usd: 0.0123, shortlist: [{ symbol: 'E2EA', change_pct: 4.2, rvol: 2.5 }] },
      { ts: at(27 * 3_600_000), arm: 'live', regime: 'risk_off', confidence: 0.2, trade_needed: false, trades_proposed: 0, summary: 'E2E quiet scan: standing aside.', gate: null, cost_usd: 0, shortlist: [] },
    ],
    decisions_unverified: 0,
    decisions_truncated: 0,
    config: {
      min_confidence_to_trade: 0.7, max_position_pct: 20, max_single_trade_pct: 10, max_trades_per_day: 4, daily_loss_limit_pct: 3,
      stop_loss_pct: 8, gain_trim_pct: 15, gain_trim_partial_pct: 50, model: 'e2e-model', watchlist: ['E2EA', 'E2EB'],
      screener: { enabled: true, shortlist_size: 8, min_abs_change_pct: 3, min_market_cap: 2e9, min_relative_volume: 1.5 },
      tiers: [{ tier: 'high', min_confidence: 0.85, max_single_trade_pct: 10 }, { tier: 'base', min_confidence: 0.7, max_single_trade_pct: 5 }],
    },
  }
}

// ---------- Plex: a small movie library and a music server ----------

/** Six movies that exercise the search and the sorts: accents, a leading article, a digit title, years, ratings, added dates. */
export function plexMovies() {
  const now = Math.floor(Date.now() / 1000)
  const day = 86_400
  const m = (ratingKey, title, year, rating, addedDaysAgo) => ({
    ratingKey, type: 'movie', title, year, summary: `${title}, a film that exists only in the e2e suite.`, thumb: null, art: null, rating, contentRating: 'PG-13',
    duration: 6_000_000, addedAt: now - addedDaysAgo * day, leafCount: null, childCount: null, watchPath: null,
  })
  return [
    m('e2e-m1', 'Spider-Man', 2002, 7.4, 5),
    m('e2e-m2', 'The Amazing Spider-Man', 2012, 6.9, 1),
    m('e2e-m3', 'Amélie', 2001, 8.3, 10),
    m('e2e-m4', 'Zodiac', 2007, 7.7, 2),
    m('e2e-m5', '2001: A Space Odyssey', 1968, 8.0, 30),
    m('e2e-m6', 'Spider-Man: Into the Spider-Verse', 2018, 8.4, 3),
  ]
}

/** The reads the Movies and Shows lists make: sections, then each section's pages. */
export function plexLibrary(page, movies = plexMovies()) {
  const ok = (body) => ({ status: 200, body })
  page.mock('/api/plex/sections', () => ok([
    { key: 'e2e-1', title: 'Movies', type: 'movie', count: movies.length, server: 'main' },
    { key: 'e2e-2', title: 'TV Shows', type: 'show', count: 0, server: 'main' },
  ]))
  page.mock('/api/plex/library', ({ query }) => ok(query.section === 'e2e-1'
    ? { total: movies.length, offset: Number(query.offset ?? 0), items: Number(query.offset ?? 0) ? [] : movies }
    : { total: 0, offset: 0, items: [] }))
  page.mock('/api/plex/img-token', () => ok({ token: 'e2e', expiresAt: Date.now() + 3_600_000 }))
}

export function musicArtists() {
  const a = (ratingKey, title, genre, albumCount) => ({ ratingKey, title, thumb: null, art: null, summary: '', genres: [genre], albumCount, addedAt: null, lastPlayedAt: null })
  return [a('e2e-a1', 'Ásgeir', 'Folk', 3), a('e2e-a2', 'The Beatles', 'Rock', 13), a('e2e-a3', 'Boards of Canada', 'Electronic', 4)]
}

/** The music server: the artist index, recent, and a search that answers per query. */
export function musicServer(page, searches = {}) {
  const ok = (body) => ({ status: 200, body })
  const artists = musicArtists()
  page.mock('/api/plex/music/artists', ({ query }) => ok({ total: artists.length, offset: Number(query.offset ?? 0), items: Number(query.offset ?? 0) ? [] : artists }))
  page.mock('/api/plex/music/albums', () => ok({ total: 0, offset: 0, items: [] }))
  page.mock('/api/plex/music/recent', () => ok({ played: [], added: [] }))
  page.mock('/api/plex/music/search', ({ query }) => ok(searches[(query.q ?? '').toLowerCase()] ?? { artists: [], albums: [], tracks: [] }))
  page.mock('/api/plex/img-token', () => ok({ token: 'e2e', expiresAt: Date.now() + 3_600_000 }))
}

/** What the music search answers for "bea": an artist the index lacks, an album, a track. */
export const MUSIC_BEA = {
  artists: [{ ratingKey: 'e2e-a9', title: 'Beach House', thumb: null, art: null, summary: '', genres: ['Dream pop'], albumCount: 8, addedAt: null, lastPlayedAt: null }],
  albums: [{ ratingKey: 'e2e-al1', title: 'Abbey Road', artist: 'The Beatles', artistKey: 'e2e-a2', year: 1969, thumb: null, trackCount: 17, genres: ['Rock'], addedAt: null, lastPlayedAt: null }],
  tracks: [{ ratingKey: 'e2e-t1', title: 'Come Together', index: 1, disc: 1, album: 'Abbey Road', albumKey: 'e2e-al1', artist: 'The Beatles', artistKey: 'e2e-a2', trackArtist: null, year: 1969, duration: 259_000, thumb: null, streamKey: null, container: null, codec: null, bitrate: null }],
}

// ---------- the calendar: one local calendar and one read-only feed ----------

export const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Sources plus events, mutable: the write tests change it the way the backend would. */
export function calendarState() {
  const day = localDay()
  const local = { id: 'e2e-local', kind: 'local', label: 'Valkyrie', color: '#33ccff', urlHint: '', tz: 'America/New_York', enabled: true, fetchedAt: null, error: null }
  const feed = { id: 'e2e-feed', kind: 'ics', label: 'E2E feed', color: '#cc66ff', urlHint: 'example.test/e2e.ics', tz: 'America/New_York', enabled: true, fetchedAt: iso(Date.now() - 600_000), error: null }
  return {
    sources: [local, feed],
    local: [{ id: 'e2e-ev1', sourceId: 'e2e-local', title: 'E2E standup', notes: 'Bring the e2e notes.', location: 'Desk', allDay: false, start: `${day}T10:00`, end: `${day}T10:30`, rrule: '' }],
    feed: [{ uid: 'e2e-feed-1', summary: 'E2E feed meeting', location: '', description: '', organizer: '', status: 'CONFIRMED', start: `${day}T15:00:00`, end: `${day}T16:00:00`, allDay: false, recurring: false, url: '', sourceId: 'e2e-feed', sourceLabel: 'E2E feed', color: '#cc66ff' }],
    seq: 1,
  }
}

/** A stored local event as /calendar/events returns it (wall clock read in the browser's zone, New York on thor). */
function localAsEvent(st, e) {
  const src = st.sources.find((s) => s.id === e.sourceId)
  const toIso = (v, allDay) => (allDay ? v : new Date(v).toISOString())
  return {
    uid: `local-${e.id}`, summary: e.title, location: e.location, description: e.notes, organizer: '', status: 'CONFIRMED',
    start: toIso(e.start, e.allDay), end: toIso(e.end, e.allDay), allDay: e.allDay, recurring: !!e.rrule, url: '',
    sourceId: e.sourceId, sourceLabel: src?.label ?? '', color: src?.color ?? '', local: e,
  }
}

/** GET mocks for the calendar over one mutable state. */
export function calendarBackend(page, st) {
  const ok = (body) => ({ status: 200, body })
  page.mock('/api/calendar/sources', () => ok({ sources: st.sources, tz: 'America/New_York' }))
  page.mock('/api/calendar/events', () => ok({
    events: [...st.feed.map((e) => ({ ...e, start: new Date(e.start).toISOString(), end: new Date(e.end).toISOString() })), ...st.local.map((e) => localAsEvent(st, e))],
    tz: 'America/New_York',
    sources: st.sources,
  }))
}

// ---------- meals: a day with two entries ----------

export function mealsState(date) {
  const meal = (id, slot, time, name, calories, protein, carbs, fat, fiber) => ({
    id, date, time, slot, name, servings: 1, calories, protein, carbs, fat, fiber, note: '', source: 'manual', photoId: '',
    createdAt: iso(Date.now() - 3_600_000), updatedAt: iso(Date.now() - 3_600_000),
  })
  return {
    meals: [meal('e2e-meal1', 'breakfast', '08:10', 'E2E yogurt', 220, 18, 26, 4, 4), meal('e2e-meal2', 'lunch', '12:40', 'E2E burrito bowl', 690, 48, 72, 22, 12)],
    targets: { calories: 2200, protein: 160, carbs: 220, fat: 70, fiber: 30, updatedAt: iso(Date.now() - 86_400_000) },
    seq: 2,
  }
}

export function mealTotals(meals) {
  const sum = (k) => meals.reduce((s, m) => s + m[k] * (m.servings || 1), 0)
  return { calories: sum('calories'), protein: sum('protein'), carbs: sum('carbs'), fat: sum('fat'), fiber: sum('fiber') }
}

/** GET mocks for Meals over one mutable state (any other date is empty). */
export function mealsBackend(page, st, date) {
  const ok = (body) => ({ status: 200, body })
  page.mock('/api/meals/day', ({ query }) => {
    const list = query.date === date ? st.meals : []
    return ok({ date: query.date, meals: list, totals: mealTotals(list), targets: st.targets })
  })
  page.mock('/api/meals/range', ({ query }) => ok({ from: query.from, to: query.to, targets: st.targets, days: [{ date, entries: st.meals.length, totals: mealTotals(st.meals) }] }))
  page.mock('/api/meals/targets', () => ok({ targets: st.targets }))
}
