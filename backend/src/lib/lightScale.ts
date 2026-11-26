// Brightness scales for the Cync bulbs, shared by the light engine
// (routes/lights.ts), its sunrise automations (lib/sunrise.ts) and Raven's
// light tools. Pure: no Home Assistant, no state.
//
// Three scales: the API's 0-255 (what the frontend's pctFromBrightness reads),
// the bulb's own 0-100 level, and HA's 0-255 for this integration. The API
// figure is round(pct * 2.55), so the frontend reads back exactly the percent
// the bulb is at.

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

/** HA's Cync light: the level it sends for a brightness. */
const cyncLevelSent = (b: number) => Math.trunc((b / 255) * 100)
/** HA's Cync light: the brightness it reports for a level. No .5 ties exist, so Math.round matches Python's round. */
const haReported = (level: number) => clamp(Math.round(((level + 1) * 255) / 101), 1, 255)

/** The brightness to send HA so the bulb lands on exactly this percent. */
export function haBrightnessFor(pct: number): number {
  const p = clamp(Math.round(pct), 1, 100)
  const start = Math.max(1, Math.floor(p * 2.55) - 1)
  for (let b = start; b <= Math.min(255, start + 4); b++) if (cyncLevelSent(b) === p) return b
  return clamp(Math.round(p * 2.55), 1, 255)
}

/** The bulb's percent from the brightness HA reports. */
export function pctFromHa(b: number): number {
  const v = Math.round((b * 101) / 255) - 1
  if (v >= 0 && v <= 100 && haReported(v) === b) return Math.max(1, v)
  return clamp(Math.round(b / 2.55), 1, 100)
}

export const apiBrightness = (pct: number) => clamp(Math.round(pct * 2.55), 1, 255)
export const pctFromApi = (b: number) => clamp(Math.round(b / 2.55), 1, 100)
