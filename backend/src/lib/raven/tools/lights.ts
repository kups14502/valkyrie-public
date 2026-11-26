import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { nyWallToMs } from '../../claudeCli.js'
import { apiBrightness, pctFromApi } from '../../lightScale.js'
import {
  checkSunrise, hmBefore, rampAt, realDate, realHm, SunriseError, sunriseId, sunriseWindowEnd, SUNRISE_ID_RE, SUNRISE_STEP_S, SUNRISE_VERSION, type SunriseMeta,
} from '../../sunrise.js'
import { nyToday } from '../../tasksStore.js'
import type { LightRow, SunriseRow } from '../../../routes/lights.js'
import type { RavenToolCtx } from '../types.js'
import { io } from './io.js'
import { apiJson, dueLabel, needBrendon, RavenToolError, routeError, toolRun } from './util.js'

// Brendon's Home Assistant lights, through Valkyrie's own light engine on
// loopback (routes/lights.ts), never HA's light service: every change gets the
// engine's per-bulb queue, its exact-percent brightness and its screen-sync
// release, the same as a tap in the app. Sunrises are one-time HA automations
// (lib/sunrise.ts) that the same route file saves, lists and removes.

type Status = 'scheduled' | 'running' | 'done' | 'stopped' | 'off' | 'missed'

const PRESETS: Record<number, string> = { 2200: 'Warm', 4000: 'Neutral', 6500: 'Cool' }

const lightView = (r: LightRow) => {
  const lit = r.on && !r.unavailable
  const kelvin = lit && r.color_temp_kelvin != null ? r.color_temp_kelvin : undefined
  return {
    name: r.name,
    entity: r.entity_id,
    haName: r.friendly_name && r.friendly_name !== r.name ? r.friendly_name : undefined,
    state: r.unavailable ? 'unavailable' : r.on ? 'on' : 'off',
    percent: lit && r.brightness != null ? pctFromApi(r.brightness) : undefined,
    kelvin,
    preset: kelvin !== undefined ? PRESETS[kelvin] : undefined,
    rgb: lit && kelvin === undefined && r.rgb_color ? r.rgb_color : undefined,
    pending: r.pending || undefined,
  }
}

/** The lights; stale when Home Assistant did not answer and the engine gave its last copy. */
async function readLights(): Promise<{ rows: LightRow[]; stale: boolean }> {
  const { status, body, headers } = await apiJson<LightRow[] | { error?: string }>('/lights')
  if (status !== 200 || !Array.isArray(body)) throw new RavenToolError(`the lights could not be read: ${routeError(body, status)}`)
  return { rows: body, stale: headers.get('x-lights-stale') === '1' }
}
const STALE = 'Home Assistant is not answering: these are the last states Valkyrie saw, not live ones.'

async function readSunrises(): Promise<SunriseRow[]> {
  const { status, body } = await apiJson<{ sunrises?: SunriseRow[] }>('/lights/sunrises')
  if (status !== 200 || !Array.isArray(body?.sunrises)) throw new RavenToolError(`the sunrises could not be read: ${routeError(body, status)}`)
  return body.sunrises
}

const norm = (s: string) => s.toLowerCase().replace(/[_\s]+/g, ' ').trim()
const ALL = new Set(['all', 'all lights', 'every light', 'everything'])
const namesOf = (rows: Pick<LightRow, 'name'>[]) => rows.map((r) => r.name).join(', ')

/** The lights asked for: a Valkyrie name, an HA name, an entity id (whole, or a unique start of a name's words), or "all". */
function pick(rows: LightRow[], asked: string[]): { picked: LightRow[]; all: boolean } {
  const out = new Map<string, LightRow>()
  let all = false
  for (const raw of asked) {
    const q = norm(raw)
    if (!q) continue
    if (ALL.has(q)) {
      all = true
      for (const r of rows) out.set(r.entity_id, r)
      continue
    }
    const labels = (r: LightRow) => [r.name, r.friendly_name ?? ''].filter(Boolean).map(norm)
    let hit = rows.filter((r) => [...labels(r), norm(r.entity_id), norm(r.entity_id.replace(/^light\./, ''))].includes(q))
    if (!hit.length) {
      const words = q.split(' ')
      hit = rows.filter((r) => labels(r).some((l) => { const lw = l.split(' '); return words.every((w) => lw.some((x) => x.startsWith(w))) }))
    }
    if (!hit.length) throw new RavenToolError(`No light is called "${raw.trim()}". The lights: ${namesOf(rows)}. Nothing was changed.`)
    if (hit.length > 1) throw new RavenToolError(`"${raw.trim()}" matches ${namesOf(hit)}: name one. Nothing was changed.`)
    out.set(hit[0].entity_id, hit[0])
  }
  if (!out.size) throw new RavenToolError(`Name a light (${namesOf(rows)}) or "all".`)
  return { picked: [...out.values()], all }
}

const heldKelvin = (r: LightRow, k: number) => Math.max(r.min_kelvin ?? k, Math.min(r.max_kelvin ?? k, k))
const heldWords = (r: LightRow, asked: number, k: number) => `${r.name} cannot show ${asked}K: set to ${k}K, its ${k > asked ? 'lowest' : 'highest'}.`

// ---- New York words ----

const NY_CLOCK = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
const clock = (hm: string) => {
  const h = Number(hm.slice(0, 2))
  return { t: `${h % 12 || 12}:${hm.slice(3, 5)}`, ap: h < 12 ? 'AM' : 'PM' }
}
/** "Thu, Nov 26, 10:30 to 11:00 AM ET" */
function spanWords(date: string, start: string, end: string): string {
  const s = clock(start)
  const e = clock(end)
  return `${dueLabel(date)}, ${s.ap === e.ap ? s.t : `${s.t} ${s.ap}`} to ${e.t} ${e.ap} ET`
}
const nextDay = (date: string) => new Date(Date.parse(`${date}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
const wallMs = (date: string, hms: string) => nyWallToMs(`${date}T${hms.slice(0, 5)}`) + Number(hms.slice(6, 8) || 0) * 1000

function statusOf(r: SunriseRow, now: number): Status {
  if (r.running) return 'running'
  const m = r.sunrise
  // on: waiting for its start, inside its window (a run between two ticks), or past it without ever finishing
  if (r.on) return !m || now < wallMs(m.date, m.start) ? 'scheduled' : now < wallMs(m.date, sunriseWindowEnd(m.end)) ? 'running' : 'missed'
  // off: the line its run wrote in HA's logbook says how it ended (HA's last_changed cannot: every restart sets it)
  return r.outcome === 'finished' ? 'done' : r.outcome === 'stopped' ? 'stopped' : 'off'
}

const sunriseView = (r: SunriseRow, now: number) => (r.sunrise
  ? {
    id: r.id, light: r.sunrise.light, date: r.sunrise.date, when: spanWords(r.sunrise.date, r.sunrise.start, r.sunrise.end),
    from: `${r.sunrise.fromPercent}% ${r.sunrise.fromKelvin}K`, to: `${r.sunrise.toPercent}% ${r.sunrise.toKelvin}K`, status: statusOf(r, now),
  }
  : { id: r.id, status: statusOf(r, now), note: 'its config does not read as a sunrise' })

const sunriseWords = (m: SunriseMeta) => `${m.light} sunrise for ${spanWords(m.date, m.start, m.end)}`

export function registerLightTools(server: McpServer, ctx: RavenToolCtx): void {
  server.registerTool('lights', {
    description: "Brendon's lights in Home Assistant as Valkyrie's light engine shows them: each one's Valkyrie name, HA name when it differs, "
      + 'entity id, on, off or unavailable, brightness percent and color (kelvin with the app\'s preset name, or rgb). pending: a change went '
      + 'out and the bulb has not confirmed it yet. Also every sunrise set in Home Assistant: light, date, start to end ET, the ramp, and '
      + 'status (scheduled; running; done: it finished; stopped: the light was turned off or changed by hand during it, or the ramp was held up past its end; off: switched off with no record of '
      + 'how it ended, for example by hand in Home Assistant; missed: its time passed and it never ran).',
    inputSchema: {},
  }, () => toolRun(async () => {
    const { rows, stale } = await readLights()
    const lights = rows.map(lightView)
    const notes = stale ? [STALE] : []
    const now = io.now()
    let sunrises: ReturnType<typeof sunriseView>[] = []
    try {
      sunrises = (await readSunrises()).map((r) => sunriseView(r, now))
    } catch (e) {
      notes.push((e as Error).message)
    }
    return { lights, sunrises, note: notes.join(' ') || undefined }
  }))

  server.registerTool('light_set', {
    description: 'Turn lights on or off, or set their brightness and white color, through Valkyrie\'s own light engine (the path the app '
      + 'uses: one command at a time per bulb, the exact percent lands, and a bulb in screen sync leaves it). lights: one or more names as '
      + 'lights shows them (Bedroom, Table, Office lamp...), HA names or entity ids, or "all". percent 1 to 100. kelvin is white color '
      + 'temperature: 2200 is the app\'s Warm, 4000 Neutral, 6500 Cool, held to what each bulb can show. A percent or kelvin alone turns a '
      + 'light on and keeps the rest of its state; off ignores them. Returns each light as it stands after the change. Only when '
      + 'Brendon\'s message asks.',
    inputSchema: {
      lights: z.union([z.string().min(1).max(200), z.array(z.string().min(1).max(80)).min(1).max(10)]),
      state: z.enum(['on', 'off']).optional(),
      percent: z.number().int().min(1).max(100).optional(),
      kelvin: z.number().int().min(1000).max(10000).optional(),
    },
  }, (a) => toolRun(async () => {
    needBrendon(ctx, 'Changing a light')
    if (a.state === undefined && a.percent === undefined && a.kelvin === undefined) {
      throw new RavenToolError('Say what to change: state on or off, a percent, or a kelvin. Nothing was changed.')
    }
    const state = a.state ?? 'on'
    // Read first: an idle read makes the engine take what HA reports, so a target it kept from before a change
    // made outside Valkyrie (a sunrise, the Cync app) is not sent again with a percent or kelvin alone.
    const { rows } = await readLights()
    const { picked, all } = pick(rows, typeof a.lights === 'string' ? a.lights.split(',') : a.lights)
    const ready = picked.filter((r) => !r.unavailable)
    const away = picked.filter((r) => r.unavailable)
    if (!ready.length) throw new RavenToolError(`${namesOf(away)} ${away.length > 1 ? 'are' : 'is'} unavailable in Home Assistant right now. Nothing was changed.`)
    const notes: string[] = []
    if (away.length) notes.push(`${namesOf(away)} ${all ? 'left out' : 'not changed'}: unavailable in Home Assistant.`)
    if (state === 'off' && (a.percent !== undefined || a.kelvin !== undefined)) notes.push('Off ignores the percent and kelvin.')

    // one call per body: each bulb's kelvin is held to its own range
    const groups = new Map<string, { ids: string[]; body: Record<string, unknown> }>()
    for (const r of ready) {
      const body: Record<string, unknown> = { state }
      if (state === 'on' && a.percent !== undefined) body.brightness = apiBrightness(a.percent)
      if (state === 'on' && a.kelvin !== undefined) {
        const k = heldKelvin(r, a.kelvin)
        if (k !== a.kelvin) notes.push(heldWords(r, a.kelvin, k))
        body.color_temp_kelvin = k
      }
      const key = JSON.stringify(body)
      const g = groups.get(key) ?? { ids: [], body }
      g.ids.push(r.entity_id)
      groups.set(key, g)
    }
    // a running sunrise sends its next step within seconds and would undo a percent or kelvin: it is canceled first
    const canceled: string[] = []
    const canceledWords = () => (canceled.length ? ` Canceled ${canceled.join(' and ')}.` : '')
    if (state === 'on' && (a.percent !== undefined || a.kelvin !== undefined)) {
      const now = io.now()
      const runs = (await readSunrises().catch(() => [] as SunriseRow[]))
        .filter((s) => s.sunrise && ready.some((r) => r.entity_id === s.sunrise!.entity) && statusOf(s, now) === 'running')
      for (const s of runs) {
        let status = 0
        let body: unknown = null
        try {
          ({ status, body } = await apiJson(`/lights/sunrise/${encodeURIComponent(s.id)}`, { method: 'DELETE' }))
        } catch (e) {
          body = { error: (e as Error).message }
        }
        if (status === 404) continue
        if (status !== 200) {
          throw new RavenToolError(`The ${sunriseWords(s.sunrise!)} is running, its next step would undo this, and it could not be canceled: `
            + `${routeError(body, status)}.${canceledWords()} No light was changed.`)
        }
        ctx.acted()
        canceled.push(`the running ${sunriseWords(s.sunrise!)}`)
      }
      if (canceled.length) notes.push(`Canceled ${canceled.join(' and ')}: its next step, within ${SUNRISE_STEP_S} seconds, would have undone this.`)
    }

    const failed: string[] = []
    let took = 0
    let why = ''
    for (const g of groups.values()) {
      let status = 0
      let body: { ok?: boolean; failed?: string[] } | null = null
      try {
        ({ status, body } = await apiJson<{ ok?: boolean; failed?: string[] }>('/lights/turn', { method: 'POST', body: { entity_id: g.ids, ...g.body } }))
      } catch (e) {
        failed.push(...g.ids)
        why = (e as Error).message
        continue
      }
      if (status !== 200 || !body?.ok) {
        failed.push(...g.ids)
        why = routeError(body, status)
        continue
      }
      took += g.ids.length - (body.failed?.length ?? 0)
      failed.push(...(body.failed ?? []))
    }
    if (!took) throw new RavenToolError(`Home Assistant did not take it: ${why || 'every light failed'}. ${canceled.length ? `No light was changed.${canceledWords()}` : 'Nothing was changed.'}`)
    ctx.acted()
    if (failed.length) notes.push(`Home Assistant did not take it for ${namesOf(ready.filter((r) => failed.includes(r.entity_id)))}.`)

    const back = await readLights().catch(() => null)
    if (!back || back.stale) return { sent: namesOf(ready), note: [...notes, 'The lights could not be read back.'].join(' ') }
    const after = back.rows
    const lights = ready.map((r) => lightView(after.find((x) => x.entity_id === r.entity_id) ?? r))
    if (lights.some((l) => l.pending)) notes.push('pending: sent, the bulb has not confirmed it yet.')
    return { lights, note: notes.join(' ') || undefined }
  }))

  server.registerTool('light_sunrise', {
    description: 'Schedule a one-time sunrise on one light: Home Assistant ramps it from a dim warm white up to a full cool white that '
      + 'arrives at the wake time, then leaves it on. It runs in Home Assistant itself and picks up again after an HA restart mid-ramp. It '
      + 'stops if the light is switched off or changed by hand (in Valkyrie or Home Assistant) during it; light_set cancels it first. '
      + 'light: default Bedroom. end: the wake time, HH:mm New York time, 23:53 at the latest. date: YYYY-MM-DD New York '
      + '(default today if end is still ahead, else tomorrow). minutes: the ramp, 5 to 120 (default 30). fromPercent 1, toPercent 100, '
      + 'fromKelvin 2200 (Warm) and toKelvin 6500 (Cool) by default, held to what the bulb can show. One sunrise per light per date: a new '
      + 'one replaces it. When the start has passed but the end has not, it begins at once, partway along. Past sunrises Valkyrie made are '
      + 'cleaned up. Only when Brendon\'s message asks.',
    inputSchema: {
      light: z.string().min(1).max(80).optional(),
      end: z.string().min(1).max(5),
      date: z.string().max(10).optional(),
      minutes: z.number().int().min(5).max(120).optional(),
      fromPercent: z.number().int().min(1).max(100).optional(),
      toPercent: z.number().int().min(1).max(100).optional(),
      fromKelvin: z.number().int().min(1000).max(10000).optional(),
      toKelvin: z.number().int().min(1000).max(10000).optional(),
    },
  }, (a) => toolRun(async () => {
    needBrendon(ctx, 'Scheduling a sunrise')
    const end = /^\d:\d{2}$/.test(a.end.trim()) ? `0${a.end.trim()}` : a.end.trim()
    if (!realHm(end)) throw new RavenToolError(`end must be a real HH:mm wake time in New York time, not "${a.end}". Nothing was scheduled.`)
    const date0 = a.date?.trim()
    if (date0 !== undefined && !realDate(date0)) throw new RavenToolError(`date must be a real YYYY-MM-DD in New York time, not "${a.date}". Nothing was scheduled.`)
    const minutes = a.minutes ?? 30
    const start = hmBefore(end, minutes)
    if (!start) throw new RavenToolError(`A ${minutes}-minute sunrise ending at ${clock(end).t} ${clock(end).ap} would start the day before: start and end must be on one day. Nothing was scheduled.`)

    const row = pickOne((await readLights()).rows, a.light ?? 'Bedroom')
    if (row.supported_color_modes.length && !row.supported_color_modes.includes('color_temp')) {
      throw new RavenToolError(`${row.name} has no white color temperature. Nothing was scheduled.`)
    }

    const now = io.now()
    const today = nyToday(now)
    const date = date0 ?? (nyWallToMs(`${today}T${end}`) > now ? today : nextDay(today))
    const endMs = nyWallToMs(`${date}T${end}`)
    if (endMs <= now) throw new RavenToolError(`${spanWords(date, start, end)} is already past. Nothing was scheduled.`)
    const startMs = nyWallToMs(`${date}T${start}`)
    const late = startMs <= now
    const notes: string[] = []
    const kelvin = (asked: number) => {
      const k = heldKelvin(row, asked)
      if (k !== asked) notes.push(heldWords(row, asked, k))
      return k
    }
    const fromKelvin = kelvin(a.fromKelvin ?? 2200)
    const toKelvin = kelvin(a.toKelvin ?? 6500)
    let meta: SunriseMeta
    try {
      meta = checkSunrise({
        version: SUNRISE_VERSION, entity: row.entity_id, light: row.name, date, start, end,
        // scheduled late: a light switched off before now does not count as switched off during it
        armed: late ? NY_CLOCK.format(now) : `${start}:00`,
        fromPercent: a.fromPercent ?? 1, toPercent: a.toPercent ?? 100, fromKelvin, toKelvin,
      })
    } catch (e) {
      if (e instanceof SunriseError) throw new RavenToolError(`${e.message}. Nothing was scheduled.`)
      throw e
    }

    const before = await readSunrises().catch(() => null)
    const { status, body } = await apiJson<{ ok?: boolean; id?: string; replaced?: boolean; enabled?: boolean; warning?: string; sunrise?: SunriseMeta }>('/lights/sunrise', {
      // past the route's own worst case (four HA calls of up to 8 s, then up to 10 s waiting for the reload and one more call)
      method: 'POST', body: { sunrise: meta }, timeoutMs: 60_000,
    })
    if (status !== 200 || !body?.ok || !body.sunrise) throw new RavenToolError(`Home Assistant did not take the sunrise: ${routeError(body, status)}`)
    ctx.acted()
    const m = body.sunrise

    // this feature's own sunrises from before today go (one made by hand, without the facts block, stays)
    const removed: string[] = []
    for (const r of before ?? []) {
      if (!r.own || !r.sunrise || r.sunrise.date >= today || r.id === body.id) continue
      const d = await apiJson(`/lights/sunrise/${encodeURIComponent(r.id)}`, { method: 'DELETE' }).catch(() => null)
      if (d?.status === 200) removed.push(r.id)
    }

    const words = [`Scheduled the ${sunriseWords(m)}: ${m.fromPercent}% ${m.fromKelvin}K up to ${m.toPercent}% ${m.toKelvin}K, then it stays on.`]
    if (body.replaced) words.push(`It replaces the one ${m.light} had for that day.`)
    if (late) {
      const at = rampAt(m, (now - startMs) / (endMs - startMs))
      words.push(`Its start has passed, so it begins at the next minute, partway along (about ${at.percent}% ${at.kelvin}K now).`)
    }
    words.push(...notes)
    // a bulb that comes back off after armed reads as switched off by hand and stops it (lib/sunrise.ts, the off check)
    if (row.unavailable) {
      words.push(`${row.name} is unavailable in Home Assistant right now: `
        + `${late ? 'if it comes back off, that counts as switched off and stops the sunrise.' : `it runs if the bulb is back before ${clock(m.start).t} ${clock(m.start).ap}; if it comes back off later, that counts as switched off and stops it.`}`)
    }
    if (body.enabled === false) words.push(`Home Assistant does not show it switched on yet${body.warning ? ` (${body.warning})` : ''}: check it with lights.`)
    if (removed.length) words.push(`Removed ${removed.length} past sunrise${removed.length > 1 ? 's' : ''}.`)
    return { scheduled: words.join(' '), id: body.id, replaced: body.replaced === true, removed: removed.length ? removed : undefined }
  }))

  server.registerTool('light_sunrise_cancel', {
    description: 'Cancel a sunrise: by light and date (YYYY-MM-DD New York), by its id from lights, or with neither the one upcoming '
      + 'sunrise (with only light or only date, the one upcoming that fits). A running one stops where it is: the light stays at its last '
      + 'step. Only when Brendon\'s message asks.',
    inputSchema: {
      light: z.string().min(1).max(80).optional(),
      date: z.string().max(10).optional(),
      id: z.string().min(1).max(120).optional(),
    },
  }, (a) => toolRun(async () => {
    needBrendon(ctx, 'Canceling a sunrise')
    let id = a.id?.trim()
    const date = a.date?.trim()
    if (date !== undefined && !realDate(date)) throw new RavenToolError(`date must be a real YYYY-MM-DD in New York time, not "${a.date}". Nothing was canceled.`)
    if (id !== undefined) {
      if (!SUNRISE_ID_RE.test(id)) throw new RavenToolError(`${id} is not a sunrise id (sunrise_<light>_<YYYY>_<MM>_<DD>). Nothing was canceled.`)
    } else if (a.light && date) {
      id = sunriseId(pickOne((await readLights()).rows, a.light).name, date)
    } else {
      const entity = a.light ? pickOne((await readLights()).rows, a.light).entity_id : null
      const now = io.now()
      const fits = (await readSunrises()).filter((r) => r.sunrise && ['scheduled', 'running'].includes(statusOf(r, now))
        && (!entity || r.sunrise.entity === entity) && (!date || r.sunrise.date === date))
      if (!fits.length) return 'No upcoming sunrise fits. Nothing was canceled.'
      if (fits.length > 1) throw new RavenToolError(`More than one fits: ${fits.map((r) => sunriseWords(r.sunrise!)).join('; ')}. Name the light and date. Nothing was canceled.`)
      id = fits[0].id
    }
    const { status, body } = await apiJson<{ ok?: boolean; wasRunning?: boolean; sunrise?: SunriseMeta | null }>(`/lights/sunrise/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (status === 404) return `No sunrise ${id} is set. Nothing was canceled.`
    if (status !== 200 || !body?.ok) throw new RavenToolError(`Home Assistant did not remove the sunrise: ${routeError(body, status)}`)
    ctx.acted()
    const m = body.sunrise
    let text = m ? `Canceled the ${sunriseWords(m)}.` : `Canceled sunrise ${id}.`
    if (body.wasRunning) {
      const r = m ? (await readLights().catch(() => null))?.rows.find((x) => x.entity_id === m.entity) : undefined
      const v = r ? lightView(r) : null
      const at = v?.percent ? ` (${v.percent}%${v.kelvin ? ` ${v.kelvin}K` : ''})` : ''
      text += ` It was running: it stopped, and the light stays where it is${at}.`
    }
    return text
  }))
}

function pickOne(rows: LightRow[], name: string): LightRow {
  const { picked } = pick(rows, [name])
  if (picked.length !== 1) throw new RavenToolError(`A sunrise is for one light: name one (${namesOf(rows)}). Nothing was changed.`)
  return picked[0]
}
