// Unit tests for src/v2/kit/thisDevice.ts: which device the Dashboard's
// "This device" box draws. The desktop app's machine name wins when it is a
// known machine; otherwise the device profile decides. Bundles the module with
// rolldown so it runs in plain node; no page, no backend.
//
//   node e2e/device-unit.mjs        (from frontend/)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rolldown } from 'rolldown'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const bundle = await rolldown({ input: resolve(HERE, '../src/v2/kit/thisDevice.ts'), platform: 'node', logLevel: 'silent' })
const { output } = await bundle.generate({ format: 'esm' })
await bundle.close()
const dir = mkdtempSync(join(tmpdir(), 'device-unit-'))
const file = join(dir, 'thisDevice.mjs')
writeFileSync(file, output[0].code)
const { thisDeviceId } = await import(pathToFileURL(file).href)
process.on('exit', () => rmSync(dir, { recursive: true, force: true }))

test('the desktop app on a known machine is that machine, whatever the profile says', () => {
  for (const mode of ['desktop', 'auto', 'iphone', 'ipad', 'vr']) {
    assert.equal(thisDeviceId('thor', mode), 'thor')
    assert.equal(thisDeviceId('mimir', mode), 'mimir')
    assert.equal(thisDeviceId('odin', mode), 'odin')
  }
})

test('the machine name is matched on its first label, any case, trimmed', () => {
  assert.equal(thisDeviceId('MIMIR', 'desktop'), 'mimir')
  assert.equal(thisDeviceId('Thor', 'desktop'), 'thor')
  assert.equal(thisDeviceId('  odin\n', 'desktop'), 'odin')
  assert.equal(thisDeviceId('mimir.local', 'desktop'), 'mimir')
  assert.equal(thisDeviceId('odin.example.lan', 'desktop'), 'odin')
})

test('outside the app the device profile decides', () => {
  assert.equal(thisDeviceId(null, 'iphone'), 'phone')
  assert.equal(thisDeviceId(null, 'ipad'), 'tablet')
  assert.equal(thisDeviceId(null, 'vr'), 'frame')
  assert.equal(thisDeviceId(null, 'desktop'), 'thor')
  assert.equal(thisDeviceId(undefined, 'iphone'), 'phone')
})

test('a desktop browser, or an unresolved profile, falls back to thor', () => {
  assert.equal(thisDeviceId(null, 'desktop'), 'thor')
  assert.equal(thisDeviceId(null, 'auto'), 'thor')
  assert.equal(thisDeviceId('', 'desktop'), 'thor')
})

test('an app name that is no known machine goes by the profile, never becomes a host id', () => {
  assert.equal(thisDeviceId('desktop-ab12cd', 'desktop'), 'thor')
  assert.equal(thisDeviceId('localhost', 'iphone'), 'phone')
  assert.equal(thisDeviceId('localhost', 'vr'), 'frame')
  // a model id the app never reports is not a machine name
  assert.equal(thisDeviceId('frame', 'desktop'), 'thor')
  assert.equal(thisDeviceId('phone', 'ipad'), 'tablet')
  assert.equal(thisDeviceId('thorn', 'desktop'), 'thor')
  assert.equal(thisDeviceId('xmimir', 'ipad'), 'tablet')
})
