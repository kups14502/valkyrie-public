import { useSyncExternalStore } from 'react'
import { musicImg, musicStreamUrl, scrobbleMusic, type MusicTrack } from './api'

// The one music player. Module state rather than React state so playback
// survives route changes, and one <audio> element that is never in the DOM
// (it only has to exist). PlayerBar renders this; the Plex page drives it.

export type PlayerState = {
  queue: MusicTrack[]
  index: number
  playing: boolean
  position: number
  duration: number
  error: string | null
}

let state: PlayerState = { queue: [], index: -1, playing: false, position: 0, duration: 0, error: null }
const listeners = new Set<() => void>()

function set(patch: Partial<PlayerState>) {
  state = { ...state, ...patch }
  for (const l of listeners) l()
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => { listeners.delete(l) }
}
const getState = () => state
const current = () => state.queue[state.index] as MusicTrack | undefined

export const usePlayer = () => useSyncExternalStore(subscribe, getState, getState)
// Primitive selectors: a track row re-renders only when its answer changes,
// not four times a second with the position.
export const useNowPlayingKey = () => useSyncExternalStore(subscribe, () => current()?.ratingKey ?? null, () => null)
export const useIsPlaying = () => useSyncExternalStore(subscribe, () => state.playing, () => false)

let audio: HTMLAudioElement | null = null
let skipTimer: number | undefined

const hasMediaSession = () => typeof navigator !== 'undefined' && 'mediaSession' in navigator

function el(): HTMLAudioElement {
  if (audio) return audio
  const a = new Audio()
  a.preload = 'auto'
  a.addEventListener('timeupdate', () => set({ position: a.currentTime }))
  a.addEventListener('durationchange', () => {
    if (Number.isFinite(a.duration) && a.duration > 0) set({ duration: a.duration })
  })
  a.addEventListener('play', () => {
    set({ playing: true, error: null })
    if (hasMediaSession()) navigator.mediaSession.playbackState = 'playing'
  })
  a.addEventListener('pause', () => {
    set({ playing: false })
    if (hasMediaSession()) navigator.mediaSession.playbackState = 'paused'
  })
  a.addEventListener('ended', () => {
    const t = current()
    if (t) void scrobbleMusic(t.ratingKey).catch(() => {})
    advance()
  })
  // A format the browser can't decode (a handful of musepack and mp2 files):
  // say so, then move on rather than stall the queue.
  a.addEventListener('error', () => {
    const t = current()
    if (!t) return
    set({ playing: false, error: `can't play "${t.title}" (${t.codec ?? t.container ?? 'unknown format'}), skipping` })
    window.clearTimeout(skipTimer)
    skipTimer = window.setTimeout(advance, 1500)
  })
  installMediaSession()
  audio = a
  return a
}

function load(i: number) {
  const t = state.queue[i] as MusicTrack | undefined
  if (!t) return
  const a = el()
  window.clearTimeout(skipTimer)
  set({ index: i, position: 0, duration: (t.duration ?? 0) / 1000, error: null })
  if (!t.streamKey) {
    set({ playing: false, error: `no file for "${t.title}", skipping` })
    skipTimer = window.setTimeout(advance, 1500)
    return
  }
  a.src = musicStreamUrl(t.streamKey)
  void a.play().catch((e: Error) => {
    set({ playing: false, error: e.name === 'NotAllowedError' ? 'tap play to start' : e.message })
  })
  setMetadata(t)
}

// End of the queue: stop, but keep the last track showing so the bar stays.
function advance() {
  if (state.index + 1 < state.queue.length) load(state.index + 1)
  else set({ playing: false })
}

export function playQueue(tracks: MusicTrack[], startIndex = 0) {
  if (!tracks.length) return
  set({ queue: tracks })
  load(Math.min(Math.max(0, startIndex), tracks.length - 1))
}

export function playShuffled(tracks: MusicTrack[]) {
  const q = [...tracks]
  for (let i = q.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    const t = q[i]
    q[i] = q[j]
    q[j] = t
  }
  playQueue(q, 0)
}

export function playAt(i: number) { load(i) }

export function toggle() {
  const a = el()
  if (!current()) return
  if (!a.paused) { a.pause(); return }
  if (!a.src) { load(state.index); return }
  void a.play().catch((e: Error) => set({ playing: false, error: e.message }))
}

export function next() {
  if (state.index + 1 < state.queue.length) load(state.index + 1)
}

// Early in a track, previous means the previous track; later it restarts this one.
export function prev() {
  const a = el()
  if (a.currentTime > 3 || state.index <= 0) {
    a.currentTime = 0
    set({ position: 0 })
    return
  }
  load(state.index - 1)
}

export function seek(sec: number) {
  const a = el()
  a.currentTime = Math.max(0, state.duration ? Math.min(sec, state.duration) : sec)
  set({ position: a.currentTime })
}

export function stop() {
  const a = el()
  window.clearTimeout(skipTimer)
  set({ queue: [], index: -1, playing: false, position: 0, duration: 0, error: null })
  a.pause()
  a.removeAttribute('src')
  a.load()
  if (hasMediaSession()) {
    navigator.mediaSession.metadata = null
    navigator.mediaSession.playbackState = 'none'
  }
}

// Lock-screen and headset controls. Actions a platform lacks throw on
// registration; those are simply skipped.
function installMediaSession() {
  if (!hasMediaSession()) return
  const ms = navigator.mediaSession
  const on = (action: MediaSessionAction, fn: (d: MediaSessionActionDetails) => void) => {
    try { ms.setActionHandler(action, fn) } catch { /* unsupported action */ }
  }
  on('play', () => toggle())
  on('pause', () => toggle())
  on('previoustrack', () => prev())
  on('nexttrack', () => next())
  on('seekto', (d) => { if (d.seekTime != null) seek(d.seekTime) })
}

function setMetadata(t: MusicTrack) {
  if (!hasMediaSession() || typeof MediaMetadata === 'undefined') return
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title,
    artist: t.trackArtist ?? t.artist,
    album: t.album,
    artwork: t.thumb ? [{ src: musicImg(t.thumb, 512), sizes: '512x512', type: 'image/jpeg' }] : [],
  })
}
