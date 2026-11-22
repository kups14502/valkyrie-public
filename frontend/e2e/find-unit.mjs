// Unit tests for src/v2/kit/findCore.ts: the find bar's arithmetic (Ctrl+F, kit/find.tsx). Where a query sits in a
// run of text (case-insensitive, never overlapping, regex characters as plain text), stepping with wrap-around, the
// match a new search starts on (the first in view, or the Raven thread's newest one above the bottom), the Raven
// count over drawn matches plus older lines not loaded yet, which older line Shift+Enter loads to, and the word
// under the pointer the context menu offers to find. Bundles the module with rolldown so it runs in plain node.
//
//   node e2e/find-unit.mjs        (from frontend/)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rolldown } from 'rolldown'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const bundle = await rolldown({ input: resolve(HERE, '../src/v2/kit/findCore.ts'), platform: 'node', logLevel: 'silent' })
const { output } = await bundle.generate({ format: 'esm' })
await bundle.close()
const dir = mkdtempSync(join(tmpdir(), 'find-unit-'))
const file = join(dir, 'findCore.mjs')
writeFileSync(file, output[0].code)
const F = await import(pathToFileURL(file).href)
process.on('exit', () => rmSync(dir, { recursive: true, force: true }))

test('matchOffsets: case-insensitive, every match, no overlap', () => {
  assert.deepEqual(F.matchOffsets('Plex is up. PLEX answered; plex.', 'plex'), [0, 12, 27])
  assert.deepEqual(F.matchOffsets('aaaa', 'aa'), [0, 2])
  assert.deepEqual(F.matchOffsets('nothing here', 'plex'), [])
})

test('matchOffsets: an empty query or text finds nothing', () => {
  assert.deepEqual(F.matchOffsets('text', ''), [])
  assert.deepEqual(F.matchOffsets('', 'q'), [])
})

test('matchOffsets: regex characters are plain text', () => {
  assert.deepEqual(F.matchOffsets('cost (est.) $5.00 or $5x00', '$5.00'), [12])
  assert.deepEqual(F.matchOffsets('a+b a+b ab', 'a+b'), [0, 4])
  assert.deepEqual(F.matchOffsets('[x] * done', '[x] *'), [0])
  assert.deepEqual(F.matchOffsets(String.raw`C:\Thor\server`, String.raw`\thor\ `.trim()), [2])
})

test('stepIndex: forward and back with wrap-around', () => {
  assert.equal(F.stepIndex(0, 3, 1), 1)
  assert.equal(F.stepIndex(2, 3, 1), 0)
  assert.equal(F.stepIndex(0, 3, -1), 2)
  assert.equal(F.stepIndex(-1, 3, 1), 0)
  assert.equal(F.stepIndex(-1, 3, -1), 2)
  assert.equal(F.stepIndex(0, 0, 1), -1)
})

test('startIndex: the first match in view, from the top', () => {
  assert.equal(F.startIndex([-300, -10, 40, 500], 600), 2)
  assert.equal(F.startIndex([-300, -10], 600), 1)
  assert.equal(F.startIndex([], 600), -1)
})

test('startIndex: from the end, the newest match above the bottom (the Raven thread)', () => {
  assert.equal(F.startIndex([-300, 100, 550, 900], 600, true), 2)
  assert.equal(F.startIndex([700, 900], 600, true), 0)
  assert.equal(F.startIndex([10], 600, true), 0)
})

test('threadCount: older lines not loaded count before the drawn matches', () => {
  const hits = [{ id: 3, n: 2 }, { id: 9, n: 1 }, { id: 40, n: 1 }, { id: 41, n: 3 }]
  // lines 40 and up are drawn (4 matches on screen); 3 and 9 are not loaded: 3 matches above
  assert.deepEqual(F.threadCount(hits, 40, 4, 0), { total: 7, pos: 4, above: 3 })
  assert.deepEqual(F.threadCount(hits, 40, 4, 3), { total: 7, pos: 7, above: 3 })
  assert.deepEqual(F.threadCount(hits, 40, 4, -1), { total: 7, pos: 0, above: 3 })
  // everything loaded
  assert.deepEqual(F.threadCount(hits, 1, 7, 2), { total: 7, pos: 3, above: 0 })
  // nothing drawn holds it, two lines above do
  assert.deepEqual(F.threadCount(hits.slice(0, 2), 40, 0, -1), { total: 3, pos: 0, above: 3 })
})

test('nextOlderHit and oldestHit: where Shift+Enter and the wrap load to', () => {
  const hits = [{ id: 3, n: 2 }, { id: 9, n: 1 }, { id: 40, n: 1 }]
  assert.equal(F.nextOlderHit(hits, 40), 9)
  assert.equal(F.nextOlderHit(hits, 9), 3)
  assert.equal(F.nextOlderHit(hits, 3), null)
  assert.equal(F.oldestHit(hits), 3)
  assert.equal(F.oldestHit([]), null)
})

test('wordAt: the word under the pointer, without trailing punctuation', () => {
  assert.equal(F.wordAt('Restart valkyrie-api now.', 10), 'valkyrie-api')
  assert.equal(F.wordAt('see backend/src/routes/raven.ts.', 12), 'backend/src/routes/raven.ts')
  assert.equal(F.wordAt('mail bkupsch@example.com today', 9), 'bkupsch@example.com')
  assert.equal(F.wordAt('two  spaces', 2), 'two')
  // on the space between two words: none
  assert.equal(F.wordAt('two  spaces', 4), '')
  assert.equal(F.wordAt('', 0), '')
  assert.equal(F.wordAt('Привет мир', 2), 'Привет')
})
