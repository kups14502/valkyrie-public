// UPLOAD: pictures and videos to thor from the Dashboard's Upload block and
// the AI > Sessions button (src/v2/kit/upload.tsx, kit/uploads.tsx). Files
// are picked through the real tap (the file chooser is intercepted and given
// files made here); every chunk POST /api/hosts/thor/upload is answered in the
// browser like thor's agent would, so nothing is ever sent to thor.

import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { sleep } from '../lib/cdp.mjs'

const CHUNK = 8 * 1024 * 1024
const REFUSED = 'e2e refused this upload'

// ---------- files to pick ----------

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
/** A real PNG: a diagonal two-color gradient, so the thumbnail has something to show. */
function png(w, h, [r1, g1, b1], [r2, g2, b2]) {
  const rows = []
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3)
    for (let x = 0; x < w; x++) {
      const t = (x + y) / (w + h)
      row[1 + x * 3] = Math.round(r1 + (r2 - r1) * t)
      row[2 + x * 3] = Math.round(g1 + (g2 - g1) * t)
      row[3 + x * 3] = Math.round(b1 + (b2 - b1) * t)
    }
    rows.push(row)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

let made = null
export function fixtures() {
  if (made) return made
  const dir = join(tmpdir(), 'valkyrie-e2e-upload')
  mkdirSync(dir, { recursive: true })
  const f = (name, buf) => { const p = join(dir, name); writeFileSync(p, buf); return p }
  made = {
    sunset: f('sunset.png', png(240, 160, [255, 120, 40], [60, 0, 120])),
    sea: f('sea.png', png(160, 240, [0, 200, 255], [0, 40, 80])),
    // a video this browser cannot draw: the row keeps the film icon. Kept under one 8 MB chunk: an
    // 8 MB request body stalls CDP Fetch interception in headless Edge (the chunk loop is lib/upload.ts).
    clip: f('clip.mov', Buffer.alloc(300 * 1024, 7)),
    doc: f('notes.pdf', Buffer.from('%PDF-1.4 e2e\n')),
  }
  return made
}

// ---------- the fake agent ----------

/**
 * Answers each chunk the way thor's agent does (Receive-UploadChunk): the
 * count it holds, then the saved name and path on the last one.
 * mode(): 'ok' | 'refuse' (403, never retried). A name in `flaky` gets one
 * 502 first (odin could not reach thor), which the chunk loop retries.
 */
export function agent(page, mode, log, flaky = new Set()) {
  const got = new Map()
  page.onWrite(async (w) => {
    if (w.method !== 'POST' || w.path !== '/api/hosts/thor/upload') return undefined
    const q = Object.fromEntries(new URL(w.url).searchParams)
    const offset = Number(q.offset)
    const total = Number(q.total)
    log.push({ ...q, offset, total })
    await sleep(220)
    if (mode() === 'refuse') return { status: 403, body: { error: REFUSED } }
    if (flaky.delete(q.name)) return { status: 502, body: { error: 'thor is not answering' } }
    const have = got.get(q.id) ?? 0
    if (offset !== have) return { status: 409, body: { error: 'offset does not match what thor has', received: have } }
    const received = Math.min(total, offset + CHUNK)
    got.set(q.id, received)
    if (received < total) return { status: 200, body: { done: false, received } }
    const saved = `20261018-141500-${q.name}`
    return { status: 200, body: { done: true, received, name: saved, path: `C:\\Thor\\uploads\\${saved}`, size: total } }
  })
}

/** The file chooser, intercepted: the next one that opens gets `paths`. Resolves with its mode. */
export async function chooser(page) {
  await page.send('Page.setInterceptFileChooserDialog', { enabled: true })
  const queue = []
  page.on((m) => {
    if (m.method !== 'Page.fileChooserOpened') return
    const next = queue.shift()
    if (next) next(m.params)
  })
  return (paths) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no file chooser opened')), 6000)
    queue.push(async (p) => {
      clearTimeout(timer)
      if (paths.length) await page.send('DOM.setFileInputFiles', { files: paths, backendNodeId: p.backendNodeId })
      resolve(p.mode)
    })
  })
}

async function shellUp(page) {
  await page.waitFor(() => document.querySelector('.vl-nav[data-ready]') || document.querySelector('.vl-setbar'), { timeout: 12_000, message: 'the v2 shell did not come up' })
}

/** The rows under Upload, top to bottom. */
function rowsIn() {
  return [...document.querySelectorAll('.hm-up .up-row')].map((r) => ({
    state: r.dataset.state,
    name: r.querySelector('.up-name')?.textContent ?? '',
    meta: r.querySelector('.up-meta')?.textContent ?? '',
    pct: r.querySelector('.up-pct')?.textContent ?? '',
    thumb: !!r.querySelector('.up-thumb img'),
    retry: !!r.querySelector('.up-retry'),
    copy: !!r.querySelector('.up-act[aria-label^="Copy"]'),
  }))
}

/** Records what the page copies (the http tailnet page has no clipboard object; the fallback is the same call). */
const stubClipboard = () => {
  window.__copied = []
  const write = async (t) => { window.__copied.push(t) }
  try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: write, readText: async () => '' } }) } catch { /* keep the real one */ }
}

export function uploadTests() {
  return [
    {
      name: 'upload:dashboard:ok',
      group: 'upload',
      device: 'phone',
      timeout: 60_000,
      async run(t) {
        const fx = fixtures()
        const page = await t.page()
        const log = []
        const flaky = new Set()
        agent(page, () => 'ok', log, flaky)
        const pick = await chooser(page)
        await page.goto('/m/dashboard')
        await shellUp(page)
        await page.waitFor(() => document.querySelector('.hm-up [data-upload-open="files"]'), { message: 'the Upload block is not on the Dashboard' })

        // where it sits: right under Quick Start, before Lights
        const order = await page.eval(() => {
          const up = document.querySelector('.vl-page[data-active] .hm-up')
          return { prev: (up?.previousElementSibling?.textContent ?? '').slice(0, 40), next: up?.nextElementSibling?.className ?? '' }
        })
        t.check(/Quick Start/i.test(order.prev) && /hm-lights/.test(order.next), `Upload is not between Quick Start and Lights (before it: "${order.prev}", after it: ${order.next})`)

        // the camera plate opens the single-shot camera picker (capture), nothing picked
        const camMode = pick([])
        await page.tap('.hm-up [data-upload-open="camera"]')
        t.check((await camMode) === 'selectSingle', 'the Camera plate did not open a single-file picker')
        const cap = await page.eval(() => document.querySelector('.hm-up input[data-upload="camera"]')?.getAttribute('capture'))
        t.check(cap === 'environment', `the camera input has capture=${cap}, want environment`)
        t.check(log.length === 0, 'a camera picker closed with nothing picked still sent something')

        // Photos & files: three at once (two pictures and a video); the video's first try meets a 502
        flaky.add('clip.mov')
        const since = Date.now()
        const libMode = pick([fx.sunset, fx.sea, fx.clip])
        await page.tap('.hm-up [data-upload-open="files"]')
        t.check((await libMode) === 'selectMultiple', 'the Photos & files plate did not open a multi-file picker')
        await page.waitFor(() => document.querySelectorAll('.hm-up .up-row').length === 3, { message: 'three rows did not show' })
        await t.step('progress', () => page.waitFor(() => document.querySelector('.hm-up .up-row[data-state="up"] .vl-bar') && /to go/.test(document.querySelector('.hm-up .hm-head-value')?.textContent ?? ''), { timeout: 4000, message: 'no row showed its progress gauge and the head no "to go"' }))
        await t.shot(page, 'sending')
        await page.waitFor(() => [...document.querySelectorAll('.hm-up .up-row')].every((r) => r.dataset.state === 'done'), { timeout: 15_000, message: 'not every file landed' })
        const rows = await page.eval(rowsIn)
        t.check(rows.map((r) => r.name).join(',') === 'clip.mov,sea.png,sunset.png', `rows (newest first) read ${rows.map((r) => r.name).join(',')}`)
        t.check(rows.every((r) => r.copy), 'a landed row has no copy button')
        t.check(rows.filter((r) => r.thumb).length >= 2, `the pictures have no thumbnails (${rows.filter((r) => r.thumb).length} of 2)`)

        // the requests: in the order picked, one at a time, the video in two chunks resumed from thor's count
        const names = log.map((l) => `${l.name}@${l.offset}`)
        t.check(names.join(',') === 'sunset.png@0,sea.png@0,clip.mov@0,clip.mov@0', `chunks went ${names.join(',')}, want the video sent again after the 502`)
        t.check(log[2]?.id === log[3]?.id, 'the try after the 502 did not keep its upload id')
        t.check(log.every((l) => /^[0-9a-f]{32}$/.test(l.id)), 'an upload id is not 32 hex characters')
        t.check(new Set(log.map((l) => l.id)).size === 3, 'the three files did not get three upload ids')
        t.check(page.writes.every((w) => w.path === '/api/hosts/thor/upload'), `another write went out: ${page.writes.map((w) => w.path).join(', ')}`)
        const bad = (await page.toasts(since)).filter((x) => /fail|not sent/i.test(x))
        t.check(!bad.length, `an error toast showed: ${bad.join(', ')}`)

        // copy the path a session needs
        await page.eval(stubClipboard)
        await page.tap({ sel: '.hm-up .up-act', text: 'sea.png' })
        await page.waitFor(() => (window.__copied ?? []).length > 0, { message: 'nothing was copied' })
        const copied = await page.eval(() => window.__copied)
        t.check(copied[0] === 'C:\\Thor\\uploads\\20261018-141500-sea.png', `copied ${JSON.stringify(copied[0])}`)
        await page.waitFor(() => /Path copied/.test(document.querySelector('.hm-up')?.textContent ?? ''), { message: 'the row did not say Path copied' })
        await t.shot(page, 'landed')

        // a reload keeps the landed list on this device, thumbnails too
        await page.goto('/m/dashboard')
        await shellUp(page)
        await page.waitFor(() => document.querySelectorAll('.hm-up .up-row[data-state="done"]').length === 3, { message: 'the landed list did not survive a reload' })
        const again = await page.eval(rowsIn)
        t.check(again.filter((r) => r.thumb).length >= 2, 'the thumbnails did not survive a reload')
        t.check(page.writes.length === 4, `a reload sent something: ${page.writes.length} writes`)
      },
    },
    {
      name: 'upload:dashboard:fail-retry',
      group: 'upload',
      device: 'phone',
      timeout: 60_000,
      async run(t) {
        const fx = fixtures()
        const page = await t.page()
        const log = []
        let mode = 'refuse'
        agent(page, () => mode, log)
        const pick = await chooser(page)
        await page.goto('/m/dashboard')
        await shellUp(page)
        await page.waitFor(() => document.querySelector('.hm-up [data-upload-open="files"]'), { message: 'the Upload block is not on the Dashboard' })

        // a file thor would refuse by type fails here, with nothing sent and nothing to retry
        let chosen = pick([fx.doc])
        await page.tap('.hm-up [data-upload-open="files"]')
        await chosen
        await page.waitFor(() => document.querySelector('.hm-up .up-row[data-state="err"]'), { message: 'the PDF did not fail' })
        let rows = await page.eval(rowsIn)
        t.check(/Only pictures and videos/.test(rows[0]?.meta ?? ''), `the PDF row says ${JSON.stringify(rows[0]?.meta)}`)
        t.check(!rows[0]?.retry, 'the PDF row offers Retry')
        t.check(log.length === 0, 'the PDF was sent')
        await page.tap({ sel: '.hm-up .up-act', text: 'Dismiss notes.pdf' })
        await page.waitFor(() => !document.querySelector('.hm-up .up-row'), { message: 'Dismiss did not take the row away' })

        // thor refuses: the row fails with thor's words and offers Retry
        chosen = pick([fx.sunset])
        await page.tap('.hm-up [data-upload-open="files"]')
        await chosen
        await page.waitFor(() => document.querySelector('.hm-up .up-row[data-state="err"] .up-retry'), { timeout: 8000, message: 'the refused file did not fail with Retry' })
        rows = await page.eval(rowsIn)
        t.check(rows[0]?.meta.includes(REFUSED), `the failed row says ${JSON.stringify(rows[0]?.meta)}, want the server's error`)
        t.check(/1 file failed/.test(await page.eval(() => document.querySelector('.hm-up .hm-head-value')?.textContent ?? '')), 'the head does not say 1 file failed')
        t.check(log.length === 1, `a 403 was retried by the chunk loop: ${log.length} requests`)
        await t.shot(page, 'failed')

        // Retry with thor answering: it lands
        mode = 'ok'
        await page.tap('.hm-up .up-retry')
        await page.waitFor(() => document.querySelector('.hm-up .up-row')?.dataset.state === 'done', { timeout: 8000, message: 'Retry did not land the file' })
        t.check(log.length === 2 && log[1].offset === 0 && log[1].name === 'sunset.png', `Retry sent ${JSON.stringify(log.slice(1))}`)
        t.check(log[1].id !== log[0].id, 'Retry reused the failed upload id')
        rows = await page.eval(rowsIn)
        t.check(rows.length === 1 && rows[0].copy && !rows[0].retry, 'after Retry the row is not a landed row with copy')
      },
    },
    {
      name: 'upload:dashboard:desktop',
      group: 'upload',
      device: 'desktop',
      timeout: 45_000,
      async run(t) {
        const fx = fixtures()
        const page = await t.page()
        const log = []
        agent(page, () => 'ok', log)
        const pick = await chooser(page)
        await page.goto('/m/dashboard')
        await shellUp(page)
        await page.waitFor(() => document.querySelector('.hm-up [data-upload-open="files"]'), { message: 'the Upload block is not on the Dashboard' })
        const plates = await page.eval(() => [...document.querySelectorAll('.hm-up [data-upload-open]')].map((e) => e.dataset.uploadOpen))
        t.check(plates.join(',') === 'files', `desktop plates: ${plates.join(',')}, want only files (no camera)`)
        const chosen = pick([fx.sea])
        await page.tap('.hm-up [data-upload-open="files"]')
        await chosen
        await page.waitFor(() => document.querySelector('.hm-up .up-row')?.dataset.state === 'done', { timeout: 8000, message: 'the picked file did not land' })
        t.check(log.length === 1, `${log.length} requests for one small file`)
        await t.shot(page, 'desktop')
      },
    },
    {
      // uploads older than half an hour fold behind one line, so the Dashboard stays short
      name: 'upload:dashboard:recent',
      group: 'upload',
      device: 'phone',
      timeout: 45_000,
      async run(t) {
        const at = Date.now() - 2 * 3_600_000
        const kept = ['a.jpg', 'b.jpg', 'c.mov', 'd.png'].map((n, k) => ({
          name: n, size: 1000 + k, kind: n.endsWith('.mov') ? 'video' : 'image', at: at - k * 60_000,
          path: `C:\\Thor\\uploads\\20261018-090000-${n}`, saved: `20261018-090000-${n}`,
        }))
        const page = await t.page({ storage: { 'v2.uploads': JSON.stringify(kept) } })
        agent(page, () => 'ok', [])
        await page.goto('/m/dashboard')
        await shellUp(page)
        await page.waitFor(() => document.querySelector('.hm-up .up-foot'), { message: 'the Recent line did not show' })
        t.check((await page.eval(() => document.querySelectorAll('.hm-up .up-row').length)) === 0, 'old uploads show as rows at rest')
        const line = await page.eval(() => document.querySelector('.hm-up .up-foot')?.textContent ?? '')
        t.check(/Recent uploads · 4/.test(line), `the folded line reads ${JSON.stringify(line)}`)
        await t.shot(page, 'folded')
        await page.tap({ sel: '.hm-up .up-link', text: 'Recent uploads' })
        await page.waitFor(() => document.querySelectorAll('.hm-up .up-row[data-state="done"]').length === 4, { message: 'Recent did not open the four kept uploads' })
        await page.eval(stubClipboard)
        await page.tap({ sel: '.hm-up .up-main', text: 'c.mov' })
        await page.waitFor(() => (window.__copied ?? []).length > 0, { message: 'a tap on the row copied nothing' })
        t.check((await page.eval(() => window.__copied[0])) === 'C:\\Thor\\uploads\\20261018-090000-c.mov', 'the row copied the wrong path')
        await page.tap({ sel: '.hm-up .up-link', text: 'Clear list' })
        await page.waitFor(() => !document.querySelector('.hm-up .up-list'), { message: 'Clear list left something' })
        t.check((await page.eval(() => localStorage.getItem('v2.uploads'))) === '[]', 'Clear list did not empty the kept list')
        t.check(page.writes.length === 0, 'the Recent list sent something')
      },
    },
    {
      // AI > Sessions: one icon button on the same queue; how it went comes as a toast
      name: 'upload:sessions:button',
      group: 'upload',
      device: 'phone',
      timeout: 45_000,
      async run(t) {
        const fx = fixtures()
        const page = await t.page()
        const log = []
        let mode = 'ok'
        agent(page, () => mode, log)
        const pick = await chooser(page)
        await page.goto('/m/ai/sessions')
        await shellUp(page)
        await page.waitFor(() => document.querySelector('.vl-page[data-active] .up-btn'), { message: 'the upload button is not on AI > Sessions' })
        let since = Date.now()
        let chosen = pick([fx.sunset, fx.sea])
        await page.tap('.vl-page[data-active] .up-btn')
        t.check((await chosen) === 'selectMultiple', 'the button did not open a multi-file picker')
        await page.waitToast(/2 files are on thor/, { since, timeout: 8000 })
        t.check(log.length === 2, `${log.length} requests for two files`)
        const early = (await page.toasts(since)).filter((x) => /is on thor/.test(x))
        t.check(!early.length, `a toast per file showed as well: ${early.join(', ')}`)
        await page.eval(stubClipboard)
        await page.tap({ sel: '.vl-toast-btn', text: 'Copy path' })
        await page.waitFor(() => (window.__copied ?? []).length > 0, { message: 'Copy path copied nothing' })
        t.check((await page.eval(() => window.__copied[0])) === 'C:\\Thor\\uploads\\20261018-141500-sunset.png C:\\Thor\\uploads\\20261018-141500-sea.png', 'Copy path copied the wrong paths')
        // the same queue: the Dashboard lists them
        t.check((await page.eval(() => document.querySelectorAll('.hm-up .up-row[data-state="done"]').length)) === 2, 'the Dashboard does not list the files sent from Sessions')

        // a refusal: a toast with Retry, which sends it again
        mode = 'refuse'
        since = Date.now()
        chosen = pick([fx.sunset])
        await page.tap('.vl-page[data-active] .up-btn')
        await chosen
        await page.waitToast(new RegExp(`sunset.png not sent: ${REFUSED}`), { since, timeout: 8000 })
        await t.shot(page, 'refused')
        mode = 'ok'
        await page.tap({ sel: '.vl-toast-btn', text: 'Retry' })
        await page.waitFor(() => [...document.querySelectorAll('.hm-up .up-row')].every((r) => r.dataset.state === 'done'), { timeout: 8000, message: 'Retry from the toast did not land the file' })
        t.check(log.length === 4, `${log.length} requests, want 4 (two, the refused one, its retry)`)
      },
    },
  ]
}
