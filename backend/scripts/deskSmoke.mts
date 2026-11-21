/**
 * Desk smoke test: the pane state on GET /api/terminal/sessions (terminal/paneState.ts).
 *
 *   1. The pure rules: the title cleaning (Claude's glyph off, tmux's and a shell's defaults
 *      empty), the asking rule (a question as the last line, a `Next:` line, a code block that
 *      ends in a question mark asks nothing), the last reply out of transcript entries, the busy
 *      rule Raven shares.
 *   2. The tracker over fakes: working, asking from the transcript and from thor's board, idle
 *      for a plain reply, shell, dead, thor down is idle, stateSince, a transcript read once per
 *      turn end and never per poll, captures only for panes that printed in the last 30 s and at
 *      most once per 1.5 s, short waits on a slow capture or read, a turn that ended between two
 *      polls, 15 panes captured in parallel.
 *   3. The real route end to end: GET /api/terminal/sessions on a throwaway express app, with a
 *      FAKE tmux binary (canned list-sessions output, screens and pane facts), a fake thor file
 *      service (transcripts) and a fake thor launcher (the board). Every old field is kept, the
 *      title comes from #{pane_title}, the board is read through the one shared copy, a project
 *      hidden from a Cloudflare caller loses its title and follow-up line too.
 *
 * No real tmux server, no pane, no ssh, no thor, no Claude. Runs on odin against a scratch data dir:
 *   bash C:/Thor/var/vk-lanes/lane.sh smoke <lane> backend/scripts/deskSmoke.mts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import type { TermSession } from '../src/terminal/tmux.ts'
import type { TranscriptEntry, TranscriptPage } from '../src/terminal/transcript.ts'

const LIVE_DIR = path.join(os.homedir(), 'valkyrie', 'backend', 'data')
const real = (p: string) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }
const dataDir = process.env.VALKYRIE_DATA_DIR
if (!dataDir || real(dataDir) === real(LIVE_DIR)) {
  console.error('deskSmoke: set VALKYRIE_DATA_DIR to a scratch directory')
  process.exit(2)
}
if (process.platform === 'win32') {
  console.error('deskSmoke: Linux only (the fake tmux is a sh script). Run it on odin.')
  process.exit(2)
}

let pass = 0, fail = 0
const check = (name: string, ok: boolean, got?: unknown) => {
  if (ok) pass += 1
  else { fail += 1; console.log('FAIL', name, JSON.stringify(got)?.slice(0, 900)) }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// paneState.ts reads no env and opens nothing: safe to import first
const PS = await import('../src/terminal/paneState.ts')

// ------------------------------------------------------ 1. the pure rules ---

{
  const t = PS.cleanTitle
  const hostDefaults = ['odin', 'odin', 'ssh', 'vk-e2e00000a1']
  const cases: [string, string, string[]?][] = [
    ['\u2733 Fix printer queue', 'Fix printer queue'],
    ['\u2810 Fix printer queue', 'Fix printer queue'],
    ['\u280b\u2733  Router  upgrade ', 'Router upgrade'],
    ['* Router upgrade', 'Router upgrade'],
    ['\u00b7 Router upgrade', 'Router upgrade'],
    ['(draft) Router upgrade', '(draft) Router upgrade'],
    ['2026 taxes', '2026 taxes'],
    ['odin', '', hostDefaults],
    ['odin.tailnet.example', '', ['odin.tailnet.example']],
    ['ODIN', '', hostDefaults],
    ['ssh', '', hostDefaults],
    ['bash', ''],
    ['pwsh', ''],
    ['\u2733 Claude Code', ''],
    ['Claude Code', ''],
    ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', ''],
    ['Administrator: C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ''],
    ['/usr/bin/ssh', ''],
    ['brendon@odin: ~/valkyrie', ''],
    ['', ''],
    ['   ', ''],
    ['\u2733', ''],
    ['vk-e2e00000a1', '', hostDefaults],
    ['tab\there', 'tab here'],
    ['✳ Debug setup.exe', 'Debug setup.exe'],
    ['pwsh.exe', ''],
    ['Windows PowerShell', ''],
  ]
  for (const [raw, want, defs] of cases) {
    const got = t(raw, defs ?? [])
    check(`cleanTitle(${JSON.stringify(raw)})`, got === want, { got, want })
  }
  const long = t(`\u2733 ${'a'.repeat(300)}`)
  check('cleanTitle clips a long title to 120 with an ellipsis', long.length === 120 && long.endsWith('\u2026'), long.length)
}

{
  const a = PS.askLine
  const cases: [string, string, string][] = [
    ['a question as the last line', 'Fixed the queue.\n\nWant me to restart the spooler too?', 'Want me to restart the spooler too?'],
    ['trailing markdown and quotes are ignored', 'Done.\n\n**Should I push the branch?**  ', 'Should I push the branch?'],
    ['a quoted question', 'Done.\n\nShe asked "is the printer on?"', 'She asked "is the printer on?"'],
    ['a question in brackets', 'Done (want the log too?)', 'Done (want the log too?)'],
    ['a Next: line', 'Done.\n\nNext: restart the print spooler on the front desk PC.', 'Next: restart the print spooler on the front desk PC.'],
    ['a bold Next: line in a list', 'Done.\n\n- **Next:** open the router page and press Save.', 'Next: open the router page and press Save.'],
    ['a Next: line that is not the last line', 'Next: reboot the PC.\n\nThe log is in the vault.', 'Next: reboot the PC.'],
    ['a plain finished reply asks nothing', 'All done. The printer prints again.', ''],
    ['a question earlier in the reply asks nothing', 'Was it the spooler? Yes.\n\nIt prints again.', ''],
    ['a code block ending in a question mark asks nothing', 'Run this:\n\n```bash\nread -p "Continue?"\n```', ''],
    ['a question inside a closed block, then nothing', 'Here:\n```\nis it on?\n```\n', ''],
    ['an unclosed code block asks nothing', 'Run this:\n```\nread -p "ok?"', ''],
    ['a tilde fence too', 'Here:\n~~~\nok?\n~~~', ''],
    ['a Next: line inside a code block is code', 'Example:\n```\nNext: not a real line\n```', ''],
    ['a fence indented under a nested list item is a fence', '1. On the PC:\n   - run:\n\n     ```\n     Next: not a real line\n     ```', ''],
    ['text after a code block still counts', 'Run this:\n```\nls\n```\nWant me to run it?', 'Want me to run it?'],
    ['the question wins over an earlier Next: line', 'Next: check the logs.\nShould I restart it?', 'Should I restart it?'],
    ['lowercase next: is not his rule', 'Done.\nnext: whatever', ''],
    ['a full-width question mark', '\u8981\u91cd\u542f\u5417\uff1f', '\u8981\u91cd\u542f\u5417\uff1f'],
    ['empty', '', ''],
  ]
  for (const [name, text, want] of cases) {
    const got = a(text)
    check(`askLine: ${name}`, got === want, { got, want })
  }
  const long = a(`${'word '.repeat(60)}ok?`)
  check('askLine clips to 160 characters', long.length === 160 && long.endsWith('\u2026'), long.length)
}

let nId = 0
const E = (kind: TranscriptEntry['kind'], text?: string): TranscriptEntry => ({ id: `e${++nId}`, at: 0, kind, text })
{
  const r = PS.lastReply
  check('lastReply: the text after the last tool step', r([E('user', 'fix it'), E('assistant', 'Looking.'), E('tool'), E('result'), E('assistant', 'Fixed. Restart?')]) === 'Fixed. Restart?')
  check('lastReply: thinking, tasks and notices after it are skipped', r([E('assistant', 'Fixed.'), E('thinking'), E('todo'), E('system', 'Conversation compacted')]) === 'Fixed.')
  check('lastReply: two text blocks are one reply', r([E('user', 'go'), E('assistant', 'Done.'), E('assistant', 'Next: reboot.')]) === 'Done.\n\nNext: reboot.')
  check('lastReply: a prompt after it means he answered', r([E('assistant', 'Restart?'), E('user', 'yes')]) === '')
  check('lastReply: an interrupt ends it', r([E('assistant', 'Restart?'), E('system', 'Interrupted')]) === '')
  check('lastReply: a tool still waiting is no reply', r([E('assistant', 'Restart?'), E('tool')]) === '')
  check('lastReply: nothing', r([]) === '')
}

const IDLE_SCREEN = '\u256d\u2500\u2500\u2500\u256e\n\u2502 > \u2502\n\u2570\u2500\u2500\u2500\u256f\n  ? for shortcuts\n'
const BUSY_SCREEN = `${IDLE_SCREEN}\n\u273b Thinking\u2026 (12s \u00b7 esc to interrupt)\n`
{
  const now = 1_800_000_000_000
  const p = { name: 'vk-e2e00000b1', dead: false, activityAt: now - 3_600_000, outputAt: now - 5_000 }
  const cap = async () => BUSY_SCREEN
  check('busy rule: printed 5 s ago with the busy line', await PS.paneBusy(p, cap, now))
  check('busy rule: the busy line alone, quiet for a minute, is not working', !(await PS.paneBusy({ ...p, outputAt: now - 60_000 }, cap, now)))
  check('busy rule: a key typed 5 s ago counts as printed (Raven\'s panes carry activityAt only)', await PS.paneBusy({ name: p.name, dead: false, activityAt: now - 5_000 }, cap, now))
  check('busy rule: a dead pane is not working', !(await PS.paneBusy({ ...p, dead: true }, cap, now)))
  check('busy rule: an idle screen is not working', !(await PS.paneBusy(p, async () => IDLE_SCREEN, now)))
  check('busy rule: an unreadable screen is not working', !(await PS.paneBusy(p, async () => null, now)))
  check('screenBusy: the words in any case', PS.screenBusy('(3s \u00b7 ESC to interrupt)') && !PS.screenBusy(null))
}

// 2.1.322 dropped "esc to interrupt" from the busy line: vk-9bbd600d87 and vk-bbdcd8078f on 2026-11-21, in the middle
// of a job and read as idle
{
  const RULE = '\u2500'.repeat(80)
  const box = `${RULE}\n> \n${RULE}  Opus 5.5 C:\\...\\server\\valkyrie (main) | eff xhigh wk 31%\n  \u23f5\u23f5 bypass permissions on (shift+tab to cycle) \u00b7 \u2190 5 agents\n`
  const job = [
    '\u25cf The report already keeps daily numbers, so no sync change is needed there. Reading its records.',
    '',
    '\u25cf Running 1 shell command\u2026',
    '  \u23bf  $ cd backend/src/lib && sed -n 185,210p tables.ts',
    '',
  ].join('\n')
  const thinking = `${job}\n\u2736 Zigzagging\u2026 (12m 18s \u00b7 \u2193 54.7k tokens \u00b7 still thinking with xhigh effort)\n\n${box}`
  const tasks = `${job}\n${' '.repeat(120)}\u273d Deliberating\u2026 (8m 16s \u00b7 \u2193 40.0k tokens)\n  \u23bf  \u25fc Move the helpers to their own module\n     \u25fb Run lint\n\n${box}`
  const starting = `${job}\n* Grooving\u2026\n\n${box}`
  const done = `\u25cf Your message came through as only "ed.".\n  What do you want me to do?\n\n\u273b Saut\u00e9ed for 4s \u00b7 done 6:31 PM\n\n${box}`
  const quoted = `\u25cf The card read:\n  \u2736 Zigzagging\u2026 (12m 18s \u00b7 \u2193 54.7k tokens)\n  That was the old rule.\n\n\u273b Worked for 2m 3s\n\n${box}`
  check('screenBusy 2.1.322: the spinner line with its time and tokens', PS.screenBusy(thinking))
  check('screenBusy 2.1.322: a task list between it and the prompt box', PS.screenBusy(tasks))
  check('screenBusy 2.1.322: the spinner before its time shows', PS.screenBusy(starting))
  check('screenBusy 2.1.322: a finished turn is not busy', !PS.screenBusy(done))
  check('screenBusy 2.1.322: a spinner line quoted in the answer is not busy', !PS.screenBusy(quoted))
  check('screenBusy 2.1.322: a spinner line under the prompt box is not the busy line', !PS.screenBusy(`${done}\u2736 Zigzagging\u2026 (3s)\n`))
  check('screenBusy 2.1.322: a tool step\'s own line is not the busy line', !PS.screenBusy(`${job}\n${box}`))
}

// --------------------------------------------- 2. the tracker over fakes ---

{
  let clock = 1_800_000_000_000
  const sidOf = (name: string) => `0d5e0000-0000-4000-8000-${name.slice(-12).replace(/[^0-9a-f]/g, '0').padStart(12, '0')}`
  type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void }
  const defer = <T,>(): Deferred<T> => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r }); return { promise, resolve } }
  const screens = new Map<string, string | Deferred<string> | { delay: number; screen: string }>()
  const replies = new Map<string, TranscriptEntry[] | 'down' | Deferred<TranscriptEntry[]>>()
  const pageSid = new Map<string, string>()
  let board: Record<string, unknown>[] | null = []
  // when the fake copy was read from thor, and the last turn end the tracker asked it to be newer than
  let boardAt = 0
  let boardAfter = -1
  const captures: string[] = []
  const reads: string[] = []
  const io = {
    capture: async (name: string): Promise<string | null> => {
      captures.push(name)
      const s = screens.get(name)
      if (s === undefined) return IDLE_SCREEN
      if (typeof s === 'string') return s
      if ('promise' in s) return s.promise
      await sleep(s.delay)
      return s.screen
    },
    transcript: async (name: string): Promise<TranscriptPage | null> => {
      reads.push(name)
      const t = replies.get(name)
      if (t === 'down') throw new Error("thor's file service is not answering (timed out)")
      const entries = t === undefined ? [] : Array.isArray(t) ? t : await t.promise
      return { sessionId: pageSid.get(name) ?? sidOf(name), file: 'x.jsonl', cursor: '', entries, more: false, reset: false }
    },
    board: (after: number) => { boardAfter = after; return board === null ? null : { at: boardAt, rows: board } },
    now: () => clock,
  }
  const tracker = PS.paneStateTracker(io)
  const row = (name: string, o: Partial<TermSession> = {}): TermSession => ({
    name, label: name, mode: 'new', host: 'thor', target: 'personal', sessionId: sidOf(name), createdAt: clock - 3_600_000,
    activityAt: clock - 3_600_000, clients: 0, dead: false, deadStatus: null, deadText: '', size: '120x40', projectId: '',
    outputAt: clock, title: '', ...o,
  })
  const one = async (r: TermSession) => (await tracker.annotate([r]))[0]
  const count = (list: string[], name: string) => list.filter((n) => n === name).length
  const turn = (reply: string): TranscriptEntry[] => [E('user', 'do the thing'), E('tool'), E('result'), E('assistant', reply)]

  // working, then done with a question
  const A = 'vk-e2e00000a1'
  screens.set(A, BUSY_SCREEN)
  let s = await one(row(A))
  check('tracker: working while the busy line shows', s.state === 'working' && s.ask === '' && s.stateSince === clock, s)
  const workingSince = s.stateSince
  clock += 500
  s = await one(row(A))
  check('tracker: a second poll within 1.5 s reuses the capture', count(captures, A) === 1 && s.state === 'working' && s.stateSince === workingSince, { captures, s })
  check('tracker: no transcript read while working', count(reads, A) === 0, reads)
  clock += 2_000
  screens.set(A, IDLE_SCREEN)
  replies.set(A, turn('Fixed the queue.\n\nWant me to restart the spooler too?'))
  s = await one(row(A, { outputAt: clock - 1_000 }))
  check('tracker: done with a question is asking, with the question', s.state === 'asking' && s.ask === 'Want me to restart the spooler too?' && s.stateSince === clock, s)
  const askingSince = s.stateSince
  check('tracker: the transcript is read once at the turn end', count(reads, A) === 1, reads)
  for (let i = 0; i < 4; i++) {
    clock += 2_000
    s = await one(row(A, { outputAt: clock - 2_000 }))
  }
  check('tracker: later polls read no transcript and keep stateSince', count(reads, A) === 1 && s.state === 'asking' && s.stateSince === askingSince, { reads: count(reads, A), s })
  check('tracker: a pane that printed lately is captured again after 1.5 s', count(captures, A) === 6, count(captures, A))

  // he answers: working again, the old question goes, then a plain finish is idle
  clock += 2_000
  screens.set(A, BUSY_SCREEN)
  s = await one(row(A, { outputAt: clock }))
  check('tracker: answered and working again: no ask', s.state === 'working' && s.ask === '' && s.stateSince === clock, s)
  clock += 2_000
  screens.set(A, IDLE_SCREEN)
  replies.set(A, [...turn('Want me to restart the spooler too?'), E('user', 'yes'), E('tool'), E('result'), E('assistant', 'Restarted. It prints again.')])
  s = await one(row(A, { outputAt: clock }))
  check('tracker: a plain finished reply is idle', s.state === 'idle' && s.ask === '' && s.stateSince === clock && count(reads, A) === 2, { s, reads: count(reads, A) })

  // Next: line
  const B = 'vk-e2e00000a2'
  screens.set(B, BUSY_SCREEN)
  await one(row(B))
  clock += 2_000
  screens.set(B, IDLE_SCREEN)
  replies.set(B, turn('Done.\n\nNext: restart the print spooler on the front desk PC.'))
  s = await one(row(B))
  check('tracker: a Next: line is asking, with the line', s.state === 'asking' && s.ask === 'Next: restart the print spooler on the front desk PC.', s)

  // a code block that ends in a question mark
  const C = 'vk-e2e00000a3'
  replies.set(C, turn('Run this on the PC:\n\n```powershell\nRead-Host "Continue?"\n```'))
  s = await one(row(C, { outputAt: clock - 3_600_000 }))
  check('tracker: a reply ending in a code block with a ? inside is idle', s.state === 'idle', s)
  check('tracker: a pane quiet for an hour is not captured, its transcript read once on first sight', count(captures, C) === 0 && count(reads, C) === 1, { captures, reads })

  // thor's board says it waits on him (a permission prompt)
  const D = 'vk-e2e00000a4'
  replies.set(D, turn('Let me check the router.'))
  board = [
    { sessionId: sidOf(D), activity: 'asking', live: true },
    { sessionId: sidOf(C), activity: 'working', live: true },
    { sessionId: '0d5e0000-0000-4000-8000-ffffffffffff', activity: 'asking', live: true },
  ]
  s = await one(row(D, { outputAt: clock - 3_600_000 }))
  check('tracker: board asking is asking, with the board line', s.state === 'asking' && s.ask === PS.BOARD_ASK, s)
  s = await one(row(C, { outputAt: clock - 3_600_000 }))
  check('tracker: another session asking on the board is not this one', s.state === 'idle', s)
  // after /clear the pane runs another conversation: the transcript names it, the board row is under it
  const D2 = 'vk-e2e00000a5'
  pageSid.set(D2, '0d5e0000-0000-4000-8000-0000000c1ea2')
  replies.set(D2, turn('Reading the logs.'))
  board = [...board, { sessionId: '0d5e0000-0000-4000-8000-0000000c1ea2', activity: 'asking', live: true }]
  s = await one(row(D2, { outputAt: clock - 3_600_000 }))
  check('tracker: board asking under the id the transcript names (after /clear)', s.state === 'asking' && s.ask === PS.BOARD_ASK, s)
  // a question in the reply and the board both: the question is the line
  const D3 = 'vk-e2e00000a6'
  replies.set(D3, turn('Which printer do you mean?'))
  board = [...board, { sessionId: sidOf(D3), activity: 'asking', live: true }]
  s = await one(row(D3, { outputAt: clock - 3_600_000 }))
  check('tracker: with both, the question is the ask', s.state === 'asking' && s.ask === 'Which printer do you mean?', s)
  // the board stops saying asking: back to idle
  board = board.filter((r) => r.sessionId !== sidOf(D))
  clock += 2_000
  s = await one(row(D, { outputAt: clock - 3_600_000 }))
  check('tracker: the board no longer asking is idle again, with a new stateSince', s.state === 'idle' && s.stateSince === clock && count(reads, D) === 1, { s, reads: count(reads, D) })

  // thor down: no board, no transcript
  const F = 'vk-e2e00000a7'
  board = null
  replies.set(F, 'down')
  screens.set(F, BUSY_SCREEN)
  await one(row(F))
  clock += 2_000
  screens.set(F, IDLE_SCREEN)
  s = await one(row(F))
  check('tracker: thor down is idle', s.state === 'idle' && s.ask === '', s)
  check('tracker: thor down is idle for a board-asking session too', (await one(row(D, { outputAt: clock - 3_600_000 }))).state === 'idle')
  clock += 2_000
  await one(row(F))
  clock += 2_000
  await one(row(F))
  check('tracker: a failed read is not retried on every poll', count(reads, F) === 1, count(reads, F))
  clock += PS.RECHECK_MS
  replies.set(F, turn('Should I open a ticket for it?'))
  s = await one(row(F, { outputAt: clock - 60_000 }))
  check('tracker: thor back: the read is tried again after the wait and finds the question', s.state === 'asking' && count(reads, F) === 2, { s, reads: count(reads, F) })
  board = []

  // a permission prompt mid-turn, then a plain finish: a board copy read before the turn ended is stale
  const Q = 'vk-e2e00000b2'
  screens.set(Q, BUSY_SCREEN)
  await one(row(Q))
  boardAt = clock
  board = [{ sessionId: sidOf(Q), activity: 'asking', live: true }]
  clock += 2_000
  screens.set(Q, IDLE_SCREEN)
  replies.set(Q, turn('Done, the share is mapped.'))
  s = await one(row(Q, { outputAt: clock - 1_000 }))
  check('tracker: a board copy read before the turn ended says nothing about it', s.state === 'idle' && s.ask === '', s)
  check('tracker: the turn end asks for a board newer than it', boardAfter === clock, { boardAfter, clock })
  boardAt = clock + 500
  clock += 2_000
  s = await one(row(Q, { outputAt: clock - 3_000 }))
  check('tracker: a board read after the turn ended that says asking is asking', s.state === 'asking' && s.ask === PS.BOARD_ASK, s)
  board = []
  boardAt = 0

  // a slow read from one turn end lands while the next turn runs: its question is not the next turn's
  const R = 'vk-e2e00000b3'
  screens.set(R, BUSY_SCREEN)
  await one(row(R))
  clock += 2_000
  screens.set(R, IDLE_SCREEN)
  const oldRead = defer<TranscriptEntry[]>()
  replies.set(R, oldRead)
  s = await one(row(R))
  check('tracker: turn end with a read that hangs: idle for now', s.state === 'idle', s)
  clock += 2_000
  screens.set(R, BUSY_SCREEN)
  s = await one(row(R))
  check('tracker: he typed, working again', s.state === 'working', s)
  oldRead.resolve(turn('Should I restart the spooler?'))
  await sleep(10)
  clock += 2_000
  screens.set(R, IDLE_SCREEN)
  const newRead = defer<TranscriptEntry[]>()
  replies.set(R, newRead)
  s = await one(row(R))
  check('tracker: a question from the turn before, landed late, is not the new turn\'s ask', s.state === 'idle' && s.ask === '', s)
  newRead.resolve(turn('Restarted. It prints again.'))
  await sleep(10)
  clock += 2_000
  s = await one(row(R, { outputAt: clock - 60_000 }))
  check('tracker: the new turn\'s own reply decides', s.state === 'idle' && count(reads, R) === 2, { s, reads: count(reads, R) })

  // shell and dead
  const G = 'vk-e2e00000a8'
  const H = 'vk-e2e00000a9'
  screens.set(G, BUSY_SCREEN)
  screens.set(H, BUSY_SCREEN)
  const [g, h] = await tracker.annotate([row(G, { mode: 'shell', sessionId: '' }), row(H, { dead: true })])
  check('tracker: a shell pane is shell, a dead pane dead', g.state === 'shell' && h.state === 'dead' && g.ask === '' && h.ask === '', { g, h })
  check('tracker: neither is captured nor read', count(captures, G) + count(captures, H) + count(reads, G) + count(reads, H) === 0, { captures, reads })
  check('tracker: every other field is kept', g.label === G && g.mode === 'shell' && h.dead === true && h.size === '120x40' && 'outputAt' in h && 'title' in h, { g, h })

  // a slow transcript read: the list does not wait for it
  const K = 'vk-e2e00000aa'
  const slowRead = defer<TranscriptEntry[]>()
  replies.set(K, slowRead)
  screens.set(K, BUSY_SCREEN)
  await one(row(K))
  clock += 2_000
  screens.set(K, IDLE_SCREEN)
  let t0 = Date.now()
  s = await one(row(K))
  let took = Date.now() - t0
  check('tracker: a read that hangs holds the list under a second, then idle', s.state === 'idle' && took < 1_300 && took >= PS.ASK_WAIT_MS - 50, { s, took })
  slowRead.resolve(turn('Is the new toner in?'))
  await sleep(10)
  clock += 2_000
  s = await one(row(K, { outputAt: clock - 60_000 }))
  check('tracker: the late answer lands on the next poll', s.state === 'asking' && s.ask === 'Is the new toner in?' && count(reads, K) === 1, { s, reads: count(reads, K) })

  // a slow capture: the list keeps the last known answer
  const L = 'vk-e2e00000ab'
  screens.set(L, BUSY_SCREEN)
  await one(row(L))
  clock += 2_000
  const hang = defer<string>()
  screens.set(L, hang)
  t0 = Date.now()
  s = await one(row(L))
  took = Date.now() - t0
  check('tracker: a capture that hangs holds the list about a second, last answer kept', s.state === 'working' && took < 1_400, { s, took })
  clock += 2_000
  s = await one(row(L))
  check('tracker: no second capture while one is still running', count(captures, L) === 2, count(captures, L))
  hang.resolve(IDLE_SCREEN)
  await sleep(10)
  replies.set(L, turn('All set.'))
  clock += 2_000
  s = await one(row(L))
  check('tracker: once it answers, the pane is done', s.state === 'idle', s)

  // a turn that started and ended between two polls
  const M = 'vk-e2e00000ac'
  replies.set(M, turn('Done, the share is mapped.'))
  s = await one(row(M, { outputAt: clock - 3_600_000 }))
  check('tracker: quiet pane, plain reply: idle', s.state === 'idle' && count(reads, M) === 1, s)
  clock += 3_000
  replies.set(M, [...turn('Done, the share is mapped.'), E('user', 'map the second one too'), E('assistant', 'Mapped. Want a desktop shortcut for it?')])
  s = await one(row(M, { outputAt: clock - 1_000 }))
  check('tracker: printed since, but within 10 s of the last read: not read again yet', s.state === 'idle' && count(reads, M) === 1, { s, reads: count(reads, M) })
  clock += PS.RECHECK_MS
  s = await one(row(M, { outputAt: clock - 4_000 }))
  check('tracker: a turn nobody saw working is caught by the re-read', s.state === 'asking' && s.ask === 'Mapped. Want a desktop shortcut for it?' && count(reads, M) === 2, { s, reads: count(reads, M) })
  clock += PS.RECHECK_MS
  s = await one(row(M, { outputAt: clock - PS.RECHECK_MS - 4_000 }))
  check('tracker: nothing printed since: no read', count(reads, M) === 2 && s.state === 'asking', { s, reads: count(reads, M) })

  // a dozen and more panes at once: captured in parallel
  const many = Array.from({ length: 15 }, (_, i) => `vk-e2e00000${(0xd0 + i).toString(16)}`)
  for (const n of many) screens.set(n, { delay: 300, screen: BUSY_SCREEN })
  t0 = Date.now()
  const rows = await tracker.annotate(many.map((n) => row(n)))
  took = Date.now() - t0
  check('tracker: 15 working panes, 300 ms per capture, answered in parallel', took < 900 && rows.every((r) => r.state === 'working'), { took, states: rows.map((r) => r.state) })
  check('tracker: one capture per pane', many.every((n) => count(captures, n) === 1))
  check('tracker: the order is kept', rows.map((r) => r.name).join() === many.join())
}

// ---------------------------------------------- 3. the route, end to end ---

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-smoke-'))
const FAKE = path.join(T, 'fake')
const BIN = path.join(T, 'bin')
const SOCK_DIR = path.join(T, 'tmux', `tmux-${process.getuid?.() ?? 0}`)
for (const d of [FAKE, BIN, SOCK_DIR]) fs.mkdirSync(d, { recursive: true })
// serverUp() only asks whether the socket path exists
fs.writeFileSync(path.join(SOCK_DIR, 'desk-smoke'), '')
fs.writeFileSync(path.join(BIN, 'tmux'), [
  '#!/bin/sh',
  `D='${FAKE}'`,
  'while [ "$1" = "-L" ] || [ "$1" = "-f" ]; do shift 2; done',
  'cmd="$1"; shift',
  'name=""; prev=""; last=""',
  'for a in "$@"; do',
  '  if [ "$prev" = "-t" ]; then name="$a"; fi',
  '  prev="$a"; last="$a"',
  'done',
  'case "$cmd" in',
  '  list-sessions) cat "$D/list.txt" ;;',
  '  capture-pane)',
  '    echo "$name" >> "$D/captures.log"',
  // exec: the timeout's kill then hits the sleep itself, not a shell whose child keeps the pipe open
  '    if [ -f "$D/slow-$name" ]; then exec sleep 4; fi',
  '    if [ -f "$D/screen-$name.txt" ]; then cat "$D/screen-$name.txt"; else exit 1; fi ;;',
  '  display-message)',
  '    case "$last" in',
  '      *vk_host*) if [ -f "$D/facts-$name.txt" ]; then cat "$D/facts-$name.txt"; else exit 1; fi ;;',
  '      *) exit 1 ;;',
  '    esac ;;',
  '  *) echo "$cmd $*" >> "$D/other.log"; exit 1 ;;',
  'esac',
  '',
].join('\n'), { mode: 0o755 })
fs.writeFileSync(path.join(BIN, 'systemctl'), `#!/bin/sh\necho "systemctl $*" >> '${FAKE}/other.log'\nexit 1\n`, { mode: 0o755 })

// thor's file service: transcripts by conversation id
const transcripts = new Map<string, string>()
const fileReads: string[] = []
let filesDown = false
const files = express()
files.get('/transcript', (q, r) => {
  if (q.header('authorization') !== 'Bearer files-token') return r.status(401).json({ error: 'bad token' })
  const sid = String(q.query.sid ?? '')
  fileReads.push(sid)
  if (filesDown) return r.status(503).json({ error: 'down' })
  const text = transcripts.get(sid)
  if (q.query.todos === '1') return r.json({ todos: true, sessionId: sid, text: '', capped: false })
  if (text === undefined) return r.json({ sessionId: null, file: null, size: 0, start: 0, end: 0, text: '', capped: false, tail: true })
  const end = Buffer.byteLength(text)
  r.json({ sessionId: sid, file: `C:/Users/x/.claude/projects/demo/${sid}.jsonl`, size: end, start: 0, end, text, capped: false, tail: true })
})
// thor's launcher: the board
let boardRows: Record<string, unknown>[] = []
let launcherCalls = 0
let launcherDown = false
const launcher = express()
launcher.get('/sessions', (q, r) => {
  launcherCalls += 1
  if (q.header('authorization') !== 'Bearer desk-token') return r.status(401).json({ error: 'bad token' })
  if (launcherDown) return r.status(503).json({ error: 'down' })
  r.json({ version: 1, sessions: boardRows })
})
const listen = async (app: express.Express) => {
  const srv = app.listen(0, '127.0.0.1')
  await new Promise((r) => srv.once('listening', r))
  return { srv, port: (srv.address() as { port: number }).port }
}
const filesSrv = await listen(files)
const launcherSrv = await listen(launcher)

Object.assign(process.env, {
  VALKYRIE_TMUX_BIN: path.join(BIN, 'tmux'),
  VALKYRIE_TMUX_SOCKET: 'desk-smoke',
  VALKYRIE_TMUX_CONF: path.join(T, 'no-tmux.conf'),
  TMUX_TMPDIR: path.join(T, 'tmux'),
  VALKYRIE_SSH_BIN: path.join(T, 'no-ssh'),
  THOR_LAUNCHER_HOST: '127.0.0.1',
  THOR_LAUNCHER_PORT: String(launcherSrv.port),
  THOR_LAUNCHER_TOKEN: 'desk-token',
  PROJECT_FILES_URL: `http://127.0.0.1:${filesSrv.port}`,
  PROJECT_FILES_TOKEN: 'files-token',
  PROJECT_AREAS_FILE: path.join(T, 'no-areas.json'),
  LILKUPS_BIN: process.env.LILKUPS_BIN || '/bin/true',
  LILKUPS_STORE: path.join(T, 'no-reminders.json'),
  PATH: `${BIN}:${process.env.PATH ?? '/usr/bin:/bin'}`,
})
delete process.env.LAUNCHER_HOSTS

// imported only now: tmux.ts, transcriptFeed.ts and hostLaunch.ts read their env at import
const terminalRoute = (await import('../src/routes/terminal.ts')).default
const hostLaunchRoute = (await import('../src/routes/hostLaunch.ts')).default
const app = express()
app.use(express.json())
app.use('/api', terminalRoute)
app.use('/api', hostLaunchRoute)
const apiSrv = await listen(app)
const API = `http://127.0.0.1:${apiSrv.port}/api`

const SEP = '\u001f'
const sid = (n: number) => `0d5e0000-0000-4000-8000-${String(n).padStart(12, '0')}`
type Pane = { name: string; sid: string; mode?: string; dead?: boolean; project?: string; title: string; out: number; cmd?: string; label?: string }
const nowS = () => Math.floor(Date.now() / 1000)
function writePanes(panes: Pane[], extra = ''): void {
  const created = nowS() - 7_200
  const lines = panes.map((p) => [
    p.name, created, created + 60, 0, p.label ?? `label ${p.name.slice(-2)}`, 'thor', p.mode ?? 'new', p.mode === 'shell' ? 'personal' : 'work', p.mode === 'shell' ? '' : p.sid,
    p.dead ? 1 : 0, '120x40', p.dead ? 255 : '', p.project ?? '', p.out, 'odin', 'odin', p.cmd ?? 'ssh', p.title,
  ].join(SEP))
  fs.writeFileSync(path.join(FAKE, 'list.txt'), lines.join('\n') + '\n' + extra)
  for (const p of panes) fs.writeFileSync(path.join(FAKE, `facts-${p.name}.txt`), `${p.name}|thor|${p.mode ?? 'new'}|${p.mode === 'shell' ? '' : p.sid}|4242|${p.dead ? 1 : 0}\n`)
}
const screen = (name: string, text: string) => fs.writeFileSync(path.join(FAKE, `screen-${name}.txt`), text)
let u = 0
function jsonl(sessionId: string, items: ['user' | 'assistant', string][]): string {
  let parent: string | null = null
  const out: string[] = []
  for (const [role, text] of items) {
    const uuid = `0d5e0000-0000-4000-9000-${String(++u).padStart(12, '0')}`
    const timestamp = new Date(Date.now() - 60_000 + u * 100).toISOString()
    const base = { parentUuid: parent, isSidechain: false, userType: 'external', cwd: '/srv/demo', sessionId, version: '2.1.303', type: role, uuid, timestamp }
    out.push(JSON.stringify(role === 'user'
      ? { ...base, message: { role: 'user', content: text } }
      : { ...base, message: { model: 'claude-test-1', id: `msg_${u}`, type: 'message', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000, output_tokens: 20 } } }))
    parent = uuid
  }
  return out.join('\n') + '\n'
}
const captured = () => { try { return fs.readFileSync(path.join(FAKE, 'captures.log'), 'utf8').split('\n').filter(Boolean) } catch { return [] } }
type Row = TermSession & { state: string; ask: string; stateSince: number }
async function list(q = ''): Promise<{ rows: Row[]; took: number; status: number }> {
  const t0 = Date.now()
  const r = await fetch(`${API}/terminal/sessions${q}`)
  const rows = await r.json() as Row[]
  return { rows, took: Date.now() - t0, status: r.status }
}
const byName = (rows: Row[]) => new Map(rows.map((r) => [r.name, r]))

const P1 = 'vk-e2e00000a1', P2 = 'vk-e2e00000a2', P3 = 'vk-e2e00000a3', P4 = 'vk-e2e00000a4', P5 = 'vk-e2e00000a5', P6 = 'vk-e2e00000a6'
const panes: Pane[] = [
  { name: P1, sid: sid(1), title: '\u2810 Fix printer queue', out: nowS() },
  { name: P2, sid: sid(2), title: '\u2733 Router upgrade', out: nowS() - 3_600 },
  { name: P3, sid: sid(3), title: 'odin', out: nowS() - 3_600 },
  { name: P4, sid: '', mode: 'shell', title: 'brendon@odin: ~', out: nowS() - 3_600, cmd: 'bash' },
  { name: P5, sid: sid(5), dead: true, title: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', out: nowS() - 3_600 },
  { name: P6, sid: sid(6), title: 'ssh', out: nowS() - 3_600, project: 'garage' },
]
// a session on the same socket that the API never minted: never listed
writePanes(panes, ['other', 1, 1, 0, 'x', 'thor', 'new', 'work', sid(9), 0, '80x24', '', '', 1, 'odin', 'odin', 'bash', 'x'].join(SEP) + '\n')
screen(P1, BUSY_SCREEN)
for (const p of [P2, P3, P6]) screen(p, BUSY_SCREEN) // quiet for an hour: the busy line on them is stale
screen(P5, 'ssh: connect to host thor port 22: Connection timed out\nPane is dead (status 255)\n')
transcripts.set(sid(2), jsonl(sid(2), [['user', 'upgrade the router'], ['assistant', 'The firmware is staged.\n\nShould I reboot it now?']]))
transcripts.set(sid(3), jsonl(sid(3), [['user', 'check the router'], ['assistant', 'Checking the logs.']]))
transcripts.set(sid(6), jsonl(sid(6), [['user', 'map the share'], ['assistant', 'Done.\n\nNext: sign out and back in on the front desk PC.']]))
boardRows = [{ sessionId: sid(3), activity: 'asking', live: true, title: 'router', area: 'work', lastActivityUtc: new Date().toISOString() }]

{
  let r = await list()
  const m = byName(r.rows)
  check('route: 200 and only the API\'s own panes', r.status === 200 && r.rows.length === 6 && !m.has('other'), r.rows.map((x) => x.name))
  const keys = ['name', 'label', 'mode', 'host', 'target', 'sessionId', 'createdAt', 'activityAt', 'clients', 'dead', 'deadStatus', 'deadText', 'size', 'projectId']
  check('route: every old field is kept', r.rows.every((x) => keys.every((k) => k in x)), r.rows[0])
  check('route: state, ask, stateSince, title and outputAt on every row', r.rows.every((x) => typeof x.state === 'string' && typeof x.ask === 'string' && typeof x.stateSince === 'number' && typeof x.title === 'string' && typeof x.outputAt === 'number'), r.rows[0])
  check('route: title from #{pane_title}, glyph off', m.get(P1)?.title === 'Fix printer queue' && m.get(P2)?.title === 'Router upgrade', [m.get(P1)?.title, m.get(P2)?.title])
  check('route: default titles are empty (host, shell prompt, exe path, pane command)', [P3, P4, P5, P6].every((n) => m.get(n)?.title === ''), [P3, P4, P5, P6].map((n) => m.get(n)?.title))
  check('route: outputAt is #{window_activity} in ms, activityAt stays #{session_activity}', m.get(P1)?.outputAt === panes[0].out * 1000 && m.get(P1)!.activityAt !== m.get(P1)!.outputAt, m.get(P1))
  check('route: P1 working', m.get(P1)?.state === 'working', m.get(P1))
  check('route: P2 asking with its question', m.get(P2)?.state === 'asking' && m.get(P2)?.ask === 'Should I reboot it now?', m.get(P2))
  check('route: P4 shell, P5 dead (with its last lines)', m.get(P4)?.state === 'shell' && m.get(P5)?.state === 'dead' && /Connection timed out/.test(m.get(P5)!.deadText), [m.get(P4), m.get(P5)])
  check('route: P6 asking with its Next: line', m.get(P6)?.state === 'asking' && m.get(P6)?.ask === 'Next: sign out and back in on the front desk PC.', m.get(P6))
  check('route: P3 idle before any board read landed (the list never waits on thor)', m.get(P3)?.state === 'idle', m.get(P3))
  const caps = captured()
  check('route: only the pane that printed lately was captured (and the dead pane\'s last lines)', caps.filter((n) => n === P1).length === 1 && ![P2, P3, P4, P6].some((n) => caps.includes(n)), caps)
  check('route: each Claude pane\'s transcript read once', [sid(1), sid(2), sid(3), sid(6)].every((s) => fileReads.filter((x) => x === s).length === (s === sid(1) ? 0 : 1)), fileReads)

  await sleep(300)
  r = await list()
  const m2 = byName(r.rows)
  check('route: the board read landed: P3 asking with the board line', m2.get(P3)?.state === 'asking' && m2.get(P3)?.ask === PS.BOARD_ASK, m2.get(P3))
  check('route: the first list started one board read in the background, the second none; no transcript read again', launcherCalls === 1 && fileReads.length === 3, { launcherCalls, fileReads })
  check('route: stateSince kept for an unchanged pane', m2.get(P2)?.stateSince === m.get(P2)?.stateSince, [m.get(P2)?.stateSince, m2.get(P2)?.stateSince])

  // the Sessions screens' own poll refreshes the same copy: the list reads nothing more from thor
  boardRows = []
  const board = await fetch(`${API}/session-board`)
  check('route: GET /session-board answers', board.status === 200 && launcherCalls === 2, { status: board.status, launcherCalls })
  r = await list()
  check('route: the copy /session-board refreshed is what the list reads: P3 idle now, no read of its own', byName(r.rows).get(P3)?.state === 'idle' && launcherCalls === 2, { p3: byName(r.rows).get(P3), launcherCalls })

  // the turn ends on P1
  await sleep(1_600)
  screen(P1, IDLE_SCREEN)
  transcripts.set(sid(1), jsonl(sid(1), [['user', 'fix the printer queue'], ['assistant', 'Cleared the queue. Want me to print a test page?']]))
  r = await list()
  const p1 = byName(r.rows).get(P1)
  check('route: P1 done with a question: asking, read once', p1?.state === 'asking' && p1.ask === 'Cleared the queue. Want me to print a test page?' && fileReads.filter((x) => x === sid(1)).length === 1, { p1, fileReads })
  await sleep(300)
  check('route: a turn end asks thor for a newer board at once, not 20 s later', launcherCalls === 3, launcherCalls)
  r = await list()
  await sleep(300)
  check('route: and only once for that turn end', launcherCalls === 3, launcherCalls)

  // project filter and a Cloudflare caller
  r = await list('?project=garage')
  check('route: ?project= picks that project\'s panes, with their state', r.rows.length === 1 && r.rows[0].name === P6 && r.rows[0].state === 'asking', r.rows)
  check('route: a bad project id is 400', (await list('?project=Bad!')).status === 400)
  type Handler = (req: unknown, res: unknown, next: (e?: unknown) => void) => unknown
  const layer = (terminalRoute as unknown as { stack: { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Handler }[] } }[] }).stack
    .find((l) => l.route?.path === '/terminal/sessions' && l.route.methods.get)
  let body: Row[] = []
  const res = { statusCode: 200, status(n: number) { this.statusCode = n; return this }, json(b: unknown) { body = b as Row[]; return this } }
  await layer!.route!.stack[layer!.route!.stack.length - 1].handle({ method: 'GET', query: {}, params: {}, headers: { 'cf-ray': 'smoke' }, socket: { remoteAddress: '127.0.0.1' } }, res, () => {})
  const hidden = body.find((x) => x.name === P6)
  check('route: through Cloudflare, a project the caller may not see loses its label, title and follow-up line', !!hidden && hidden.projectId === '' && hidden.label === 'work' && hidden.title === '' && hidden.ask === '' && hidden.state === 'asking', hidden)
  check('route: through Cloudflare, other panes keep theirs', body.find((x) => x.name === P2)?.ask === 'Should I reboot it now?', body.find((x) => x.name === P2))

  // thor down: a new pane whose transcript cannot be read is idle, and the list does not wait
  filesDown = true
  launcherDown = true
  const P7 = 'vk-e2e00000a7'
  panes.push({ name: P7, sid: sid(7), title: '\u2733 Backup check', out: nowS() - 3_600 })
  writePanes(panes)
  r = await list()
  check('route: thor down: a new pane is idle', byName(r.rows).get(P7)?.state === 'idle' && byName(r.rows).get(P7)?.title === 'Backup check', byName(r.rows).get(P7))
  check('route: thor down: the list still answers fast', r.took < 1_500, r.took)

  // a capture that hangs: the list answers in about a second with what it knew
  filesDown = false
  launcherDown = false
  panes[0].out = nowS()
  writePanes(panes)
  screen(P1, BUSY_SCREEN)
  fs.writeFileSync(path.join(FAKE, `slow-${P1}`), '')
  await sleep(1_600)
  r = await list()
  check('route: a hanging capture holds the list about a second', r.took < 1_800 && r.took >= PS.CAPTURE_WAIT_MS - 50, r.took)
  check('route: and the pane keeps its last known state', byName(r.rows).get(P1)?.state === 'asking', byName(r.rows).get(P1))
  fs.rmSync(path.join(FAKE, `slow-${P1}`))

  // 15 panes, all printing: one list stays fast
  const many: Pane[] = Array.from({ length: 15 }, (_, i) => ({ name: `vk-e2e00000${(0xd0 + i).toString(16)}`, sid: sid(100 + i), title: `\u2810 Task ${i}`, out: nowS() }))
  writePanes(many)
  for (const p of many) {
    screen(p.name, i2(p.name) % 2 ? BUSY_SCREEN : IDLE_SCREEN)
    transcripts.set(p.sid, jsonl(p.sid, [['user', 'go'], ['assistant', i2(p.name) % 4 === 0 ? 'Done. Ship it?' : 'Done.']]))
  }
  r = await list()
  const st = r.rows.map((x) => x.state)
  check('route: 15 panes in one list, captured and read in parallel', r.rows.length === 15 && r.took < 1_500, { took: r.took, n: r.rows.length })
  check('route: 15 panes: working, asking and idle as their screens and replies say', r.rows.every((x) => x.state === (i2(x.name) % 2 ? 'working' : i2(x.name) % 4 === 0 ? 'asking' : 'idle')), st)
  const other = fs.existsSync(path.join(FAKE, 'other.log')) ? fs.readFileSync(path.join(FAKE, 'other.log'), 'utf8') : ''
  check('route: no tmux command but list, capture and display-message ran (nothing started, typed or killed)', other === '', other)
}
function i2(name: string): number { return parseInt(name.slice(-2), 16) }

// ------------------------------------------------------------------ done ---

await new Promise((r) => apiSrv.srv.close(r))
filesSrv.srv.close()
launcherSrv.srv.close()
fs.rmSync(T, { recursive: true, force: true })
console.log(`deskSmoke: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
