// UNIT: plain-node tests the suite runs beside the browser ones, so one
// `node e2e/run.mjs` covers them too. No page, no backend, no bulb.
//
//   lights   e2e/lights-unit.mjs: src/lib/lights.ts's send queue (one command in
//            flight, the newest per bulb winning, a lone update sent as asked,
//            a failure rejecting only what it carried, random answer times
//            ending where the last tap said) and its desire rules (merge,
//            satisfied, overlay).
//
// The backend half of the lights (routes/lights.ts, the engine that holds each
// bulb to its target) is backend/scripts/lightsEngine.test.mts, run on odin.

import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

function runNode(file, timeoutMs) {
  return new Promise((res) => {
    const p = spawn(process.execPath, [file], { cwd: resolve(HERE, '..', '..'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { out += d })
    const timer = setTimeout(() => p.kill(), timeoutMs)
    p.on('close', (code) => { clearTimeout(timer); res({ code, out }) })
  })
}

export function unitTests() {
  return [
    {
      name: 'unit:lights-queue',
      group: 'unit',
      timeout: 60_000,
      async run(t) {
        const { code, out } = await runNode(resolve(HERE, '..', 'lights-unit.mjs'), 50_000)
        const pass = Number(/ℹ pass (\d+)/.exec(out)?.[1] ?? NaN)
        const fail = Number(/ℹ fail (\d+)/.exec(out)?.[1] ?? NaN)
        t.note(`lights-unit: ${pass} passed, ${fail} failed`)
        t.check(code === 0, `e2e/lights-unit.mjs exited ${code}`)
        t.check(fail === 0 && pass >= 8, `lights-unit: ${pass} passed, ${fail} failed`)
        for (const line of out.split(/\r?\n/).filter((l) => /^\s*✖/.test(l)).slice(0, 8)) t.check(false, line.trim())
      },
    },
  ]
}
