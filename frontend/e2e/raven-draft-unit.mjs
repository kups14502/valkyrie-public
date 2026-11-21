// Unit tests for src/v2/kit/ravenDraft.ts: the unsent message to Raven, kept per thread in this device's
// localStorage. Text, dictated words and attached files survive a reload (a new store over the same storage, as
// the page makes after a reload or an app restart); only a send clears the draft, and only what it carried; an
// upload cut off by a reload comes back as a chip to attach again; another window's write is followed without
// echoing it. Bundles the module with rolldown so it runs in plain node; a fake storage and a fake upload, no page.
//
//   node e2e/raven-draft-unit.mjs        (from frontend/)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rolldown } from 'rolldown'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const bundle = await rolldown({ input: resolve(HERE, '../src/v2/kit/ravenDraft.ts'), platform: 'node', logLevel: 'silent' })
const { output } = await bundle.generate({ format: 'esm' })
await bundle.close()
const dir = mkdtempSync(join(tmpdir(), 'raven-draft-unit-'))
const file = join(dir, 'ravenDraft.mjs')
writeFileSync(file, output[0].code)
const D = await import(pathToFileURL(file).href)
process.on('exit', () => rmSync(dir, { recursive: true, force: true }))

const KEY = `${D.DRAFT_PREFIX}${D.RAVEN_THREAD}`
const tick = () => new Promise((r) => setTimeout(r, 0))

/** localStorage as a Map, counting the writes */
function fakeStorage() {
  const m = new Map()
  const s = {
    sets: 0,
    removes: 0,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { s.sets++; m.set(k, String(v)) },
    removeItem: (k) => { s.removes++; m.delete(k) },
    has: (k) => m.has(k),
    raw: (k) => m.get(k),
  }
  return s
}

/** uploads that wait until the test lands or fails them */
function fakeUploads() {
  const calls = []
  let n = 0
  const upload = (f, onProgress, signal) => new Promise((resolve, reject) => {
    const c = { name: f.name, onProgress, signal, land: () => resolve({ id: `u${++n}`, name: f.name, mime: f.type, size: f.size, createdAt: '2026-11-20T15:00:00.000Z' }), fail: (msg) => reject(new Error(msg)) }
    signal.addEventListener('abort', () => reject(new Error('aborted')))
    calls.push(c)
  })
  return { calls, upload }
}

const mk = (storage, up = fakeUploads()) => ({ up, store: D.createDraftStore({ storage, upload: up.upload, maxBytes: 50 * 1024 * 1024 }) })
const png = (name = 'photo.png') => new File([new Uint8Array(2048)], name, { type: 'image/png' })

test('typed text is kept on the device and comes back after a reload', () => {
  const ls = fakeStorage()
  const a = mk(ls).store
  a.setText('raven', 'Half a thought about the printer')
  assert.equal(JSON.parse(ls.raw(KEY)).text, 'Half a thought about the printer')
  // the page reloads (or the app restarts): a new store over the same storage
  const b = mk(ls).store
  assert.equal(b.get('raven').text, 'Half a thought about the printer')
})

test('each thread keeps its own draft, under its own key', () => {
  const ls = fakeStorage()
  const s = mk(ls).store
  s.setText('raven', 'to raven')
  s.setText('other', 'somewhere else')
  assert.equal(JSON.parse(ls.raw(KEY)).text, 'to raven')
  assert.equal(JSON.parse(ls.raw(`${D.DRAFT_PREFIX}other`)).text, 'somewhere else')
  assert.equal(mk(ls).store.get('raven').text, 'to raven')
})

test('clearing the box by hand removes the stored draft', () => {
  const ls = fakeStorage()
  const s = mk(ls).store
  s.setText('raven', 'x')
  s.setText('raven', '')
  assert.equal(ls.has(KEY), false)
})

test('dictated words join the end of the text with one space, and are kept the same way', () => {
  const ls = fakeStorage()
  const s = mk(ls).store
  s.append('raven', 'add oat milk')
  assert.equal(s.get('raven').text, 'add oat milk')
  s.setText('raven', 'Note:  ')
  s.append('raven', 'add oat milk')
  assert.equal(s.get('raven').text, 'Note: add oat milk')
  assert.equal(mk(ls).store.get('raven').text, 'Note: add oat milk')
})

test('an attached file that landed stays attached after a reload, by its stored id', async () => {
  const ls = fakeStorage()
  const { store: s, up } = mk(ls)
  s.add('raven', [png()])
  assert.equal(s.get('raven').files[0].state, 'up')
  up.calls[0].land()
  await tick()
  const f = s.get('raven').files[0]
  assert.equal(f.state, 'done')
  assert.equal(f.file.id, 'u1')
  const b = mk(ls).store
  const g = b.get('raven').files[0]
  assert.deepEqual([g.state, g.name, g.file.id, g.lost], ['done', 'photo.png', 'u1', undefined])
  assert.deepEqual(b.snapshot('raven').ids, ['u1'])
})

test('progress ticks never write the storage; the upload landing does', async () => {
  const ls = fakeStorage()
  const { store: s, up } = mk(ls)
  s.add('raven', [png()])
  const before = ls.sets
  for (let i = 1; i <= 20; i++) up.calls[0].onProgress(i * 100)
  assert.equal(ls.sets, before)
  assert.equal(s.get('raven').files[0].sent, 2000)
  up.calls[0].land()
  await tick()
  assert.equal(ls.sets, before + 1)
})

test('an upload a reload cut off comes back as a chip to attach again, with no Retry', () => {
  const ls = fakeStorage()
  mk(ls).store.add('raven', [png('big.mov')])
  const { store: b, up } = mk(ls)
  const f = b.get('raven').files[0]
  assert.deepEqual([f.state, f.error, f.lost], ['err', 'attach it again', true])
  b.retry('raven', f.key)
  assert.equal(up.calls.length, 0, 'a lost file has no bytes to send again')
  assert.deepEqual(b.snapshot('raven').ids, [])
  b.remove('raven', f.key)
  assert.equal(ls.has(KEY), false)
})

test('a failed upload in this session keeps its Retry', async () => {
  const ls = fakeStorage()
  const { store: s, up } = mk(ls)
  s.add('raven', [png()])
  up.calls[0].fail('502')
  await tick()
  const f = s.get('raven').files[0]
  assert.deepEqual([f.state, f.error, !!f.lost], ['err', '502', false])
  s.retry('raven', f.key)
  assert.equal(up.calls.length, 2)
  up.calls[1].land()
  await tick()
  assert.equal(s.get('raven').files[0].state, 'done')
})

test('only a send clears the draft, and only what it carried', async () => {
  const ls = fakeStorage()
  const { store: s, up } = mk(ls)
  s.setText('raven', 'Here is the photo')
  s.add('raven', [png()])
  up.calls[0].land()
  await tick()
  const snap = s.snapshot('raven')
  assert.deepEqual(snap, { text: 'Here is the photo', ids: ['u1'] })
  // while the send is on its way he keeps typing and attaches another file
  s.setText('raven', 'Here is the photo and one more thing')
  s.add('raven', [png('second.png')])
  s.markSent('raven', snap)
  const after = s.get('raven')
  assert.equal(after.text, 'and one more thing')
  assert.deepEqual(after.files.map((f) => f.name), ['second.png'])
  // a send with nothing typed since empties the draft and the storage
  up.calls[1].land()
  await tick()
  const snap2 = s.snapshot('raven')
  s.markSent('raven', snap2)
  assert.deepEqual(s.get('raven'), { text: '', files: [] })
  assert.equal(ls.has(KEY), false)
  assert.equal(mk(ls).store.get('raven').text, '')
})

test('text he changed (not only added to) while the send went stays whole', () => {
  const s = mk(fakeStorage()).store
  s.setText('raven', 'Call Pat')
  const snap = s.snapshot('raven')
  s.setText('raven', 'Call Sam')
  s.markSent('raven', snap)
  assert.equal(s.get('raven').text, 'Call Sam')
})

test('another window\'s write is followed: its text, this window\'s own uploads kept, nothing echoed back', async () => {
  const ls = fakeStorage()
  const { store: here, up } = mk(ls)
  here.setText('raven', 'from here')
  here.add('raven', [png('mine.png')])
  // the other window (a pop-out) types and writes
  const other = mk(ls).store
  other.setText('raven', 'from the pop-out')
  const sets = ls.sets
  here.adopt('raven', ls.raw(KEY))
  const s = here.get('raven')
  assert.equal(s.text, 'from the pop-out')
  assert.deepEqual(s.files.map((f) => `${f.name}:${f.state}`), ['mine.png:up'])
  assert.equal(ls.sets, sets, 'adopting wrote the storage')
  up.calls[0].land()
  await tick()
  assert.deepEqual(JSON.parse(ls.raw(KEY)).files.map((f) => `${f.name}:${f.state}`), ['mine.png:done'])
  // the storage cleared from elsewhere
  here.adopt(null, null)
  assert.deepEqual(here.get('raven'), { text: '', files: [] })
})

test('a broken stored draft reads as empty', () => {
  const ls = fakeStorage()
  ls.setItem(KEY, '{not json')
  assert.deepEqual(mk(ls).store.get('raven'), { text: '', files: [] })
  ls.setItem(KEY, JSON.stringify({ v: 1, text: 'ok', files: [{ nope: 1 }, { key: 'k', name: 'a.pdf', size: 3, mime: 'application/pdf', state: 'done', file: { id: 'f9', name: 'a.pdf', mime: 'application/pdf', size: 3, createdAt: '' } }] }))
  const s = mk(ls).store.get('raven')
  assert.equal(s.text, 'ok')
  assert.deepEqual(s.files.map((f) => f.file?.id), ['f9'])
})

test('no storage at all (private mode): the draft still works for the session', () => {
  const s = D.createDraftStore({ storage: null, upload: () => new Promise(() => {}), maxBytes: 10 })
  s.setText('raven', 'kept in memory')
  assert.equal(s.get('raven').text, 'kept in memory')
  const throwing = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('quota') }, removeItem: () => { throw new Error('denied') } }
  const t = D.createDraftStore({ storage: throwing, upload: () => new Promise(() => {}), maxBytes: 10 })
  t.setText('raven', 'still here')
  assert.equal(t.get('raven').text, 'still here')
})
