import { api } from './api'
import { isTauri } from './auth'

// Web Push, client side. The backend half is backend/src/routes/push.ts.
//
// The point of this file is the gate: on iOS almost everything about push is
// conditional, and a bare "enable" button that throws a DOMException tells you
// nothing. Every reason a device cannot subscribe is named here in words, so
// Settings can say which one applies instead of failing silently.

export type PushSubscriptionInfo = {
  id: string
  label: string
  ua: string
  createdAt: string
  lastOkAt: string | null
  lastError: string | null
  failCount: number
  service: 'apple' | 'google' | 'mozilla' | 'other'
}

export type PushStatus = {
  configured: boolean
  publicKey: string
  subscriptions: PushSubscriptionInfo[]
}

export const fetchPushStatus = async (): Promise<PushStatus> =>
  (await api.get<PushStatus>('/push/status')).data

export const sendPushTest = async (): Promise<{ ok: boolean; detail: string }> =>
  (await api.post<{ ok: boolean; detail: string }>('/push/test', {})).data

const isIOS = (): boolean =>
  /iPad|iPhone|iPod/.test(navigator.userAgent)
  // iPadOS reports itself as a Mac; the touch points give it away.
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

/** Running as a home-screen app rather than a browser tab. */
export const isStandalone = (): boolean =>
  window.matchMedia?.('(display-mode: standalone)').matches === true
  || (navigator as Navigator & { standalone?: boolean }).standalone === true

/**
 * Why this device cannot receive push, in a sentence, or null if it can.
 * Checked in the order the user has to fix them.
 */
export function pushBlockedReason(): string | null {
  if (isTauri()) {
    return 'The desktop app runs without a service worker on purpose. Use the home-screen web app for notifications.'
  }
  if (!window.isSecureContext) {
    return 'Notifications need https. This page is on the plain-http tailnet address, so open Valkyrie on its public hostname instead.'
  }
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    if (isIOS() && !isStandalone()) {
      return 'On iPhone, push works only from the installed app. Tap Share, then Add to Home Screen, and turn this on from there.'
    }
    return 'This browser has no Web Push support.'
  }
  if (isIOS() && !isStandalone()) {
    return 'On iPhone, push works only from the installed app. Tap Share, then Add to Home Screen, and turn this on from there.'
  }
  if (Notification.permission === 'denied') {
    return 'Notifications are blocked for Valkyrie. Allow them in the device settings for this app, then try again.'
  }
  return null
}

/** base64url (what VAPID keys are) to the Uint8Array subscribe() demands. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(padded)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i)
  return out
}

/** The same short handle the server derives, so the UI can match this device. */
async function endpointId(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12)
}

/** The id of this device's subscription, or null if it has none. */
export async function currentSubscriptionId(): Promise<string | null> {
  if (pushBlockedReason()) return null
  try {
    const reg = await navigator.serviceWorker.getRegistration()
    const sub = await reg?.pushManager.getSubscription()
    return sub ? await endpointId(sub.endpoint) : null
  } catch {
    return null
  }
}

/** A name for this device that means something in a list of three. */
function deviceLabel(): string {
  const ua = navigator.userAgent
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'iPad'
  if (/Android/.test(ua)) return 'Android'
  if (/Macintosh/.test(ua)) return 'Mac'
  if (/Windows/.test(ua)) return 'Windows'
  return 'device'
}

/**
 * Subscribe this device. MUST be called from a user gesture: Safari only
 * shows the permission prompt inside one, and silently returns 'default'
 * otherwise.
 */
export async function enablePush(): Promise<{ id: string }> {
  const blocked = pushBlockedReason()
  if (blocked) throw new Error(blocked)

  const status = await fetchPushStatus()
  if (!status.configured || !status.publicKey) {
    throw new Error('The server has no VAPID keys, so it cannot send push yet.')
  }

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    throw new Error(permission === 'denied'
      ? 'Permission denied. Allow notifications for Valkyrie in the device settings.'
      : 'Permission was dismissed. Tap enable again and choose Allow.')
  }

  // `ready` rather than getRegistration(): on a first run the worker may still
  // be installing, and subscribing against a registration with no active
  // worker fails with an unhelpful AbortError.
  const reg = await navigator.serviceWorker.ready
  const existing = await reg.pushManager.getSubscription()
  // A subscription made against a different VAPID key can never be delivered
  // to, and the browser refuses to re-subscribe over it, so drop it first.
  if (existing) {
    const same = existing.options?.applicationServerKey
      && btoa(String.fromCharCode(...new Uint8Array(existing.options.applicationServerKey)))
        === btoa(String.fromCharCode(...urlBase64ToUint8Array(status.publicKey)))
    if (!same) await existing.unsubscribe()
  }

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(status.publicKey) as BufferSource,
  })

  const { data } = await api.post<{ ok: boolean; id: string }>('/push/subscribe', {
    subscription: sub.toJSON(),
    label: deviceLabel(),
  })
  return { id: data.id }
}

/** Unsubscribe this device, and drop the row wherever it still exists. */
export async function disablePush(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration().catch(() => null)
  const sub = await reg?.pushManager.getSubscription().catch(() => null)
  if (sub) {
    await api.post('/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {})
    await sub.unsubscribe().catch(() => {})
  }
}

/** Drop another device's subscription from the server (it keeps its own). */
export const forgetPushDevice = async (id: string): Promise<void> => {
  await api.post('/push/unsubscribe', { id })
}
