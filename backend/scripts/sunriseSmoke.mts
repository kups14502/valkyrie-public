/**
 * Sunrise smoke test: the automation builder (lib/sunrise.ts) and the sunrise routes in routes/lights.ts
 * (GET /lights/sunrises, POST /lights/sunrise, DELETE /lights/sunrise/:id) against a fake Home Assistant.
 *
 * The builder is held to the live Bedroom automation of 2026-11-26 (scripts/fixtures/sunrise-bedroom-2026-11-26.json,
 * written by hand and tried on HA): the same config, plus only the facts block. The fake HA answers the way HA's
 * config API does (404 for a missing automation, a reload after a save that keeps the automation's on or off).
 * Nothing here talks to the real Home Assistant. Run from backend/:
 *   npx tsx scripts/sunriseSmoke.mts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import express from 'express'

let pass = 0, fail = 0
const check = (name: string, ok: boolean, got?: unknown) => {
  if (ok) pass += 1
  else { fail += 1; console.log('FAIL', name, JSON.stringify(got)?.slice(0, 900)) }
}

// ------------------------------------------------------------ fake HA ---

type St = { entity_id: string; state: string; attributes: Record<string, unknown>; last_updated: string; last_changed: string }
const stamp = () => new Date(Date.now() + Math.random()).toISOString()
const light = (entity_id: string, friendly_name: string): St => ({
  entity_id, state: 'off', last_updated: stamp(), last_changed: stamp(),
  attributes: { friendly_name, supported_color_modes: ['color_temp', 'rgb'], min_color_temp_kelvin: 2000, max_color_temp_kelvin: 7000 },
})
const states: St[] = [
  light('light.office_lamp', 'Office lamp'), light('light.dresser', 'Dresser'), light('light.nightsand', 'Nightsand'),
  light('light.tv_strip', 'TV Strip'), light('light.kitche_light', 'Kitchen Light'),
  { entity_id: 'automation.coffee', state: 'on', attributes: { id: 'coffee_morning', current: 0 }, last_updated: stamp(), last_changed: stamp() },
]
const configs = new Map<string, Record<string, unknown>>()
const haLog: string[] = []
const turnedOn: string[] = []
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/sunrise-bedroom-2026-11-26.json', import.meta.url), 'utf8')) as Record<string, unknown>
// the live one: saved by hand, no facts block, waiting for its morning
configs.set('sunrise_bedroom_2026_11_26', fixture)
states.push({ entity_id: 'automation.sunrise_bedroom_thu_2026_11_26_10_30_11_00_am', state: 'on', attributes: { id: 'sunrise_bedroom_2026_11_26', current: 0, last_triggered: null }, last_updated: stamp(), last_changed: stamp() })
const autoOf = (id: string) => states.find((s) => s.entity_id.startsWith('automation.') && s.attributes.id === id)

const ha = express(); ha.use(express.json({ limit: '1mb' }))
ha.use((q, _r, next) => { haLog.push(`${q.method} ${q.path}`); next() })
let statesFail = false
ha.get('/api/states', (_q, r) => (statesFail ? r.status(500).json({ message: 'down' }) : r.json(states)))
// HA's logbook API: entries in time order, a logbook.log line's text in message
const logbook = new Map<string, { status: number; body: unknown }>()
const logbookAsks: { from: string; entity: string; end: string }[] = []
ha.get('/api/logbook/:from', (q, r) => {
  logbookAsks.push({ from: q.params.from, entity: String(q.query.entity), end: String(q.query.end_time) })
  const a = logbook.get(String(q.query.entity)) ?? { status: 200, body: [] }
  r.status(a.status).json(a.body)
})
ha.get('/api/config/automation/config/:id', (q, r) => {
  const c = configs.get(q.params.id)
  return c ? r.json(c) : r.status(404).json({ message: 'Resource not found' })
})
ha.post('/api/config/automation/config/:id', (q, r) => {
  const id = q.params.id
  configs.set(id, { ...q.body, id })
  // HA answers first and reloads that automation after: a new state object, the old on or off kept
  setTimeout(() => {
    const old = autoOf(id)
    const slug = String(q.body.alias).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    const s: St = { entity_id: old?.entity_id ?? `automation.${slug}`, state: old?.state ?? 'on', attributes: { id, current: 0, last_triggered: null }, last_updated: stamp(), last_changed: stamp() }
    if (old) states.splice(states.indexOf(old), 1, s)
    else states.push(s)
  }, 250)
  r.json({ result: 'ok' })
})
ha.delete('/api/config/automation/config/:id', (q, r) => {
  const id = q.params.id
  if (!configs.delete(id)) return r.status(400).json({ message: 'Resource not found' })
  const s = autoOf(id)
  if (s) states.splice(states.indexOf(s), 1)
  r.json({ result: 'ok' })
})
let turnOnFails = false
ha.post('/api/services/automation/turn_on', (q, r) => {
  if (turnOnFails) return r.status(500).json({ message: 'Service call failed' })
  turnedOn.push(String(q.body.entity_id))
  const s = states.find((x) => x.entity_id === q.body.entity_id)
  if (s) Object.assign(s, { state: 'on', last_updated: stamp(), last_changed: stamp() })
  r.json([])
})
const haSrv = ha.listen(0, '127.0.0.1')
await new Promise((r) => haSrv.once('listening', r))
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sunrise-smoke-'))
const authFile = path.join(scratch, 'ha_auth.json')
fs.writeFileSync(authFile, JSON.stringify({ token_id: 'smoke', jwt_key: 'smoke-key', ha_url: `http://127.0.0.1:${(haSrv.address() as { port: number }).port}` }))
process.env.HA_AUTH_FILE = authFile

// imported only now: routes/lights.ts reads HA_AUTH_FILE at import time
const sr = await import('../src/lib/sunrise.ts')
const scale = await import('../src/lib/lightScale.ts')
const lightsRoute = (await import('../src/routes/lights.ts')).default
const app = express(); app.use(express.json()); app.use('/api', lightsRoute)
const appSrv = app.listen(0, '127.0.0.1')
await new Promise((r) => appSrv.once('listening', r))
const base = `http://127.0.0.1:${(appSrv.address() as { port: number }).port}/api`
const req = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(`${base}${p}`, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, body: await r.json().catch(() => null) as any }
}

// ------------------------------------------------------------ the builder ---

const live = {
  version: 1, entity: 'light.dresser', light: 'Bedroom', date: '2026-11-26', start: '10:30', end: '11:00', armed: '10:30:00',
  fromPercent: 1, toPercent: 100, fromKelvin: 2200, toKelvin: 6500,
}
{
  const built = sr.buildSunrise(live, { stepS: 15, settleS: 60, windowEnd: '11:05:00' })
  const { variables, ...rest } = built
  check('builder: the live Bedroom automation exactly', isDeepStrictEqual(rest, fixture), rest)
  check('builder: plus only the facts block', isDeepStrictEqual(variables, { sunrise: live }) && Object.keys(built).length === Object.keys(fixture).length + 1, variables)
  check('builder: the defaults are 15 s steps, a 60 s settle and a window to 5 minutes past the end', isDeepStrictEqual(sr.buildSunrise(live), built))
  check('builder: the id', built.id === 'sunrise_bedroom_2026_11_26' && sr.SUNRISE_ID_RE.test(String(built.id)))

  // every percent the ramp's template asks for lands: the same brightness the engine sends, and HA's Cync sends it back as that percent
  const off: number[] = []
  for (let p = 1; p <= 100; p++) {
    const b = Math.floor((255 * p + 99) / 100)
    if (b !== scale.haBrightnessFor(p) || Math.trunc((b / 255) * 100) !== p) off.push(p)
  }
  check('builder: the template brightness is haBrightnessFor for every percent', off.length === 0, off)

  const noon = sr.buildSunrise({ ...live, light: 'Office lamp', entity: 'light.office_lamp', date: '2026-12-05', start: '11:45', end: '12:15', armed: '11:45:00', fromPercent: 80, toPercent: 20 })
  check('builder: an alias across noon', noon.alias === 'Sunrise: Office lamp, Sat 2026-12-05 11:45 AM-12:15 PM', noon.alias)
  check('builder: id from the light name', noon.id === 'sunrise_office_lamp_2026_12_05', noon.id)
  const ramp = ((noon.actions as any[])[0].repeat.sequence[1].variables) as Record<string, string>
  check('builder: a ramp down is the same template', ramp.p === '{{ (80 + -60 * f) | round(0) | int }}', ramp)
  const finalSend = (noon.actions as any[]).find((x) => x.action === 'light.turn_on')
  check('builder: the last brightness lands its percent', finalSend?.data.brightness === scale.haBrightnessFor(20), noon.actions)
  const tail = (built.actions as any[]).slice(1)
  check('builder: a run held up 10 minutes past the end stops before the full-brightness send',
    tail[0]?.if?.[0]?.value_template === "{{ now() >= today_at('11:00:00') + timedelta(minutes=10) }}" && tail[0].then.some((x: any) => x.stop)
    && tail.findIndex((x: any) => x.action === 'light.turn_on') > 0, tail[0])
  const hand = (built.actions as any[])[0].repeat.sequence[0].if[0].value_template as string
  check('builder: an off within 2 minutes of HA loading the automation is not a hand change (Cync starts every light off)',
    hand.includes("states['light.dresser'].last_changed > states[this.entity_id].last_changed + timedelta(seconds=120)"), hand)
  check('builder: a state written with a user context after the start is a hand change',
    hand.includes("states['light.dresser'].context.user_id is not none and states['light.dresser'].last_updated > today_at('10:30:00') + timedelta(seconds=5)"), hand)
  check('builder: traces kept for the whole run', isDeepStrictEqual(built.trace, { stored_traces: 100 }), built.trace)

  const late = sr.buildSunrise({ ...live, armed: '10:44:17' })
  const lateText = JSON.stringify(late)
  check('builder: scheduled late, only an off after the ask counts', lateText.includes("last_changed > today_at('10:44:17') + timedelta(seconds=5)")
    && !lateText.includes("last_changed > today_at('10:30:00')") && lateText.includes("now() - today_at('10:30:00')"), late.actions)
  check('builder: the window closes the same day', sr.sunriseWindowEnd('23:58') === '23:59:59' && sr.sunriseWindowEnd('11:00') === '11:05:00')
  check('builder: a start the day before is none', sr.hmBefore('00:10', 30) === null && sr.hmBefore('11:00', 30) === '10:30' && sr.hmBefore('00:30', 30) === '00:00')
  check('builder: ramp halfway', isDeepStrictEqual(sr.rampAt(live, 0.5), { percent: 51, kelvin: 4350 }), sr.rampAt(live, 0.5))
  check('builder: names make ids', sr.sunriseId('TV Strip', '2026-12-01') === 'sunrise_tv_strip_2026_12_01' && sr.sunriseId('Kitchen Light', '2026-12-01') === 'sunrise_kitchen_light_2026_12_01')
}

// ------------------------------------------------------------ reading one ---

{
  check('read: the live one from its description and alias', isDeepStrictEqual(sr.sunriseOf(fixture), live) && !sr.ownSunrise(fixture), sr.sunriseOf(fixture))
  const built = sr.buildSunrise({ ...live, date: '2026-12-01', armed: '10:30:00' })
  check('read: one of ours from its facts block', sr.sunriseOf(built)?.date === '2026-12-01' && sr.ownSunrise(built))
  check('read: anything else is not one', sr.sunriseOf({ alias: 'Coffee', description: 'Makes coffee' }) === null && sr.sunriseOf(null) === null)

  const bad: [string, Record<string, unknown>, RegExp][] = [
    ['no such day', { date: '2026-02-30' }, /date/],
    ['no such month', { date: '2026-13-01' }, /date/],
    ['no such hour', { end: '24:00' }, /HH:mm/],
    ['an end before the start', { start: '11:00', end: '10:30' }, /minutes/],
    ['a ramp past two hours', { start: '08:00', end: '10:30' }, /minutes/],
    ['armed after the end', { armed: '11:00:00' }, /armed/],
    ['a percent of 0', { fromPercent: 0 }, /percents/],
    ['a kelvin of 20000', { toKelvin: 20000 }, /kelvins/],
    ['a light that is not one', { entity: 'light.garage' }, /entity/],
    ['a switch', { entity: 'switch.heater' }, /entity/],
    ['another version', { version: 2 }, /version/],
    // the settle would run past midnight, where today_at() is the next day's
    ['an end past 23:53', { start: '23:29', end: '23:59', armed: '23:29:00' }, /^the end must be 23:53 or earlier/],
    ['the hour the clocks skip', { date: '2027-03-14', start: '02:00', end: '02:30', armed: '02:00:00' },
      /^the clocks go forward on 2027-03-14 and 02:00 to 03:00 does not happen: a sunrise that day must end by 01:53 or start at 03:00 or later$/],
    ['a start in the skipped hour', { date: '2027-03-14', start: '02:45', end: '03:15', armed: '02:45:00' }, /clocks go forward/],
    ['a window that runs into the skipped hour', { date: '2027-03-14', start: '01:20', end: '01:54', armed: '01:20:00' }, /end by 01:53/],
    ['the hour the clocks repeat', { date: '2026-11-01', start: '01:30', end: '02:00', armed: '01:30:00' },
      /^the clocks go back on 2026-11-01 and 01:00 to 02:00 happens twice: a sunrise that day must end by 00:53 or start at 02:00 or later$/],
    ['one inside the repeated hour', { date: '2027-11-07', start: '01:05', end: '01:35', armed: '01:05:00' }, /clocks go back on 2027-11-07/],
  ]
  const lights = ['light.office_lamp', 'light.dresser', 'light.nightsand', 'light.tv_strip', 'light.kitche_light']
  for (const [what, patch, want] of bad) {
    let msg = ''
    try { sr.checkSunrise({ ...live, ...patch }, lights) } catch (e) { msg = e instanceof sr.SunriseError ? e.message : `not a SunriseError: ${e}` }
    check(`check: refuses ${what}`, want.test(msg), msg)
  }
  check('check: drops what is not a fact', !('extra' in sr.checkSunrise({ ...live, extra: 'x' })))
  const takes = (patch: Record<string, unknown>) => { try { sr.checkSunrise({ ...live, ...patch }); return true } catch { return false } }
  check('check: takes an end of 23:53 and sunrises clear of a clock change', takes({ start: '23:23', end: '23:53', armed: '23:23:00' })
    && takes({ date: '2027-03-14', start: '03:00', end: '03:30', armed: '03:00:00' }) && takes({ date: '2027-03-14', start: '01:20', end: '01:53', armed: '01:20:00' })
    && takes({ date: '2026-11-01', start: '00:20', end: '00:53', armed: '00:20:00' }) && takes({ date: '2026-11-01', start: '02:00', end: '02:30', armed: '02:00:00' })
    && takes({ date: '2026-11-01', start: '06:30', end: '07:00', armed: '06:30:00' }))
  check('check: the clock changes New York has', isDeepStrictEqual(sr.clockChange('2027-03-14'), { from: 7200, to: 10800, forward: true })
    && isDeepStrictEqual(sr.clockChange('2026-11-01'), { from: 3600, to: 7200, forward: false }) && sr.clockChange('2026-11-26') === null
    && sr.clockChange('2026-07-04') === null, [sr.clockChange('2027-03-14'), sr.clockChange('2026-11-01')])
  check('check: New York instants', sr.nyInstant('2026-11-26', '10:30') === Date.parse('2026-11-26T15:30:00Z')
    && sr.nyInstant('2026-07-04', '06:30:15') === Date.parse('2026-07-04T10:30:15Z'))
}

// ------------------------------------------------------------ the routes ---

{
  let r = await req('GET', '/lights/sunrises')
  check('route: lists the live one, read from its description, made by hand', r.status === 200 && r.body.sunrises.length === 1 && r.body.sunrises[0].id === 'sunrise_bedroom_2026_11_26'
    && r.body.sunrises[0].own === false && r.body.sunrises[0].on === true && r.body.sunrises[0].running === false
    && r.body.sunrises[0].automation === 'automation.sunrise_bedroom_thu_2026_11_26_10_30_11_00_am' && isDeepStrictEqual(r.body.sunrises[0].sunrise, live), r.body)

  haLog.length = 0
  const want = { ...live, light: 'bedroom lamp', date: '2026-11-27', start: '06:30', end: '07:15', armed: '06:30:00' }
  r = await req('POST', '/lights/sunrise', { sunrise: want })
  const saved = configs.get('sunrise_bedroom_2026_11_27')
  check('route: saves a new one under the light\'s own name', r.status === 200 && r.body.id === 'sunrise_bedroom_2026_11_27' && r.body.replaced === false
    && r.body.enabled === true && r.body.sunrise.light === 'Bedroom', r.body)
  check('route: HA gets the builder\'s config', isDeepStrictEqual(saved, sr.buildSunrise({ ...want, light: 'Bedroom' })), saved)
  check('route: HA is asked once to save, never a light service', haLog.filter((l) => l.startsWith('POST /api/config/automation/config/')).length === 1
    && !haLog.some((l) => l.startsWith('POST /api/services/light')), haLog)
  check('route: a new one that came up on is not switched on again', turnedOn.length === 0, turnedOn)

  r = await req('GET', '/lights/sunrises')
  const mine = r.body.sunrises.find((s: { id: string }) => s.id === 'sunrise_bedroom_2026_11_27')
  check('route: the list has it, ours, sorted by date', r.body.sunrises.length === 2 && r.body.sunrises[0].id === 'sunrise_bedroom_2026_11_26' && mine?.own === true
    && isDeepStrictEqual(mine.sunrise, { ...want, light: 'Bedroom' }), r.body)

  // it ran and switched itself off; a new one for the same light and date takes its place and must come back on
  Object.assign(autoOf('sunrise_bedroom_2026_11_27')!, { state: 'off', last_updated: stamp(), last_changed: stamp() })
  r = await req('POST', '/lights/sunrise', { sunrise: { ...want, light: 'Bedroom', start: '15:00', end: '15:20', armed: '15:00:00' } })
  check('route: the same light and date replaces it', r.status === 200 && r.body.replaced === true && r.body.id === 'sunrise_bedroom_2026_11_27'
    && (configs.get('sunrise_bedroom_2026_11_27')?.variables as any)?.sunrise?.end === '15:20', r.body)
  check('route: a replaced one that was off is switched on after the reload', turnedOn.length === 1 && autoOf('sunrise_bedroom_2026_11_27')?.state === 'on', { turnedOn, s: autoOf('sunrise_bedroom_2026_11_27') })

  // saved, but switching it on fails: HA has it, so the answer is ok with enabled false and why, never "did not take it"
  Object.assign(autoOf('sunrise_bedroom_2026_11_27')!, { state: 'off', last_updated: stamp(), last_changed: stamp() })
  turnOnFails = true
  r = await req('POST', '/lights/sunrise', { sunrise: { ...want, light: 'Bedroom', start: '15:00', end: '15:20', armed: '15:00:00' } })
  turnOnFails = false
  check('route: saved but not switched on is ok, enabled false, with the reason', r.status === 200 && r.body.ok === true && r.body.enabled === false
    && r.body.replaced === true && /^switching it on failed: HA POST \/api\/services\/automation\/turn_on -> 500/.test(r.body.warning ?? '')
    && (configs.get('sunrise_bedroom_2026_11_27')?.variables as any)?.sunrise?.end === '15:20', r.body)
  Object.assign(autoOf('sunrise_bedroom_2026_11_27')!, { state: 'on' })

  const n = configs.size
  for (const [what, body] of [['no facts', {}], ['a bad date', { sunrise: { ...want, date: '2026-13-01' } }], ['an unknown light', { sunrise: { ...want, entity: 'light.porch' } }]] as const) {
    r = await req('POST', '/lights/sunrise', body)
    check(`route: refuses ${what}`, r.status === 400 && typeof r.body?.error === 'string', r)
  }
  check('route: nothing saved for a refused one', configs.size === n, configs.size)

  for (const id of ['coffee_morning', 'automation.sunrise_bedroom_2026_11_27', 'sunrise_bedroom']) {
    r = await req('DELETE', `/lights/sunrise/${encodeURIComponent(id)}`)
    check(`route: will not remove ${id}`, r.status === 400 && /not a sunrise id/.test(r.body?.error ?? ''), r)
  }
  check('route: the other automation is untouched', configs.size === n && !!autoOf('coffee_morning'))
  r = await req('DELETE', '/lights/sunrise/sunrise_table_2026_12_24')
  check('route: a missing one is a 404', r.status === 404, r)

  autoOf('sunrise_bedroom_2026_11_27')!.attributes.current = 1
  r = await req('DELETE', '/lights/sunrise/sunrise_bedroom_2026_11_27')
  check('route: removes a running one and says it was running', r.status === 200 && r.body.wasRunning === true && r.body.sunrise?.end === '15:20'
    && !configs.has('sunrise_bedroom_2026_11_27') && !autoOf('sunrise_bedroom_2026_11_27'), r.body)
  check('route: the live one is still there', configs.get('sunrise_bedroom_2026_11_26') === fixture && !!autoOf('sunrise_bedroom_2026_11_26'))
}

// ------------------------------------------------------------ how one ended ---

{
  // three that are off, every last_changed the same HA restart: only their logbook lines tell them apart
  const restart = stamp()
  const off = (light: string, entity: string, date: string, automation: string) => {
    const m = { ...live, light, entity, date, start: '06:30', end: '07:00', armed: '06:30:00' }
    const id = sr.sunriseId(light, date)
    configs.set(id, sr.buildSunrise(m))
    states.push({ entity_id: automation, state: 'off', attributes: { id, current: 0, last_triggered: null }, last_updated: restart, last_changed: restart })
  }
  off('Office lamp', 'light.office_lamp', '2026-11-20', 'automation.sr_finished')
  off('TV Strip', 'light.tv_strip', '2026-11-21', 'automation.sr_stopped')
  off('Kitchen Light', 'light.kitche_light', '2026-11-22', 'automation.sr_no_log')
  logbook.set('automation.sr_finished', { status: 200, body: [
    { state: 'on', entity_id: 'automation.sr_finished' }, { message: 'triggered by time pattern', entity_id: 'automation.sr_finished' },
    { message: 'stopped mid-ramp: the light was turned off during the sunrise', entity_id: 'automation.sr_finished' },
    { message: 'triggered by time pattern', entity_id: 'automation.sr_finished' }, { message: 'finished: 100% 6500K, staying on', entity_id: 'automation.sr_finished' },
    { state: 'off', entity_id: 'automation.sr_finished' },
  ] })
  logbook.set('automation.sr_stopped', { status: 200, body: [
    { message: 'triggered by homeassistant start event', entity_id: 'automation.sr_stopped' },
    { message: 'stopped at the end: the light was turned off during the sunrise', entity_id: 'automation.sr_stopped' },
  ] })
  logbook.set('automation.sr_no_log', { status: 500, body: { message: 'boom' } })
  logbookAsks.length = 0
  const r = await req('GET', '/lights/sunrises')
  const O = (a: string) => r.body?.sunrises?.find((s: { automation: string }) => s.automation === a)
  check('outcome: finished, the last line wins', r.status === 200 && O('automation.sr_finished')?.outcome === 'finished' && O('automation.sr_finished').changedAt === restart, O('automation.sr_finished'))
  check('outcome: stopped', O('automation.sr_stopped')?.outcome === 'stopped', O('automation.sr_stopped'))
  check('outcome: no line (the logbook failed) is null, the list still answers', O('automation.sr_no_log')?.outcome === null && O('automation.sr_no_log').sunrise?.date === '2026-11-22', O('automation.sr_no_log'))
  check('outcome: an on one is not looked up', O('automation.sunrise_bedroom_thu_2026_11_26_10_30_11_00_am')?.outcome === null
    && !logbookAsks.some((x) => x.entity.startsWith('automation.sunrise_bedroom')), logbookAsks)
  const ask = logbookAsks.find((x) => x.entity === 'automation.sr_finished')
  check('outcome: the logbook is read for that automation, from a minute before its start to half an hour past its window',
    logbookAsks.length === 3 && ask?.from === '2026-11-20T11:29:00.000Z' && ask.end === '2026-11-20T12:35:00.000Z', logbookAsks)
}

// ------------------------------------------------------------ stale lights ---

{
  let r = await req('GET', '/lights')
  const fresh = r
  const head = async () => (await fetch(`${base}/lights`)).headers.get('x-lights-stale')
  check('lights: a live read has no stale mark', fresh.status === 200 && Array.isArray(fresh.body) && (await head()) === null, fresh.body)
  statesFail = true
  await new Promise((res) => setTimeout(res, 700))
  const s = await fetch(`${base}/lights`)
  statesFail = false
  check('lights: HA not answering gives the last rows, marked stale', s.status === 200 && s.headers.get('x-lights-stale') === '1' && Array.isArray(await s.json()), s.status)
  r = await req('GET', '/lights')
  check('lights: answering again', r.status === 200 && Array.isArray(r.body))
}

appSrv.close()
haSrv.close()
fs.rmSync(scratch, { recursive: true, force: true })
console.log(`sunriseSmoke: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
