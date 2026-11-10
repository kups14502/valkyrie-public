import { api } from './api'

// Dashboard > Hotkeys (backend/src/routes/hostLaunch.ts): thor's keyboard actions as
// buttons, run by thorkeys.ahk through the session-board agent, plus the soundboard
// (clips mixed into thor's mic by its audio plug-in). The page sends an id or a clip
// name from thor's own lists, never a key or a path.

export type HotkeyId =
  | 'mic' | 'discordmute' | 'discorddeafen'
  | 'claude1' | 'claude2' | 'claude3'
  | 'dim' | 'shot' | 'clip'
  | 'play' | 'prev' | 'next' | 'output' | 'voldown' | 'volup' | 'volmute'
  | 'mode' | 'vr'

export type HotkeyState = {
  /** thorkeys.ahk answered the agent's ping */
  ready: boolean
  /** every mic muted, any mic live, or no mic found */
  mic: 'muted' | 'live' | 'unknown'
  /** the dim overlay, percent (0 = off) */
  dim: number
  /** thor's default playback device, as the Output key names it (null: some other device) */
  output: string | null
  /** work mode or game mode: the mouse's and the keyboard's profiles, switched together (null: unknown) */
  mode: 'work' | 'game' | null
  /** SteamVR and thor's audio on the Frame (Loki): on, off, or VrMode.ps1 still switching (null: unknown) */
  vr: 'on' | 'off' | 'starting' | 'stopping' | null
  /** Discord mute and deafen as thor tracks them from the keys' presses (Discord itself is not readable) */
  discord: { muted: boolean; deafened: boolean } | null
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
  const output = typeof d.output === 'string' && d.output ? d.output.slice(0, 16) : null
  const mode = d.mode === 'work' || d.mode === 'game' ? d.mode : null
  const vr = d.vr === 'on' || d.vr === 'off' || d.vr === 'starting' || d.vr === 'stopping' ? d.vr : null
  const discord = d.discord && typeof d.discord === 'object' ? { muted: d.discord.muted === true, deafened: d.discord.deafened === true } : null
  return { ready: d.ready === true, mic, dim: typeof d.dim === 'number' ? d.dim : 0, output, mode, vr, discord, labels }
}

export const pressHotkey = async (id: HotkeyId) =>
  (await api.post<{ ok: boolean; id: string; output?: string; mode?: string; vr?: string }>('/hosts/thor/hotkey', { id })).data

export type Clip = { name: string; seconds: number | null }

export type Soundboard = {
  clips: Clip[]
  /** an app is capturing from the mic, so a clip reaches it (the plug-in is mixing) */
  micConnected: boolean
}

export const fetchSoundboard = async (): Promise<Soundboard> => {
  const d = (await api.get<{ clips?: { name?: unknown; seconds?: unknown }[]; mic?: { connected?: unknown } }>('/hosts/thor/soundboard')).data
  const clips = (d.clips ?? [])
    .filter((c): c is { name: string; seconds?: unknown } => typeof c.name === 'string' && !!c.name)
    .map((c) => ({ name: c.name.slice(0, 80), seconds: typeof c.seconds === 'number' ? c.seconds : null }))
  return { clips, micConnected: d.mic?.connected === true }
}

export const playClip = async (name: string) =>
  (await api.post<{ ok: boolean }>('/hosts/thor/soundboard/play', { name })).data

export const stopClips = async () =>
  (await api.post<{ ok: boolean }>('/hosts/thor/soundboard/stop', {})).data
