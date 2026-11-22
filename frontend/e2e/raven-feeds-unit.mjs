// Unit tests for src/v2/kit/ravenFeeds.ts: the feeds in the Raven tab's Connected list. Each feed's newest line out
// of the thread (a cleared newest line leaves its feed out, an older line never takes its place, the count as it
// stands over the old one), an agent's own feed going under its row (the agent's name once, not again under Feeds), and the
// line a live notice shows in the thread (cleared, or the count now). Bundles the module with rolldown so it runs
// in plain node.
//
//   node e2e/raven-feeds-unit.mjs        (from frontend/)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rolldown } from 'rolldown'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const bundle = await rolldown({ input: resolve(HERE, '../src/v2/kit/ravenFeeds.ts'), platform: 'node', logLevel: 'silent' })
const { output } = await bundle.generate({ format: 'esm' })
await bundle.close()
const dir = mkdtempSync(join(tmpdir(), 'raven-feeds-unit-'))
const file = join(dir, 'ravenFeeds.mjs')
writeFileSync(file, output[0].code)
const F = await import(pathToFileURL(file).href)
process.on('exit', () => rmSync(dir, { recursive: true, force: true }))

let next = 1
const msg = (text, relay, at = `2026-11-22T13:0${next}:00.000Z`) => ({ id: next++, author: 'raven', text, createdAt: at, refs: [], meta: relay ? { relay } : {}, proposal: null })
const feed = (from, label, text, at = '2026-11-22T13:08:13.379Z', id = 1) => ({ from, label, text, at, id })
const AGENTS = [{ id: 'triage', name: 'Triage' }, { id: 'groceries', name: 'Groceries' }, { id: 'watchdog', name: 'Watchdog' }]

test('feedsFromThread: the newest line of each feed, newest first, first line only, markdown marks dropped', () => {
  next = 1
  const thread = [
    msg('Backup is done', { kind: 'feature', from: 'backup', label: 'Backup' }),
    msg('**9 items** waiting for your review\n\nShop 9.', { kind: 'feature', from: 'watchdog', label: 'Watchdog' }),
    msg('a plain reply'),
    msg('Morning brief', { kind: 'system', from: 'brief', label: 'Morning brief' }),
  ]
  const out = F.feedsFromThread(thread)
  assert.deepEqual(out.map((f) => `${f.from}:${f.text}`), ['watchdog:9 items waiting for your review', 'backup:Backup is done'])
  assert.equal(out[0].id, 2)
})

test('feedsFromThread: a cleared newest line leaves its feed out; the older line does not show instead', () => {
  next = 1
  const thread = [
    msg('1 item waiting for your review', { kind: 'feature', from: 'watchdog', label: 'Watchdog' }),
    msg('9 items waiting for your review', { kind: 'feature', from: 'watchdog', label: 'Watchdog', live: 'review', cleared: { at: '2026-11-22T19:00:00Z', note: 'All reviewed' } }),
    msg('Backup is done', { kind: 'feature', from: 'backup', label: 'Backup' }),
  ]
  assert.deepEqual(F.feedsFromThread(thread).map((f) => f.from), ['backup'])
})

test('feedsFromThread: the count as it stands shows over the old one', () => {
  next = 1
  const thread = [msg('9 items waiting for your review', { kind: 'feature', from: 'watchdog', label: 'Watchdog', live: 'review', now: '4 items waiting for your review' })]
  assert.equal(F.feedsFromThread(thread)[0].text, '4 items waiting for your review')
})

test('splitFeeds: the Watchdog feed goes under the Watchdog agent, not under Feeds', () => {
  const dog = feed('watchdog', 'Watchdog', '9 items waiting for your review')
  const backup = feed('backup', 'Backup', 'Backup is done', '2026-11-22T12:00:00.000Z', 2)
  const { byAgent, rest } = F.splitFeeds([dog, backup], AGENTS)
  assert.equal(byAgent.get('watchdog'), dog)
  assert.deepEqual(rest, [backup])
  assert.equal(byAgent.size, 1)
})

test('splitFeeds: matched by the agent name when the source key differs (case and spaces ignored)', () => {
  const f = feed('watchdog-2', ' watchdog ', 'Line two down')
  const { byAgent, rest } = F.splitFeeds([f], AGENTS)
  assert.equal(byAgent.get('watchdog'), f)
  assert.equal(rest.length, 0)
})

test('splitFeeds: with no such agent listed, the feed stays under Feeds', () => {
  const f = feed('watchdog', 'Watchdog', 'x')
  const { byAgent, rest } = F.splitFeeds([f], AGENTS.filter((a) => a.id !== 'watchdog'))
  assert.equal(byAgent.size, 0)
  assert.deepEqual(rest, [f])
})

test('splitFeeds: two feeds for one agent keep the newer line', () => {
  const older = feed('watchdog', 'Watchdog', 'older', '2026-11-22T10:00:00.000Z', 1)
  const newer = feed('watchdog-2', 'Watchdog', 'newer', '2026-11-22T11:00:00.000Z', 2)
  assert.equal(F.splitFeeds([older, newer], AGENTS).byAgent.get('watchdog').text, 'newer')
  assert.equal(F.splitFeeds([newer, older], AGENTS).byAgent.get('watchdog').text, 'newer')
})

test('splitFeeds: nothing in, nothing out', () => {
  const { byAgent, rest } = F.splitFeeds([], AGENTS)
  assert.equal(byAgent.size, 0)
  assert.deepEqual(rest, [])
})

test('liveLine: cleared with a note, cleared without, the count now, and a plain line', () => {
  const t = (iso) => iso.slice(11, 16)
  assert.equal(F.liveLine({ kind: 'feature', from: 'watchdog', label: 'Watchdog', cleared: { at: '2026-11-22T19:31:00Z', note: 'All reviewed' } }, t), 'Cleared 19:31 · All reviewed')
  assert.equal(F.liveLine({ kind: 'feature', from: 'watchdog', label: 'Watchdog', cleared: { at: '2026-11-22T19:31:00Z' } }, t), 'Cleared 19:31')
  assert.equal(F.liveLine({ kind: 'feature', from: 'watchdog', label: 'Watchdog', now: '4 items waiting for your review' }, t), 'Now: 4 items waiting for your review')
  assert.equal(F.liveLine({ kind: 'feature', from: 'watchdog', label: 'Watchdog', now: 'x', cleared: { at: '2026-11-22T19:31:00Z' } }, t), 'Cleared 19:31')
  assert.equal(F.liveLine({ kind: 'feature', from: 'backup', label: 'Backup' }, t), null)
  assert.equal(F.liveLine(undefined, t), null)
})
