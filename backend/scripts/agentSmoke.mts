/**
 * Code Deck agent smoke tests.
 *
 * Exercises the live agent WebSocket end-to-end against a running backend:
 * multi-tool run + busy stability, cross-turn resume continuity, interrupt,
 * attachment-path passthrough, codex rejection, and reconnect.
 *
 * Run (must use the same Node the backend uses, for the better-sqlite3 ABI):
 *   /usr/bin/node --import tsx scripts/agentSmoke.mts
 *
 * Optional env: PORT (default 3001), MODEL (default claude-haiku-4-5).
 */
import { WebSocket } from 'ws'
import { randomUUID } from 'node:crypto'
import { db, now } from '../src/routes/codeDeck.js'

const PORT = Number(process.env.PORT) || 3001
const MODEL = process.env.MODEL || 'claude-haiku-4-5'
const WS = `ws://127.0.0.1:${PORT}/api/code-deck/agent-ws`

type Ev = Record<string, any>

function createSession(profileId: string): string {
  const id = 'smoke-' + randomUUID()
  const d = db(); const t = now()
  d.prepare(`INSERT INTO code_deck_sessions (id,title,folder,projectRootId,cwd,profileId,model,pinned,status,notes,createdAt,updatedAt,agentSessionId)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, 'smoke', 'Personal', 'valkyrie', '/tmp', profileId, MODEL, 0, 'planned', '', t, t, '')
  d.close()
  return id
}

function cleanup() {
  const d = db()
  d.prepare("DELETE FROM code_deck_messages WHERE sessionId LIKE 'smoke-%'").run()
  d.prepare("DELETE FROM code_deck_sessions WHERE id LIKE 'smoke-%'").run()
  d.close()
}

/** Open a socket and collect events; resolve when `until` returns true or timeout. */
function session(sessionId: string) {
  const ws = new WebSocket(`${WS}?sessionId=${encodeURIComponent(sessionId)}`)
  const events: Ev[] = []
  const open = new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej) })
  ws.on('message', (raw) => { try { events.push(JSON.parse(String(raw))) } catch { /* noop */ } })
  const send = (obj: Ev) => ws.send(JSON.stringify(obj))
  const waitFor = (pred: (e: Ev, all: Ev[]) => boolean, ms = 60000) => new Promise<Ev | null>((resolve) => {
    const hit = events.find((e) => pred(e, events)); if (hit) return resolve(hit)
    const onMsg = (raw: any) => { let e: Ev; try { e = JSON.parse(String(raw)) } catch { return } if (pred(e, events)) { ws.off('message', onMsg); resolve(e) } }
    ws.on('message', onMsg)
    setTimeout(() => { ws.off('message', onMsg); resolve(null) }, ms)
  })
  return { ws, events, open, send, waitFor, close: () => ws.close() }
}

const results: { name: string; ok: boolean; detail: string }[] = []
const record = (name: string, ok: boolean, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function testMultiToolAndBusy() {
  const id = createSession('main-claude')
  const s = session(id)
  await s.open
  const busyLog: boolean[] = []
  s.ws.on('message', (raw) => { try { const e = JSON.parse(String(raw)); if (e.t === 'busy') busyLog.push(e.value) } catch { /* noop */ } })
  s.send({ t: 'user', text: 'Use the Bash tool twice: first run "echo ALPHA", then run "echo BRAVO". Then reply with the single word DONE.' })
  const result = await s.waitFor((e) => e.t === 'result', 90000)
  const tools = s.events.filter((e) => e.t === 'tool_use').length
  const sawAssistant = s.events.some((e) => e.t === 'assistant')
  // busy must not have gone false before the result arrived (no flashing).
  const idxResult = s.events.findIndex((e) => e.t === 'result')
  const falseBeforeResult = s.events.slice(0, idxResult).some((e) => e.t === 'busy' && e.value === false)
  s.close()
  record('multi-tool run completes', Boolean(result) && (result as Ev)?.subtype === 'success', `tools=${tools} subtype=${(result as Ev)?.subtype}`)
  record('busy stays steady (no flashing)', !falseBeforeResult, `busy seq: ${busyLog.join(',')}`)
  record('assistant text emitted', sawAssistant)
  return id
}

async function testResume(id: string) {
  // Same session id → backend resumes context across turns.
  const s = session(id)
  await s.open
  s.send({ t: 'user', text: 'What two words did I ask you to echo a moment ago? Reply with just the two words.' })
  const asst = await s.waitFor((e) => e.t === 'assistant', 90000)
  const text = String((asst as Ev)?.text ?? '').toUpperCase()
  s.close()
  record('resume keeps context across turns', text.includes('ALPHA') && text.includes('BRAVO'), `reply: ${text.slice(0, 60)}`)
}

async function testInterrupt() {
  const id = createSession('main-claude')
  const s = session(id)
  await s.open
  s.send({ t: 'user', text: 'Use the Bash tool to run exactly: sleep 25 && echo WOKE. Then tell me it is done.' })
  const firstTool = await s.waitFor((e) => e.t === 'tool_use', 30000)
  s.send({ t: 'interrupt' })
  const t0 = Date.now()
  const cleared = await s.waitFor((e) => e.t === 'busy' && e.value === false, 10000)
  s.close()
  record('interrupt stops a running tool', Boolean(firstTool) && Boolean(cleared), `cleared in ${Date.now() - t0}ms`)
}

async function testAttachmentPath() {
  const id = createSession('main-claude')
  const s = session(id)
  await s.open
  s.send({ t: 'user', text: 'look at this', attachments: ['/tmp/smoke-attachment-xyz.png'] })
  const userEcho = await s.waitFor((e) => e.t === 'user', 8000)
  s.send({ t: 'interrupt' }) // don't burn tokens letting it actually run
  s.close()
  record('attachment path included in message', String((userEcho as Ev)?.text ?? '').includes('/tmp/smoke-attachment-xyz.png'))
}

async function testCodexRejected() {
  const id = createSession('main-codex')
  const s = session(id)
  await s.open
  s.send({ t: 'user', text: 'hello' })
  const err = await s.waitFor((e) => e.t === 'error', 8000)
  s.close()
  record('codex profile rejected with clear error', /claude/i.test(String((err as Ev)?.message ?? '')), String((err as Ev)?.message ?? '').slice(0, 60))
}

async function testReconnect() {
  const id = createSession('main-claude')
  const s1 = session(id); await s1.open
  const ready1 = await s1.waitFor((e) => e.t === 'ready', 8000)
  s1.close()
  await sleep(500)
  const s2 = session(id); await s2.open
  const ready2 = await s2.waitFor((e) => e.t === 'ready', 8000)
  s2.close()
  record('reconnect re-attaches cleanly', Boolean(ready1) && Boolean(ready2))
}

async function main() {
  console.log(`\n=== Code Deck agent smoke (port ${PORT}, model ${MODEL}) ===\n`)
  try {
    const id = await testMultiToolAndBusy()
    await testResume(id)
    await testInterrupt()
    await testAttachmentPath()
    await testCodexRejected()
    await testReconnect()
  } catch (err) {
    record('harness crashed', false, (err as Error)?.message)
  } finally {
    cleanup()
  }
  const passed = results.filter((r) => r.ok).length
  console.log(`\n=== ${passed}/${results.length} passed ===\n`)
  process.exit(passed === results.length ? 0 : 1)
}

void main()
