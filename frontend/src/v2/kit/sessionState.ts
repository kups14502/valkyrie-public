import type { IconName, IconTone } from './icons'

/** What a Claude session is doing, in the words AI > Sessions uses; closed = not running. */
export type SessionState = 'working' | 'asking' | 'idle' | 'closed'

/**
 * A session's state as its icon (icons.tsx StateIcon draws it), the look AI >
 * Sessions has and the Desk's tabs copy: working and asking are lit (glow,
 * asking in the second accent), idle is dim and closed faint, no glow.
 */
export const STATE_ICON: Record<SessionState, { name: IconName; tone: IconTone; glow: boolean }> = {
  working: { name: 'working', tone: 'fg', glow: true },
  asking: { name: 'asking', tone: 'acc2', glow: true },
  idle: { name: 'idle', tone: 'dim', glow: false },
  closed: { name: 'claude', tone: 'faint', glow: false },
}
