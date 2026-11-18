/**
 * What the tunnel hostnames may serve (index.ts, routes/updates.ts), and which
 * origins may read a request trusted by its socket (middleware/origin.ts).
 *
 * Boots the real src/index.ts in a child process, twice: once with
 * UPDATES_VIA_CLOUDFLARE=1 (the transition) and once without it (the default,
 * closed). Each run gets scratch ports, a scratch HOME,
 * data dir and frontend dist, stub binaries first on PATH, a dead proxy for
 * axios, and a fetch stub that stands in for GitHub's release API and refuses
 * every other host, so nothing leaves the box. Linux only (shell stubs); run it
 * on odin from a scratch copy.
 *
 * "Cloudflare" requests carry cf-ray and cf-connecting-ip the way cloudflared
 * delivers them. "serve" requests look like `tailscale serve` (loopback, a
 * trusted tailnet peer in X-Forwarded-For, the serve Host). "direct" requests
 * hit the second listener, which stands in for the tailnet one.
 *
 *   node --import tsx scripts/exposureSmoke.mts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import http from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import jwt from 'jsonwebtoken'

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TSX = import.meta.resolve('tsx')
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'exposure-smoke-')))
const dir = (...p: string[]) => { const d = path.join(root, ...p); fs.mkdirSync(d, { recursive: true }); return d }
const home = dir('home'); const data = dir('data'); const bin = dir('bin'); const dist = dir('dist', 'assets')
const DIST = path.dirname(dist)

const SHELL_MARK = 'exposure-smoke-shell'
const CHUNK = 'console.log("exposure smoke chunk")'
fs.writeFileSync(path.join(DIST, 'index.html'), `<!doctype html><html><body>${SHELL_MARK}</body></html>`)
fs.writeFileSync(path.join(dist, 'x.js'), CHUNK)

for (const b of ['ssh', 'tailscale', 'gh', 'claude', 'systemctl', 'tmux', 'git']) {
  fs.writeFileSync(path.join(bin, b), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
}
fs.writeFileSync(path.join(bin, 'lilkups'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

// GitHub's release API for kups14502/valkyrie, as routes/updates.ts reads it.
const REL = 'https://api.github.com/repos/kups14502/valkyrie/releases'
const EXE = 'Valkyrie_9.9.9_x64-setup.exe'
const ASSETS: Record<string, string> = {
  'latest.json': JSON.stringify({
    version: '9.9.9', notes: 'smoke', pub_date: '2026-11-18T00:00:00Z',
    platforms: {
      'windows-x86_64': { signature: 'sig-w', url: `https://github.com/kups14502/valkyrie/releases/download/app-v9.9.9/${EXE}` },
      'linux-x86_64': { signature: 'sig-l', url: 'https://github.com/kups14502/valkyrie/releases/download/app-v9.9.9/Valkyrie_9.9.9_amd64.AppImage' },
    },
  }),
  [EXE]: 'EXE-BYTES',
  'Valkyrie_9.9.9_amd64.AppImage': 'APPIMAGE-BYTES',
  'Valkyrie_9.9.9_arm64.apk': 'APK-BYTES',
}
const stub = path.join(root, 'fetch-stub.mjs')
fs.writeFileSync(stub, `
const real = globalThis.fetch
const REL = ${JSON.stringify(REL)}
const ASSETS = ${JSON.stringify(ASSETS)}
const names = Object.keys(ASSETS)
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const u = new URL(url)
  if (['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return real(input, init)
  if (url === REL + '/latest') {
    return Response.json({ tag_name: 'app-v9.9.9', published_at: '2026-11-18T00:00:00Z',
      assets: names.map((name, i) => ({ id: i + 1, name, url: REL + '/assets/' + (i + 1) })) })
  }
  const m = url.startsWith(REL + '/assets/') && url.match(/(\\d+)$/)
  if (m && names[Number(m[1]) - 1]) {
    const body = ASSETS[names[Number(m[1]) - 1]]
    return new Response(body, { headers: { 'content-length': String(Buffer.byteLength(body)) } })
  }
  throw new TypeError('exposure smoke: no network to ' + u.host)
}
`)

const SECRET = randomBytes(32).toString('hex')
const TOKEN = jwt.sign({ sub: 'owner', kind: 'app' }, SECRET, { expiresIn: '10m' })
const PEER = '100.100.100.100'
const SERVE_HOST = 'valkyrie-smoke.example.ts.net'
const TUNNEL_HOSTS = ['valkyrie-api.brendonkupsch.com', 'api.brendonkupsch.com', 'master-control-api.brendonkupsch.com']
const PUBLIC_BASE = 'https://valkyrie-api.brendonkupsch.com'
const LISTED = 'https://valkyrie.example.invalid'
const PAGES = 'https://smoke1234.master-control-72u.pages.dev'
const SERVE_ORIGIN = `https://${SERVE_HOST}`

async function freePort(): Promise<number> {
  const s = net.createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const p = (s.address() as net.AddressInfo).port
  await new Promise((r) => s.close(r))
  return p
}

type Run = { child: ChildProcess; logs: string[]; port: number; tport: number }

async function boot(extra: Record<string, string>): Promise<Run> {
  const port = await freePort(); const tport = await freePort()
  const logs: string[] = []
  const child = spawn(process.execPath, ['--import', TSX, '--import', pathToFileURL(stub).href, path.join(BACKEND, 'src', 'index.ts')], {
    // cwd is the scratch root, so dotenv finds no .env to load
    cwd: root,
    env: {
      PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: home,
      NODE_ENV: 'production',
      BIND: '127.0.0.1', PORT: String(port),
      TAILNET_BIND: '127.0.0.1', TAILNET_PORT: String(tport),
      TAILNET_ORIGINS: `https://${SERVE_HOST}`,
      TRUSTED_TAILNET_IPS: PEER,
      ALLOWED_ORIGINS: LISTED,
      FRONTEND_DIST: DIST,
      VALKYRIE_DATA_DIR: data,
      LILKUPS_BIN: path.join(bin, 'lilkups'),
      APP_JWT_SECRET: SECRET,
      GH_RELEASES_TOKEN: 'smoke-not-a-token',
      AGENTS_OFF: '1',
      FRAME_STATS_SSH: 'smoke-no-such-host',
      HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost',
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  for (const s of [child.stdout!, child.stderr!]) {
    s.setEncoding('utf8')
    s.on('data', (d: string) => logs.push(...d.split('\n').filter(Boolean)))
  }
  const until = Date.now() + 60_000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`backend exited ${child.exitCode}:\n${logs.slice(-30).join('\n')}`)
    const a = await get(port, '/healthz').catch(() => null)
    const b = await get(tport, '/healthz').catch(() => null)
    if (a?.status === 200 && b?.status === 200) return { child, logs, port, tport }
    if (Date.now() > until) throw new Error(`backend never answered /healthz:\n${logs.slice(-30).join('\n')}`)
    await new Promise((r) => setTimeout(r, 250))
  }
}

async function stop(run: Run): Promise<void> {
  if (run.child.exitCode !== null) return
  const gone = new Promise((r) => run.child.once('exit', r))
  run.child.kill('SIGTERM')
  const t = setTimeout(() => run.child.kill('SIGKILL'), 5_000)
  await gone
  clearTimeout(t)
}

type Res = { status: number; type: string; cache: string; acao: string; body: string }

function get(port: number, p: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers, agent: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        type: String(res.headers['content-type'] ?? ''),
        cache: String(res.headers['cache-control'] ?? ''),
        acao: String(res.headers['access-control-allow-origin'] ?? ''),
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    r.on('error', reject)
    r.setTimeout(10_000, () => r.destroy(new Error(`timeout ${p}`)))
    r.end()
  })
}

const cf = (host = TUNNEL_HOSTS[0], more: Record<string, string> = {}) => ({
  host, 'cf-ray': '8f0000000000smk-EWR', 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '203.0.113.7',
  'x-forwarded-proto': 'https', accept: 'text/html,*/*', ...more,
})
const serve = (more: Record<string, string> = {}) => ({
  host: SERVE_HOST, 'x-forwarded-for': PEER, 'x-forwarded-host': SERVE_HOST, 'x-forwarded-proto': 'https',
  accept: 'text/html,*/*', ...more,
})
const direct = (run: Run, more: Record<string, string> = {}) => ({ host: `127.0.0.1:${run.tport}`, accept: 'text/html,*/*', ...more })
const auth = { authorization: `Bearer ${TOKEN}` }

let failures = 0
const check = (name: string, ok: boolean, got?: unknown) => {
  console.log(`${ok ? 'pass' : 'FAIL'} ${name}${ok || got === undefined ? '' : ' ' + JSON.stringify(got).slice(0, 300)}`)
  if (!ok) failures++
}
const notFound = (r: Res) => r.status === 404 && r.type.startsWith('text/plain') && !r.body.includes(SHELL_MARK) && !r.body.includes(CHUNK)
const urls = (r: Res): string[] => {
  try { return Object.values((JSON.parse(r.body) as { platforms: Record<string, { url: string }> }).platforms).map((p) => p.url) } catch { return [] }
}
const updateLines = (run: Run) => run.logs.filter((l) => l.startsWith('[updates] {')).map((l) => JSON.parse(l.slice(10)) as Record<string, string>)

async function transition(run: Run): Promise<void> {
  const { port } = run
  // Cloudflare: no frontend on any tunnel hostname
  for (const host of TUNNEL_HOSTS) {
    for (const p of ['/', '/index.html', '/assets/x.js', '/m/today']) {
      const r = await get(port, p, cf(host))
      check(`cloudflare ${host}${p} 404`, notFound(r), [r.status, r.type, r.body.slice(0, 80)])
    }
  }
  let r = await get(port, '/index.html', cf(), 'HEAD')
  check('cloudflare HEAD /index.html 404', r.status === 404, r.status)
  r = await get(port, '/assets/x.js', cf(TUNNEL_HOSTS[0], { 'cf-ray': '' }))
  check('cf-connecting-ip alone still counts as Cloudflare', notFound(r), r.status)

  // Cloudflare: the API behaves as before
  r = await get(port, '/healthz', cf())
  check('cloudflare /healthz 200', r.status === 200, r.status)
  r = await get(port, '/api/auth/status', cf())
  check('cloudflare /api/auth/status 200 json', r.status === 200 && r.type.startsWith('application/json'), [r.status, r.type])
  r = await get(port, '/api/system', cf())
  check('cloudflare /api/system without a token 401', r.status === 401, r.status)
  r = await get(port, '/api/system', cf(TUNNEL_HOSTS[0], auth))
  check('cloudflare /api/system with an app token 200', r.status === 200 && r.type.startsWith('application/json'), [r.status, r.body.slice(0, 120)])
  r = await get(port, '/api/no-such-route', cf(TUNNEL_HOSTS[0], auth))
  check('cloudflare unknown /api route 404, not the shell', r.status === 404 && !r.body.includes(SHELL_MARK), r.status)

  // tailnet through `tailscale serve`: unchanged
  r = await get(port, '/', serve())
  check('serve / 200 shell', r.status === 200 && r.body.includes(SHELL_MARK), r.status)
  r = await get(port, '/index.html', serve())
  check('serve /index.html 200', r.status === 200 && r.body.includes(SHELL_MARK), r.status)
  r = await get(port, '/assets/x.js', serve({ accept: '*/*' }))
  check('serve /assets/x.js 200 immutable', r.status === 200 && r.body === CHUNK && r.cache.includes('immutable'), [r.status, r.cache])
  r = await get(port, '/m/today', serve())
  check('serve SPA deep link 200 shell', r.status === 200 && r.body.includes(SHELL_MARK), r.status)
  r = await get(port, '/api/system', serve())
  check('serve /api/system trusted peer 200', r.status === 200, r.status)

  // the tailnet listener: unchanged
  r = await get(run.tport, '/', direct(run))
  check('direct / 200 shell', r.status === 200 && r.body.includes(SHELL_MARK), r.status)
  r = await get(run.tport, '/assets/x.js', direct(run, { accept: '*/*' }))
  check('direct /assets/x.js 200', r.status === 200 && r.body === CHUNK, r.status)

  // a tailnet caller that adds a Cloudflare header only loses things
  r = await get(port, '/', serve({ 'cf-ray': 'spoofed' }))
  check('serve + added cf-ray: no shell', notFound(r), r.status)
  r = await get(port, '/api/system', serve({ 'cf-ray': 'spoofed' }))
  check('serve + added cf-ray: loses tailnet trust (401)', r.status === 401, r.status)

  // updater, Cloudflare path open: both paths answer, each pointing downloads at itself
  r = await get(port, '/api/updates/latest.json', cf(TUNNEL_HOSTS[0], { accept: '*/*' }))
  let u = urls(r)
  check('cloudflare latest.json 200 (path open)', r.status === 200 && u.length === 2, [r.status, r.body.slice(0, 120)])
  check('cloudflare latest.json downloads stay on the public name', u.length === 2 && u.every((x) => x.startsWith(`${PUBLIC_BASE}/api/updates/asset/`)), u)
  r = await get(port, `/api/updates/asset/${EXE}`, cf(TUNNEL_HOSTS[0], { accept: '*/*' }))
  check('cloudflare asset 200 (path open)', r.status === 200 && r.body === 'EXE-BYTES', r.status)
  check('installers are never edge-cached', r.cache.includes('no-store'), r.cache)
  r = await get(port, '/api/updates/latest.json?current=0.3.200&target=windows&arch=x86_64', serve({ accept: '*/*' }))
  u = urls(r)
  check('serve latest.json 200', r.status === 200 && u.length === 2, r.status)
  check('serve latest.json downloads point at the serve origin', u.length === 2 && u.every((x) => x.startsWith(`https://${SERVE_HOST}/api/updates/asset/`)), u)
  const noProto: Record<string, string> = serve({ accept: '*/*' })
  delete noProto['x-forwarded-proto']
  r = await get(port, '/api/updates/latest.json', noProto)
  u = urls(r)
  check('serve latest.json is https without X-Forwarded-Proto (TAILNET_ORIGINS)', u.length === 2 && u.every((x) => x.startsWith(`https://${SERVE_HOST}/api/updates/asset/`)), u)
  r = await get(run.tport, '/api/updates/latest.json', direct(run, { accept: '*/*' }))
  u = urls(r)
  check('direct latest.json downloads point at the listener', u.length === 2 && u.every((x) => x.startsWith(`http://127.0.0.1:${run.tport}/api/updates/asset/`)), u)
  const exeUrl = new URL(u.find((x) => x.endsWith(encodeURIComponent(EXE))) ?? 'http://127.0.0.1/none')
  r = await get(Number(exeUrl.port) || 1, exeUrl.pathname, direct(run, { accept: '*/*' })).catch(() => ({ status: 0, type: '', cache: '', acao: '', body: '' }))
  check('the direct download URL works', r.status === 200 && r.body === 'EXE-BYTES', r.status)

  await new Promise((r) => setTimeout(r, 300))
  const lines = updateLines(run)
  check('[updates] logs a Cloudflare check', lines.some((l) => l.via === 'cloudflare' && l.path === '/api/updates/latest.json'), lines)
  check('[updates] logs the tailnet check with its version and peer', lines.some((l) => l.via === 'tailnet' && l.current === '0.3.200' && l.ip === PEER), lines)
  check('startup warns that the Cloudflare updater path is open', run.logs.some((l) => l.includes('[updates] UPDATES_VIA_CLOUDFLARE=1')), run.logs.slice(0, 20))

  await origins(run)
}

// CORS and the terminal websocket. A request trusted by its socket address
// (loopback, a trusted tailnet peer through `tailscale serve`) may be read only
// by the app's own origins. ALLOWED_ORIGINS and Pages apply to the rest, which
// need a token anyway.
async function origins(run: Run): Promise<void> {
  const { port } = run
  // the CORS layer refuses with an error, so the route never runs
  const refused = (r: Res) => r.status === 500 && !r.acao && r.body.includes('internal error')
  let r = await get(port, '/api/system', serve({ origin: LISTED }))
  check('serve + ALLOWED_ORIGINS origin: refused, no ACAO', refused(r), [r.status, r.acao, r.body.slice(0, 80)])
  r = await get(port, '/api/auth/status', serve({ origin: LISTED }))
  check('serve + ALLOWED_ORIGINS origin: auth/status refused too', refused(r), [r.status, r.acao, r.body.slice(0, 80)])
  r = await get(port, '/api/system', serve({ origin: PAGES }))
  check('serve + Pages origin: refused', refused(r), [r.status, r.acao])
  r = await get(port, '/api/system', serve({ origin: 'https://evil.example.invalid' }))
  check('serve + foreign origin: refused', refused(r), [r.status, r.acao])
  r = await get(port, '/api/system', serve({ origin: SERVE_ORIGIN }))
  check('serve + its own origin: 200 with ACAO', r.status === 200 && r.acao === SERVE_ORIGIN, [r.status, r.acao])
  r = await get(port, '/api/system', serve({ origin: 'http://tauri.localhost' }))
  check('serve + Tauri origin: 200 with ACAO', r.status === 200 && r.acao === 'http://tauri.localhost', [r.status, r.acao])
  r = await get(run.tport, '/api/system', direct(run, { origin: LISTED }))
  check('loopback + ALLOWED_ORIGINS origin: refused', refused(r), [r.status, r.acao])
  r = await get(run.tport, '/api/system', direct(run, { origin: `http://127.0.0.1:${run.tport}` }))
  check('loopback + same origin: 200', r.status === 200, [r.status, r.acao])
  r = await get(port, '/api/auth/status', cf(TUNNEL_HOSTS[0], { origin: LISTED }))
  check('cloudflare + ALLOWED_ORIGINS origin: 200 with ACAO (unchanged)', r.status === 200 && r.acao === LISTED, [r.status, r.acao])
  r = await get(port, '/api/auth/status', cf(TUNNEL_HOSTS[0], { origin: PAGES }))
  check('cloudflare + Pages origin: 200 with ACAO (unchanged)', r.status === 200 && r.acao === PAGES, [r.status, r.acao])
  r = await get(port, '/api/system', cf(TUNNEL_HOSTS[0], { origin: LISTED }))
  check('cloudflare + ALLOWED_ORIGINS origin, no token: 401', r.status === 401, r.status)
  r = await get(port, '/api/system', cf(TUNNEL_HOSTS[0], { origin: LISTED, ...auth }))
  check('cloudflare + ALLOWED_ORIGINS origin, app token: 200', r.status === 200 && r.acao === LISTED, [r.status, r.acao])
  r = await get(port, '/api/auth/status', cf(TUNNEL_HOSTS[0], { origin: 'https://evil.example.invalid' }))
  check('cloudflare + foreign origin: refused', refused(r), [r.status, r.acao])

  // The terminal websocket. ?s=!x fails the session-name check (400), which
  // runs only after the origin (403) and auth (401) checks pass.
  const ws = { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'c21va2Utd2Vic29ja2V0LWs=' }
  const WS = '/ws/terminal?s=!x'
  r = await get(port, WS, serve({ ...ws, origin: LISTED }))
  check('ws serve + ALLOWED_ORIGINS origin: 403', r.status === 403, r.status)
  r = await get(port, WS, serve({ ...ws, origin: PAGES }))
  check('ws serve + Pages origin: 403', r.status === 403, r.status)
  r = await get(port, WS, serve({ ...ws, origin: SERVE_ORIGIN }))
  check('ws serve + its own origin: passes origin and auth (400)', r.status === 400, r.status)
  r = await get(run.tport, WS, direct(run, { ...ws, origin: LISTED }))
  check('ws loopback + ALLOWED_ORIGINS origin: 403', r.status === 403, r.status)
  r = await get(port, WS, cf(TUNNEL_HOSTS[0], { ...ws, origin: LISTED }))
  check('ws cloudflare + ALLOWED_ORIGINS origin, no token: 401', r.status === 401, r.status)
}

async function closed(run: Run): Promise<void> {
  const { port } = run
  for (const p of ['/api/updates/latest.json', `/api/updates/asset/${EXE}`, '/api/updates/android.apk']) {
    let r = await get(port, p, cf(TUNNEL_HOSTS[0], { accept: '*/*' }))
    check(`closed: cloudflare ${p} 404`, notFound(r) && !r.body.includes('BYTES') && !r.body.includes('platforms'), [r.status, r.body.slice(0, 80)])
    r = await get(port, p, cf(TUNNEL_HOSTS[1], { accept: '*/*' }))
    check(`closed: cloudflare ${TUNNEL_HOSTS[1]}${p} 404`, r.status === 404, r.status)
    r = await get(port, p, serve({ accept: '*/*' }))
    check(`closed: serve ${p} 200`, r.status === 200, [r.status, r.body.slice(0, 80)])
    r = await get(run.tport, p, direct(run, { accept: '*/*' }))
    check(`closed: direct ${p} 200`, r.status === 200, r.status)
  }
  let r = await get(port, '/api/updates/latest.json', cf(), 'HEAD')
  check('closed: cloudflare HEAD latest.json 404', r.status === 404, r.status)
  r = await get(port, '/api/updates/android.apk', serve({ accept: '*/*' }))
  check('closed: serve android.apk is the apk', r.status === 200 && r.body === 'APK-BYTES' && r.type.includes('android.package-archive') && r.cache.includes('no-store'), [r.type, r.cache])
  r = await get(port, '/index.html', cf())
  check('closed: cloudflare /index.html still 404', notFound(r), r.status)
  r = await get(port, '/api/auth/status', cf())
  check('closed: cloudflare /api/auth/status still 200', r.status === 200, r.status)
  r = await get(port, '/api/system', cf(TUNNEL_HOSTS[0], auth))
  check('closed: cloudflare /api/system with a token still 200', r.status === 200, r.status)
  r = await get(port, '/api/updates/latest.json?current=0.3.200&target=windows&arch=x86_64&fallback=1', cf(TUNNEL_HOSTS[0], { accept: '*/*' }))
  check('closed: the fallback endpoint 404s', notFound(r), r.status)
  await new Promise((r) => setTimeout(r, 300))
  const lines = updateLines(run)
  check('closed: a Cloudflare check from a tailnet-era build is logged with its version', lines.some((l) => l.via === 'cloudflare' && l.current === '0.3.200'), lines)
  check('closed: no startup warning', !run.logs.some((l) => l.includes('UPDATES_VIA_CLOUDFLARE')), run.logs.slice(0, 20))
  await origins(run)
}

let run: Run | null = null
try {
  console.log('-- transition (UPDATES_VIA_CLOUDFLARE=1)')
  run = await boot({ UPDATES_VIA_CLOUDFLARE: '1' })
  await transition(run)
  await stop(run)
  console.log('-- default (UPDATES_VIA_CLOUDFLARE unset: closed)')
  run = await boot({})
  await closed(run)
} catch (err) {
  failures++
  console.log('FAIL', (err as Error).message)
} finally {
  if (run) await stop(run)
  if (root.startsWith(fs.realpathSync(os.tmpdir()) + path.sep)) fs.rmSync(root, { recursive: true, force: true })
}
console.log(failures ? `${failures} failed` : 'all passed')
process.exit(failures ? 1 : 0)
