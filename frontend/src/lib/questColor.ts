// Stable per-quest identity color: hash the quest id into a hue and render it
// at terminal-friendly saturation/lightness. The same quest always gets the
// same color, on every device, with no stored state.
function questHue(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return h % 360
}

export function questColor(id: string, alpha?: number): string {
  const hue = questHue(id)
  return alpha === undefined ? `hsl(${hue} 85% 62%)` : `hsl(${hue} 85% 62% / ${alpha})`
}

// On-hold reads as "paused", not "alarm": a cool steel blue instead of the
// warning yellow (yellow stays reserved for genuinely urgent signals).
export const HOLD_COLOR = '#7c9cc4'
