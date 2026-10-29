/**
 * Call route smoke test (routes/callAssist.ts).
 *
 * Mounts the route on a throwaway express app in front of a fake thor service
 * and checks that every call reaches thor with the bearer token and its body:
 * the state long poll, start, ask, dismiss and stop, plus input refusals and
 * thor's own errors passed through. Needs no data directory and nothing on
 * thor: `npx tsx scripts/callSmoke.mts`, exit 0 when every check passes.
 *
 * 2026-10-27: every POST answered "not answering (timed out)" in 8 ms, because
 * the proxy aborted on the request's close, which a request with a body fires
 * as soon as the body is read. The browser suite answers writes in the page,
 * so only a test like this one reaches the proxy.
 */
import http from 'node:http'
import express from 'express'

const TOKEN = 'e2e-call-token-'.padEnd(64, 'x')
const seen: { method: string; url: string; auth: string; body: any }[] = []
const thor = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (d) => { raw += d })
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : null
    seen.push({ method: req.method ?? '', url: req.url ?? '', auth: String(req.headers.authorization ?? ''), body })
    const send = (status: number, obj: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    if (req.url?.startsWith('/state')) return setTimeout(() => send(200, { rev: 2, status: 'idle', areas: [], call: null, last: null }), 300)
    if (req.url === '/start') return send(200, { rev: 3, status: 'live', areas: [], call: { id: 'c1' }, last: null })
    if (req.url === '/ask') return send(409, { error: 'no call is running' })
    if (req.url === '/dismiss' || req.url === '/stop') return send(200, { ok: true })
    send(404, { error: 'not found' })
  })
})
await new Promise<void>((r) => thor.listen(0, '127.0.0.1', () => r()))
process.env.CALL_ASSIST_URL = `http://127.0.0.1:${(thor.address() as any).port}`
process.env.CALL_ASSIST_TOKEN = TOKEN

const { default: route } = await import('../src/routes/callAssist.ts')
const app = express(); app.use(express.json()); app.use('/api', route)
const srv = app.listen(0); const port = (srv.address() as any).port
const j = async (m: string, p: string, b?: unknown) => {
  const r = await fetch(`http://127.0.0.1:${port}/api${p}`, { method: m, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) })
  return [r.status, await r.json()] as const
}

let fails = 0
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++ }
const last = () => seen[seen.length - 1]

let r = await j('GET', '/call/state?rev=1&after=4&wait=3')
check(r[0] === 200 && r[1].rev === 2, `state answered ${r[0]} ${JSON.stringify(r[1])}`)
check(last()?.url === '/state?rev=1&after=4&wait=3' && last()?.auth === `Bearer ${TOKEN}`, `state reached thor as ${last()?.url} with the token`)
r = await j('GET', '/call/state?wait=99&rev=x')
check(last()?.url === '/state?wait=25', `state clamps the wait and drops a bad rev: ${last()?.url}`)

r = await j('POST', '/call/start', { area: 'one', record: true })
check(r[0] === 200 && r[1].call?.id === 'c1', `start answered ${r[0]} ${JSON.stringify(r[1])}`)
// 2026-10-29: the route dropped record, and a saved call had no video
check(last()?.method === 'POST' && last()?.url === '/start' && last()?.body?.area === 'one' && last()?.body?.record === true, `start reached thor with ${JSON.stringify(last()?.body)}`)
await j('POST', '/call/start', { area: 'one' })
check(last()?.body?.record === false, `a start without record reached thor with ${JSON.stringify(last()?.body)}`)
const n = seen.length
r = await j('POST', '/call/start', { area: 'Bad Area!' })
check(r[0] === 400 && seen.length === n, `a bad area is refused on odin (${r[0]})`)

r = await j('POST', '/call/ask', { text: '  what printer?  ' })
check(r[0] === 409 && r[1].error === 'no call is running', `thor's 409 passes through: ${r[0]} ${JSON.stringify(r[1])}`)
check(last()?.body?.text === 'what printer?', `ask reached thor trimmed: ${JSON.stringify(last()?.body)}`)
r = await j('POST', '/call/ask', { text: '' })
check(r[0] === 400, `an empty ask is refused (${r[0]})`)

r = await j('POST', '/call/dismiss', { id: '00000000-0000-4000-8000-000000000001' })
check(r[0] === 200 && last()?.url === '/dismiss', `dismiss reached thor (${r[0]})`)
r = await j('POST', '/call/stop', { save: true })
check(r[0] === 200 && last()?.url === '/stop' && last()?.body?.save === true, `stop reached thor with save ${JSON.stringify(last()?.body)}`)

srv.close(); thor.close()
console.log(fails ? `${fails} failed` : 'all passed')
process.exit(fails ? 1 : 0)
