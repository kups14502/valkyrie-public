import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { thorHands } from '../../../routes/hostLaunch.js'
import type { RavenToolCtx } from '../types.js'
import { RavenToolError, toolRun } from './util.js'

// thor's screen, as Raven sees and touches it. Brendon, 2026-11-23 (Raven
// thread #950): Raven keeps his long sessions going overnight, and a popup (a
// delete confirmation, a Windows dialog) can block one; Raven must see the
// screen when needed and dismiss it with a click or a key. The launcher agent
// does the work on thor (C:\Thor\tools\session-board\Raven-Hands.ps1).
//
// A screenshot comes back as a picture Raven reads, at most 1600 px wide, with
// a shot id; a click names a point in that picture, and the shot id maps it
// back to thor's screen pixels, so Raven never does the scaling itself. A
// locked screen or an elevation prompt (the secure desktop) cannot be seen or
// touched, and every action says so.

type Region = { x: number; y: number; w: number; h: number; imgW: number; imgH: number; at: number }

const shots = new Map<string, Region>()
let shotSeq = 0
const SHOT_KEEP_MS = 30 * 60_000

/** Windows that are part of his desktop itself, never a popup: left out of the list. */
const FURNITURE = new Set(['ThorDesktop', 'ThorBar', 'NVIDIA Overlay', 'TextInputHost', 'ShellExperienceHost', 'SearchHost', 'StartMenuExperienceHost'])

type Win = { hwnd: number; title: string; class: string; process: string; x: number; y: number; w: number; h: number; foreground: boolean; minimized: boolean; dialog: boolean; owned: boolean; buttons?: string[] }

function failed(r: { status: number; body: Record<string, unknown> } | null, what: string): never {
  if (!r) throw new RavenToolError(`thor's launcher is not answering, so ${what} did not happen`)
  throw new RavenToolError(`${what}: ${String(r.body.error ?? `thor answered ${r.status}`).slice(0, 300)}`)
}

async function windows(): Promise<{ desktop: string; list: Win[] }> {
  const r = await thorHands('GET', '/windows', undefined, 30_000)
  if (!r || r.status !== 200 || !Array.isArray(r.body.windows)) failed(r, 'listing windows')
  const list = (r.body.windows as Win[]).filter((w) => !FURNITURE.has(w.process))
  return { desktop: String(r.body.desktop ?? ''), list }
}

async function monitors(): Promise<{ index: number; x: number; y: number; w: number; h: number; primary: boolean }[]> {
  const r = await thorHands('GET', '/monitors')
  return r && r.status === 200 && Array.isArray(r.body.monitors) ? r.body.monitors as { index: number; x: number; y: number; w: number; h: number; primary: boolean }[] : []
}

const winLine = (w: Win) => ({
  window: w.hwnd, title: w.title || '(no title)', app: w.process, ...(w.dialog ? { dialog: true } : {}), ...(w.buttons?.length ? { buttons: w.buttons } : {}),
  ...(w.foreground ? { front: true } : {}), ...(w.minimized || w.x <= -30000 ? { minimized: true } : { at: `${w.x},${w.y} ${w.w}x${w.h}` }),
})

export function registerThorScreenTools(server: McpServer, ctx: RavenToolCtx): void {
  server.registerTool('thor_screen', {
    description: "A screenshot of thor's screen, as a picture. monitor: a monitor index (thor_windows lists them; without one, every monitor at once, "
      + 'small). window: a window id from thor_windows, to see just that window. The answer has a shot id: thor_click takes a point in this picture '
      + 'with it. Use it when a session is stuck and its own screen (session_screen) does not say why, or to find a popup before dismissing it.',
    inputSchema: { monitor: z.number().int().min(0).max(8).optional(), window: z.number().int().optional() },
  }, async (a): Promise<CallToolResult> => {
    try {
      let area = { x: 0, y: 0, w: 0, h: 0 }
      if (a.window !== undefined) {
        const w = (await windows()).list.find((x) => x.hwnd === a.window)
        if (!w) throw new RavenToolError(`no window ${a.window} (thor_windows lists them)`)
        if (w.minimized || w.x <= -30000) throw new RavenToolError(`${w.title} is minimized: nothing of it is on screen`)
        area = { x: w.x, y: w.y, w: w.w, h: w.h }
      } else if (a.monitor !== undefined) {
        const m = (await monitors()).find((x) => x.index === a.monitor)
        if (!m) throw new RavenToolError(`no monitor ${a.monitor}`)
        area = { x: m.x, y: m.y, w: m.w, h: m.h }
      }
      const r = await thorHands('POST', '/shot', { ...area, maxW: 1600 }, 40_000)
      if (!r || r.status !== 200 || typeof r.body.jpeg !== 'string') failed(r, 'the screenshot')
      const b = r.body
      const id = `s${++shotSeq}`
      const now = Date.now()
      for (const [k, v] of shots) if (now - v.at > SHOT_KEEP_MS) shots.delete(k)
      shots.set(id, { x: Number(b.x), y: Number(b.y), w: Number(b.w), h: Number(b.h), imgW: Number(b.imgW), imgH: Number(b.imgH), at: now })
      ctx.acted()
      return {
        content: [
          { type: 'image', data: b.jpeg as string, mimeType: 'image/jpeg' },
          { type: 'text', text: JSON.stringify({ shot: id, picture: `${b.imgW}x${b.imgH}`, covers: `screen ${b.x},${b.y} ${b.w}x${b.h}` }) },
        ],
      }
    } catch (e) {
      return toolRun(() => { throw e })
    }
  })

  server.registerTool('thor_windows', {
    description: "The windows open on thor's screen (his desktop's own icons and bars left out) and the monitors. A dialog (a standard Windows "
      + 'popup) lists its buttons: thor_button presses one by its text without needing focus. desktop is not Default when the screen is locked or an '
      + 'elevation prompt is up: then nothing can be seen or touched.',
    inputSchema: {},
  }, () => toolRun(async () => {
    const [w, m] = await Promise.all([windows(), monitors()])
    return { desktop: w.desktop, monitors: m, windows: w.list.map(winLine) }
  }))

  server.registerTool('thor_button', {
    description: 'Press a button in a window on thor by its text ("OK", "Yes", "No", "Cancel", "Close", "Delete") without moving the mouse or taking '
      + 'focus: the way to dismiss a standard Windows dialog. window is its id from thor_windows. Press the choice that keeps Brendon\'s data and '
      + 'settings: "No" or "Cancel" to a delete or removal question unless his work needs it gone.',
    inputSchema: { window: z.number().int(), text: z.string().min(1).max(60) },
  }, (a) => toolRun(async () => {
    const r = await thorHands('POST', '/button', { hwnd: a.window, text: a.text })
    if (!r || r.status !== 200) failed(r, `pressing "${a.text}"`)
    ctx.acted()
    return { pressed: r.body.clicked ?? a.text }
  }))

  server.registerTool('thor_click', {
    description: 'Click a point on thor\'s screen: shot is the id thor_screen gave, x and y a point in that picture (its pixels, from the top left). '
      + 'button left (default) or right; double for a double click. For a popup thor_button cannot reach (not a standard dialog). '
      + 'Take a new thor_screen afterward to see what it did.',
    inputSchema: { shot: z.string().max(12), x: z.number().min(0), y: z.number().min(0), button: z.enum(['left', 'right']).optional(), double: z.boolean().optional() },
  }, (a) => toolRun(async () => {
    const s = shots.get(a.shot)
    if (!s) throw new RavenToolError(`no shot ${a.shot}: take one with thor_screen (a shot is kept 30 minutes)`)
    if (a.x > s.imgW || a.y > s.imgH) throw new RavenToolError(`that point is outside the picture (${s.imgW}x${s.imgH})`)
    const x = Math.round(s.x + a.x * (s.w / s.imgW))
    const y = Math.round(s.y + a.y * (s.h / s.imgH))
    const r = await thorHands('POST', '/click', { x, y, button: a.button ?? 'left', count: a.double ? 2 : 1 })
    if (!r || r.status !== 200) failed(r, 'the click')
    ctx.acted()
    return { clicked: `${x},${y} on thor's screen`, button: a.button ?? 'left', double: a.double || undefined }
  }))

  server.registerTool('thor_press', {
    description: 'Press keys on thor as if typed at its keyboard, into the front window, or into window (an id from thor_windows) brought to the '
      + 'front first. keys: comma separated, a key or a combination with +: "enter", "esc", "tab", "space", "y", "n", "alt+f4", "left". '
      + 'For a popup; a Claude session gets session_keys instead, which needs no focus.',
    inputSchema: { keys: z.string().min(1).max(80), window: z.number().int().optional() },
  }, (a) => toolRun(async () => {
    const keys = a.keys.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean)
    if (!keys.length || keys.some((k) => !/^(?:(?:ctrl|alt|shift|win)\+)*(?:[a-z0-9]|enter|esc|escape|tab|space|backspace|delete|up|down|left|right|home|end|f4|f5)$/.test(k))) {
      throw new RavenToolError('keys: letters, digits, enter, esc, tab, space, backspace, delete, arrows, home, end, f4, f5, with ctrl+, alt+, shift+ or win+')
    }
    const r = await thorHands('POST', '/press', { keys: keys.join(','), ...(a.window !== undefined ? { hwnd: a.window } : {}) })
    if (!r || r.status !== 200) failed(r, 'the key press')
    ctx.acted()
    return { pressed: keys, front: r.body.foreground ?? undefined }
  }))
}
