/**
 * uploadToThor against a fake thor launcher (no thor, no network): the chunked upload Raven uses to hand a DM
 * attachment to a session, and how it survives thor's agent being busy or restarting mid-file.
 *
 * The fake speaks thor's /upload protocol (Start-LauncherAgent.ps1): ?id&name&offset&total, a half file per id that
 * outlives a restart, 409 with `received` when the offset disagrees, 400 "chunk arrived short" when the body is cut.
 * Faults are queued per test: drop the connection, answer 503, cut the chunk short, "restart" (forget the finished
 * uploads, keep the half files), never answer, refuse the token.
 *
 *   node --import tsx scripts/thorUploadSmoke.mts
 */
import http from 'node:http'
import { randomBytes } from 'node:crypto'

type Fault = 'drop' | '503' | 'short' | 'restart' | 'hang' | '401' | '507'
const faults: Fault[] = []
const parts = new Map<string, Buffer>()
const done = new Map<string, Record<string, unknown>>()
const saved: { name: string; data: Buffer }[] = []
const log: string[] = []
const TOKEN = 'smoke-token'

const srv = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  if (url.pathname !== '/upload') return json(404, { error: 'not found' })
  const fault = faults.shift()
  log.push(`${url.searchParams.get('offset')}:${fault ?? 'ok'}`)
  if (fault === 'hang') return // never answers; the client's own timeout ends it
  if (fault === 'drop') { req.socket.destroy(); return }
  if (fault === '503') { req.resume(); return json(503, { error: 'busy' }) }
  if (fault === '507') { req.resume(); return json(507, { error: 'not enough free space on thor' }) }
  if (fault === '401' || req.headers.authorization !== `Bearer ${TOKEN}`) { req.resume(); return json(401, { error: 'unauthorized' }) }
  if (fault === 'restart') done.clear()
  const id = url.searchParams.get('id') ?? ''
  const name = url.searchParams.get('name') ?? 'file'
  const offset = Number(url.searchParams.get('offset'))
  const total = Number(url.searchParams.get('total'))
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    if (done.has(id)) return json(200, done.get(id))
    let body = Buffer.concat(chunks)
    const have = parts.get(id)?.length ?? 0
    if (offset !== 0 && have !== offset) return json(409, { error: 'offset does not match what thor has', received: have })
    if (fault === 'short') {
      // what the PowerShell agent does with a body that stopped early: keep nothing of it, say where the file stands
      return json(400, { error: 'chunk arrived short', received: offset })
    }
    const prev = offset === 0 ? Buffer.alloc(0) : parts.get(id)!
    body = Buffer.concat([prev, body])
    parts.set(id, body)
    if (body.length < total) return json(200, { done: false, received: body.length })
    parts.delete(id)
    const path = `C:\\Thor\\uploads\\smoke-${saved.length + 1}-${name}`
    saved.push({ name, data: body })
    const r = { done: true, received: body.length, name: `smoke-${saved.length}-${name}`, path, size: body.length }
    done.set(id, r)
    json(200, r)
  })
})
await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
const port = (srv.address() as { port: number }).port

Object.assign(process.env, {
  THOR_LAUNCHER_HOST: '127.0.0.1', THOR_LAUNCHER_PORT: String(port), THOR_LAUNCHER_TOKEN: TOKEN,
  THOR_UPLOAD_RETRY_SCALE: '0.01', THOR_UPLOAD_CHUNK_TIMEOUT_MS: '1500',
})
const { uploadToThor } = await import('../src/routes/hostLaunch.ts')

let pass = 0
let fail = 0
const check = (name: string, ok: unknown, got?: unknown) => {
  if (ok) { pass++; console.log(`ok   ${name}`) } else { fail++; console.log(`FAIL ${name}${got === undefined ? '' : `: ${JSON.stringify(got).slice(0, 600)}`}`) }
}
const run = async (name: string, data: Buffer, q: Fault[]) => {
  faults.length = 0
  faults.push(...q)
  log.length = 0
  try {
    return { r: await uploadToThor(name, data), err: null as string | null, log: [...log] }
  } catch (e) {
    return { r: null, err: (e as Error).message, log: [...log] }
  }
}

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(240_000)])
const big = randomBytes(8 * 1024 * 1024 + 300_000) // two chunks

let t = await run('image.png', png, [])
check('a PNG lands on thor, its path answered', t.r?.path === 'C:\\Thor\\uploads\\smoke-1-image.png' && saved.at(-1)?.data.equals(png), t)

t = await run('image.png', png, ['drop'])
check('a dropped connection is sent again', t.r && saved.at(-1)?.data.equals(png) && t.log.join(',') === '0:drop,0:ok', t)

t = await run('image.png', png, ['503', '503'])
check('thor busy (503) twice, then taken', t.r && saved.at(-1)?.data.equals(png) && t.log.length === 3, t)

t = await run('image.png', png, ['short'])
check('"chunk arrived short" (the 2:03 PM failure) is sent again', t.r && saved.at(-1)?.data.equals(png) && t.log.join(',') === '0:short,0:ok', t)

t = await run('image.png', png, ['hang'])
check('no answer within the chunk timeout, then taken', t.r && saved.at(-1)?.data.equals(png) && t.log.join(',') === '0:hang,0:ok', t)

// a restart between the two chunks of a big file: thor kept the half file, the upload resumes from it
t = await run('big.bin', big, ['ok' as Fault, 'restart'])
check('a restart mid-file resumes from the half file thor kept', t.r && saved.at(-1)?.data.equals(big) && t.log.join(',') === `0:ok,${8 * 1024 * 1024}:restart`, t)

t = await run('big.bin', big, ['ok' as Fault, 'drop'])
check('a dropped second chunk is sent again from the same offset', t.r && saved.at(-1)?.data.equals(big) && t.log.join(',') === `0:ok,${8 * 1024 * 1024}:drop,${8 * 1024 * 1024}:ok`, t)

t = await run('image.png', png, ['401'])
check('a refused token is not retried, thor\'s words kept', !t.r && t.err === 'unauthorized' && t.log.length === 1, t)

t = await run('image.png', png, ['507'])
check('a full disk on thor is not retried', !t.r && /not enough free space/.test(t.err ?? '') && t.log.length === 1, t)

t = await run('image.png', png, ['drop', 'drop', 'drop', 'drop', 'drop', 'drop', 'drop'])
check('a thor that never comes back fails after the retries, saying so', !t.r && /thor is not answering/.test(t.err ?? '') && t.log.length === 7, t)

srv.close()
console.log(`thorUploadSmoke: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
