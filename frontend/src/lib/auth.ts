// App session token storage for the dedicated apps' self-hosted auth.
//
// Web/PWA baseline: localStorage. Part 3 (the Tauri shell) will swap this for
// the OS secure store + biometric unlock behind the same getToken/setToken API.
// Kept free of any import of ./api so the api <-> auth wiring has no import cycle.

const TOKEN_KEY = 'valkyrie.appToken'
const EXP_KEY = 'valkyrie.appTokenExp'
// Pre-rename keys — read as fallbacks so existing sessions survive the rename.
const LEGACY_TOKEN_KEY = 'mc.appToken'
const LEGACY_EXP_KEY = 'mc.appTokenExp'
const AUTH_EVENT = 'valkyrie-auth-changed'

let memToken: string | null = null

export function getToken(): string | null {
  if (memToken) return memToken
  try {
    const t = localStorage.getItem(TOKEN_KEY) ?? localStorage.getItem(LEGACY_TOKEN_KEY)
    if (!t) return null
    const exp = Number(localStorage.getItem(EXP_KEY) ?? localStorage.getItem(LEGACY_EXP_KEY) ?? 0)
    if (exp && exp <= Date.now()) { clearToken(); return null }
    memToken = t
    return t
  } catch {
    return memToken
  }
}

export function setToken(token: string, expiresAt: number): void {
  memToken = token
  try {
    localStorage.setItem(TOKEN_KEY, token)
    localStorage.setItem(EXP_KEY, String(expiresAt || 0))
  } catch { /* storage unavailable */ }
  notifyAuthChange()
}

export function clearToken(): void {
  memToken = null
  try {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(EXP_KEY)
    localStorage.removeItem(LEGACY_TOKEN_KEY)
    localStorage.removeItem(LEGACY_EXP_KEY)
  } catch { /* storage unavailable */ }
  notifyAuthChange()
}

export function hasToken(): boolean {
  return Boolean(getToken())
}

// True when running inside the Tauri desktop/mobile app (vs. a web browser).
// The migration "skip" hatch must not be offered here: the legacy no-token
// bypass is keyed to the web origin, so the app can only authenticate with a
// real token — skipping would just 401 every API call.
export function isTauri(): boolean {
  return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
}

// Migration-only escape hatch: when the backend isn't strict yet, the user can
// proceed without a token (the legacy bypass still authorizes them). Scoped to
// the tab so it never persists past a real cutover.
const SKIP_KEY = 'valkyrie.authSkip'
export function setAuthSkipped(v: boolean): void {
  try { v ? sessionStorage.setItem(SKIP_KEY, '1') : sessionStorage.removeItem(SKIP_KEY) } catch { /* ignore */ }
  notifyAuthChange()
}
export function isAuthSkipped(): boolean {
  try { return sessionStorage.getItem(SKIP_KEY) === '1' } catch { return false }
}

// Lightweight pub/sub via a window event so React can re-render the auth gate
// when the token changes (login, logout, or a 401 from the api interceptor).
export function notifyAuthChange(): void {
  try { window.dispatchEvent(new Event(AUTH_EVENT)) } catch { /* non-browser */ }
}
export function onAuthChange(cb: () => void): () => void {
  window.addEventListener(AUTH_EVENT, cb)
  return () => window.removeEventListener(AUTH_EVENT, cb)
}
