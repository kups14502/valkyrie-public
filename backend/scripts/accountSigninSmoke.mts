/**
 * Sign-in automation (lib/accountSignin.ts + routes/accountSignin.ts).
 *
 * Default: an offline run against fakes, on odin from a scratch copy (tmux needed). A fake
 * `claude` prints an authorize URL and reads a code like the real CLI, a fake ssh answers for
 * thor, a scratch inbox records the sign-in note and a loopback server answers the token probe. It drives
 * the routes over HTTP: login and token mode through the one-tap path, a wrong code, the input
 * checks, and the vault file modes. Nothing real is signed in and nothing leaves the box.
 *
 *   node --import tsx scripts/accountSigninSmoke.mts
 *
 * Live: one real sign-in, printed as stages only (never a URL, code or token).
 *
 *   node --import tsx scripts/accountSigninSmoke.mts --live --account <id> --mode login --config-dir <scratch dir>
 *   node --import tsx scripts/accountSigninSmoke.mts --live --account <id> --mode token
 *   add --manual for the one-tap path (the code is read from stdin), --dry-run to stop before mail.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import readline from 'node:readline'

const argv = process.argv.slice(2)
const flag = (n: string) => argv.includes(n)
const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

if (flag('--live')) {
  await live()
} else {
  await offline()
}

async function live(): Promise<void> {
  const lib = await import('../src/lib/accountSignin.ts')
  const accountId = opt('--account')
  const mode = (opt('--mode') ?? 'login') as 'login' | 'token'
  if (!accountId) throw new Error('--account <id> is required')
  const configDir = opt('--config-dir')
  if (mode === 'login' && !configDir) throw new Error('live login runs need --config-dir <scratch dir>; the account dirs are live')
  const start = Date.now()
  const stamp = () => `+${Math.round((Date.now() - start) / 1000)}s`
  const req = await lib.startSignin({ accountId, mode, configDir, auto: !flag('--manual'), dryRun: flag('--dry-run') })
  console.log(stamp(), 'started', req.id, req.label, req.mode)
  let last = ''
  for (;;) {
    await sleep(1000)
    const r = lib.getSignin(req.id)!
    const line = `${r.stage} | ${r.detail ?? ''}`
    if (line !== last) { console.log(stamp(), line); last = line }
    if (r.needsCode && flag('--manual')) {
      const rl = readline.createInterface({ input: process.stdin })
      const code = await new Promise<string>((res) => rl.once('line', res))
      rl.close()
      await lib.submitCode(req.id, code)
    }
    if (r.finishedAt) {
      console.log(stamp(), 'result', JSON.stringify({ ok: r.ok, stage: r.stage, detail: r.detail, fallbackReason: r.fallbackReason, dmSent: r.dmSent, vault: r.vault }))
      break
    }
  }
  process.exit(0)
}

async function offline(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signin-smoke-'))
  fs.chmodSync(root, 0o700)
  const bin = path.join(root, 'bin')
  const cfg = path.join(root, 'acct-cfg')
  fs.mkdirSync(bin); fs.mkdirSync(cfg, { mode: 0o700 })
  const write = (p: string, s: string) => { fs.writeFileSync(p, s, { mode: 0o700 }) }
  const GOOD = 'goodcode1234567890#goodstate1234567890'
  const FAKE_TOKEN = 'te-sto-ken01-' + 'F'.repeat(60)

  write(path.join(bin, 'claude'), `#!/bin/bash
case "$1" in
  auth)
    if [ "$2" = status ]; then echo '{"loggedIn":true,"email":"smoke@example.invalid","authMethod":"claude.ai"}'; exit 0; fi
    echo "Opening browser to sign in…"
    echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=goodstate1234567890"
    printf "Paste code here if prompted > "
    read -r code
    if [ "$code" = "${GOOD}" ]; then echo '{"claudeAiOauth":{"accessToken":"fake"}}' > "$CLAUDE_CONFIG_DIR/.credentials.json"; echo "Login successful."; else echo "Login failed: Request failed with status code 400"; fi
    ;;
  setup-token)
    echo " This will guide you through long-lived (1-year) auth token setup for your Claude account."
    echo "https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=goodstate1234567890"
    printf " Paste code here if prompted > "
    read -r code
    if [ "$code" = "${GOOD}" ]; then printf '\\n Long-lived authentication token created successfully!\\n\\n Your OAuth token (valid for 1 year):\\n\\n ${FAKE_TOKEN}\\n\\n Store this token securely.\\n'; else echo "OAuth error: bad code"; fi
    ;;
esac
sleep 30
`)
  // thor: the browser leg reports a captcha (so the one-tap path runs) and the vault write succeeds.
  write(path.join(bin, 'ssh'), `#!/bin/bash
cat > /dev/null
for a in "$@"; do last="$a"; done
case "$last" in
  *browser-signin.mjs*) echo '{"stage":"opened"}'; echo '{"stage":"page","at":"claude.ai/login"}'; echo '{"result":"fallback","reason":"captcha"}' ;;
  *Write-VaultToken.ps1*) echo "ok smoke-acct" ;;
esac
`)
  write(path.join(bin, 'lilkups'), `#!/bin/bash
cat > "${root}/dm.txt"
echo sent
`)
  fs.writeFileSync(path.join(root, 'accounts.json'), JSON.stringify([
    { id: 'smoke-acct', label: 'Smoke', email: 'smoke@example.invalid', subscription: 'Team', configDir: cfg },
  ]))
  fs.writeFileSync(path.join(cfg, '.credentials.json'), JSON.stringify({ claudeAiOauth: { subscriptionType: 'team', rateLimitTier: 'default_claude_max_5x' } }), { mode: 0o600 })

  const probeSrv = http.createServer((req, res) => {
    const ok = req.headers.authorization === `Bearer ${FAKE_TOKEN}`
    res.writeHead(ok ? 200 : 401, ok ? { 'anthropic-ratelimit-unified-5h-utilization': '0.12', 'anthropic-ratelimit-unified-7d-utilization': '0.3', 'content-type': 'application/json' } : {})
    res.end('{}')
  }).listen(0)
  await new Promise((r) => probeSrv.once('listening', r))

  Object.assign(process.env, {
    CLAUDE_ACCOUNTS_FILE: path.join(root, 'accounts.json'),
    VALKYRIE_ODIN_CLAUDE: path.join(bin, 'claude'),
    VALKYRIE_SSH_BIN: path.join(bin, 'ssh'),
    LILKUPS_BIN: path.join(bin, 'lilkups'),
    // the sign-in steps land in the inbox: a scratch one, never odin's real data dir
    VALKYRIE_DATA_DIR: path.join(root, 'data'),
    CLAUDE_SWITCH_DIR: path.join(root, 'switch'),
    ACCOUNT_SWITCH_TMUX_SOCKET: `claude-signin-smoke-${process.pid}`,
    ACCOUNT_SWITCH_API_BASE: `http://127.0.0.1:${(probeSrv.address() as { port: number }).port}`,
  })

  const express = (await import('express')).default
  const { default: route } = await import('../src/routes/accountSignin.ts')
  const lib = await import('../src/lib/accountSignin.ts')
  const app = express(); app.use(express.json()); app.use('/api', route)
  const srv = app.listen(0)
  await new Promise((r) => srv.once('listening', r))
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}/api`
  const j = async (m: string, p: string, b?: unknown) => {
    const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })
    return [r.status, await r.json()] as [number, any]
  }
  let failures = 0
  const check = (name: string, cond: boolean, extra = '') => {
    console.log(`${cond ? 'pass' : 'FAIL'} ${name}${extra ? ' ' + extra : ''}`)
    if (!cond) failures++
  }
  const waitFor = async (id: string, pred: (r: any) => boolean, ms = 20_000) => {
    const until = Date.now() + ms
    for (;;) {
      const [, body] = await j('GET', `/account-switch/signin/${id}`)
      if (pred(body.request) || Date.now() > until) return body.request
      await sleep(300)
    }
  }

  try {
    // pure parts
    check('extractToken prefix', lib.extractToken(`x\n ${FAKE_TOKEN}\n`) === FAKE_TOKEN)
    check('extractToken heading fallback', lib.extractToken('Your OAuth token (valid for 1 year):\n\n  abcDEF_ghi-' + 'x'.repeat(50) + '\n') === 'abcDEF_ghi-' + 'x'.repeat(50))
    check('extractToken none', lib.extractToken('Paste code here if prompted >') === null)

    // input checks
    check('unknown account 404', (await j('POST', '/account-switch/signin', { accountId: 'nope' }))[0] === 404)
    check('bad mode 400', (await j('POST', '/account-switch/signin', { accountId: 'smoke-acct', mode: 'x' }))[0] === 400)
    check('code for unknown id 404', (await j('POST', '/account-switch/signin/0123456789ab/code', { code: GOOD }))[0] === 404)
    check('malformed id 400', (await j('POST', '/account-switch/signin/zz/code', { code: GOOD }))[0] === 400)

    // login mode: thor reports a captcha, the DM goes out, the pasted code finishes it.
    let [st, body] = await j('POST', '/account-switch/signin', { accountId: 'smoke-acct', mode: 'login', auto: true })
    check('login start 202', st === 202, JSON.stringify(body).slice(0, 120))
    const id1 = body.request.id
    check('second start 409', (await j('POST', '/account-switch/signin', { accountId: 'smoke-acct', mode: 'token' }))[0] === 409)
    let r = await waitFor(id1, (x) => x.needsCode || x.finishedAt)
    check('login needs code after captcha', r.needsCode === true && r.fallbackReason === 'captcha' && r.dmSent === true, `${r.stage} ${r.detail}`)
    const inbox = await import('../src/lib/inboxStore.ts')
    const note = inbox.listInbox({ source: 'claude' })[0]
    const dm = note ? `${note.title}
${note.body}` : ''
    check('inbox note carries the authorize URL and the reason', dm.includes('oauth/authorize') && /captcha/.test(dm))
    check('inbox note opens the paste page', note?.url === `/m/ai/usage?signin=${id1}`, String(note?.url))
    check('no Discord DM while the inbox works', !fs.existsSync(path.join(root, 'dm.txt')))
    check('status never carries the URL', !JSON.stringify((await j('GET', '/account-switch/signin'))[1]).includes('oauth/authorize'))
    check('malformed code 400', (await j('POST', `/account-switch/signin/${id1}/code`, { code: 'not a code' }))[0] === 400)
    ;[st] = await j('POST', `/account-switch/signin/${id1}/code`, { code: ` ${GOOD}\n` })
    check('code accepted', st === 200)
    r = await waitFor(id1, (x) => x.finishedAt)
    check('login done', r.ok === true && r.stage === 'done', r.detail)
    check('grant written to the config dir', fs.readFileSync(path.join(cfg, '.credentials.json'), 'utf8').includes('fake'))
    check('card lock released', !fs.existsSync(path.join(cfg, '.credentials.refresh.lock')))

    // a wrong code fails the request
    fs.writeFileSync(path.join(cfg, '.credentials.json'), JSON.stringify({ claudeAiOauth: { subscriptionType: 'team', rateLimitTier: 'default_claude_max_5x' } }), { mode: 0o600 })
    ;[st, body] = await j('POST', '/account-switch/signin', { accountId: 'smoke-acct', mode: 'login' })
    const id2 = body.request.id
    r = await waitFor(id2, (x) => x.needsCode)
    check('manual path skips thor', r.fallbackReason === 'manual', r.detail)
    // a code is checked against the link's state first: one from another link never reaches the CLI
    ;[st] = await j('POST', `/account-switch/signin/${id2}/code`, { code: 'wrongcode1234567890#wrongstate123456' })
    check('a code from an older link is 409', st === 409, String(st))
    r = await waitFor(id2, (x) => x.needsCode)
    check('the sign-in still waits after an old link\'s code', r.needsCode === true && !r.finishedAt, `${r.stage} ${r.detail}`)
    // the whole callback address works as well as code#state
    check('parseCode reads a callback address', lib.parseCode('https://console.anthropic.com/oauth/code/callback?code=goodcode1234567890&state=goodstate1234567890') === GOOD)
    check('stateOf reads the link', lib.stateOf('https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=goodstate1234567890') === 'goodstate1234567890')
    // the right link, the wrong code: the CLI refuses it
    await j('POST', `/account-switch/signin/${id2}/code`, { code: 'wrongcode1234567890#goodstate1234567890' })
    r = await waitFor(id2, (x) => x.finishedAt)
    check('wrong code fails', r.ok === false && /Login failed/.test(r.detail ?? ''), r.detail)

    // token mode: the token lands in odin's vault (0600 in 0700) and the fake thor write says ok.
    ;[st, body] = await j('POST', '/account-switch/signin', { accountId: 'smoke-acct', mode: 'token', auto: true })
    const id3 = body.request.id
    r = await waitFor(id3, (x) => x.needsCode)
    check('token mode reaches the code step', r.needsCode === true && r.target === 'vault', r.detail)
    await j('POST', `/account-switch/signin/${id3}/code`, { code: GOOD })
    r = await waitFor(id3, (x) => x.finishedAt)
    check('token stored', r.ok === true && r.vault?.odin === true && r.vault?.thor === true && r.vault?.probeStatus === 200, `${r.detail} ${JSON.stringify(r.vault)}`)
    const vdir = path.join(root, 'switch', 'tokens')
    const vfile = path.join(vdir, 'smoke-acct.json')
    check('vault dir 0700', (fs.statSync(vdir).mode & 0o777) === 0o700)
    check('vault file 0600', (fs.statSync(vfile).mode & 0o777) === 0o600)
    const rec = JSON.parse(fs.readFileSync(vfile, 'utf8'))
    check('vault record shape', rec.accessToken === FAKE_TOKEN && rec.refreshToken === null && rec.scopes[0] === 'user:inference' && rec.subscriptionType === 'team' && rec.rateLimitTier === 'default_claude_max_5x' && rec.validFor === '1 year' && rec.expiresAt > Date.now())
    check('scratch config dir removed', fs.readdirSync(path.join(root, 'switch', 'signin')).length === 0)
    const [, list] = await j('GET', '/account-switch/signin')
    check('GET lists the vault without the token', list.vault[0].present === true && !JSON.stringify(list).includes(FAKE_TOKEN))
    check('GET never carries a code', !JSON.stringify(list).includes('goodcode'))

    // the fourth sign-in for one account in a day is refused
    ;[st] = await j('POST', '/account-switch/signin', { accountId: 'smoke-acct', mode: 'login' })
    check('per-account daily cap', st === 429, String(st))
    check('sync-thor copies the vault record', (await j('POST', '/account-switch/signin/sync-thor', { accountId: 'smoke-acct' }))[1].ok === true)
  } finally {
    srv.close(); probeSrv.close()
    const { spawnSync } = await import('node:child_process')
    spawnSync('tmux', ['-L', process.env.ACCOUNT_SWITCH_TMUX_SOCKET!, 'kill-server'], { stdio: 'ignore' })
  }
  fs.rmSync(root, { recursive: true, force: true })
  console.log(failures ? `${failures} FAILED` : 'all passed')
  process.exit(failures ? 1 : 0)
}
