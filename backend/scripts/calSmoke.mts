/**
 * Calendar route smoke test.
 *
 * Mounts routes/calendar.ts on a throwaway express app and drives it over HTTP:
 * the seeded local calendar, local events (all-day, timed, every-2-years,
 * every-6-months), input validation, and the refusal to delete a calendar that
 * still holds events. Run on odin from a scratch copy with VALKYRIE_DATA_DIR
 * pointing at an empty directory (better-sqlite3 has no Windows build here).
 */
import express from 'express'
const { default: route } = await import('../src/routes/calendar.ts')
const app = express(); app.use(express.json()); app.use('/api', route)
const srv = app.listen(0); const port = (srv.address() as any).port
const base = `http://127.0.0.1:${port}/api`
const j = async (m: string, p: string, b?: any) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return [r.status, await r.json()] as const }
console.log('sources', JSON.stringify((await j('GET', '/calendar/sources'))[1]))
console.log('create yearly2', JSON.stringify(await j('POST', '/calendar/local-events', { title: 'Filter, test; a\b', allDay: true, start: '2026-10-07', rrule: 'FREQ=YEARLY;INTERVAL=2', notes: 'line1\nline2' })))
console.log('create timed', JSON.stringify(await j('POST', '/calendar/local-events', { title: 'Dentist', start: '2026-11-03T09:30', end: '2026-11-03T10:15' })))
console.log('bad', JSON.stringify(await j('POST', '/calendar/local-events', { title: 'x', start: '2026-13-01', allDay: true })))
console.log('bad rrule', JSON.stringify(await j('POST', '/calendar/local-events', { title: 'x', start: '2026-10-01', allDay: true, rrule: 'FREQ=HOURLY' })))
const from = Date.parse('2026-01-01T00:00:00Z'), to = Date.parse('2026-12-31T00:00:00Z')
const ev = (await j('GET', `/calendar/events?from=${from}&to=${to}`))[1]
for (const e of ev.events) console.log(e.start, e.end, e.allDay, e.recurring, JSON.stringify(e.summary), JSON.stringify(e.description), e.local?.id ? 'local' : '')
const ev28 = (await j('GET', `/calendar/events?from=${Date.parse('2028-09-01T00:00:00Z')}&to=${Date.parse('2028-11-01T00:00:00Z')}`))[1]
const ev27 = (await j('GET', `/calendar/events?from=${Date.parse('2027-09-01T00:00:00Z')}&to=${Date.parse('2027-11-01T00:00:00Z')}`))[1]
console.log('2027 hits', ev27.events.length, '2028 hits', ev28.events.map((e: any) => e.start))
const id = ev.events[0].local.id
console.log('patch', JSON.stringify(await j('PATCH', `/calendar/local-events/${id}`, { rrule: 'FREQ=MONTHLY;INTERVAL=6' })))
const ev2 = (await j('GET', `/calendar/events?from=${Date.parse('2026-06-01T00:00:00Z')}&to=${Date.parse('2027-06-30T00:00:00Z')}`))[1]
console.log('6-monthly', ev2.events.filter((e: any) => e.local?.id === id).map((e: any) => e.start))
const src = (await j('GET', '/calendar/sources'))[1].sources[0]
console.log('delete local with events', JSON.stringify(await j('DELETE', `/calendar/sources/${src.id}`)))
console.log('delete ev', JSON.stringify(await j('DELETE', `/calendar/local-events/${id}`)))
srv.close(); process.exit(0)
