import { api } from './api'

// Dashboard > Hotkeys (backend/src/routes/hostLaunch.ts): thor's keyboard actions as
// buttons, run by thorkeys.ahk through the session-board agent. The page sends an
// id from this list, never a key.

export type HotkeyId =
  | 'mic' | 'claude1' | 'claude2' | 'claude3'
  | 'dim' | 'shot' | 'paste'
  | 'play' | 'prev' | 'next' | 'voldown' | 'volup' | 'volmute'

export type HotkeyState = {
  /** thorkeys.ahk answered the agent's ping */
  ready: boolean
  /** every mic muted, any mic live, or no mic found */
  mic: 'muted' | 'live' | 'unknown'
  /** the dim overlay, percent (0 = off) */
  dim: number
  /**
   * names for the keys whose names are private (the three new-Claude contexts): thor keeps
   * them (Start-LauncherAgent.ps1), so they never sit in this public repo
   */
  labels: Partial<Record<HotkeyId, string>>
}

export const fetchHotkeys = async (): Promise<HotkeyState> => {
  const d = (await api.get<Partial<HotkeyState>>('/hosts/thor/hotkeys')).data
  const mic = d.mic === 'muted' || d.mic === 'live' ? d.mic : 'unknown'
  const labels: HotkeyState['labels'] = {}
  for (const [k, v] of Object.entries(d.labels ?? {})) if (typeof v === 'string' && v) labels[k as HotkeyId] = v.slice(0, 24)
  return { ready: d.ready === true, mic, dim: typeof d.dim === 'number' ? d.dim : 0, labels }
}

export const pressHotkey = async (id: HotkeyId) =>
  (await api.post<{ ok: boolean; id: string }>('/hosts/thor/hotkey', { id })).data
