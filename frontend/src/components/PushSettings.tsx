import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, BellOff, Send, Trash2 } from 'lucide-react'
import {
  currentSubscriptionId, disablePush, enablePush, fetchPushStatus, forgetPushDevice,
  isStandalone, pushBlockedReason, sendPushTest, type PushSubscriptionInfo,
} from '../lib/push'

// The notifications panel in Settings.
//
// Enabling push is per device, not per account: the subscription belongs to
// this browser's service worker. So the panel answers two questions at once,
// "is this phone on the list" and "what else is on the list", and the second
// one is what catches an old device still collecting alerts.

function ago(iso: string | null): string {
  if (!iso) return 'never'
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 90) return `${Math.round(s)}s ago`
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  if (s < 172800) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

function DeviceRow({ sub, mine, onForget }: {
  sub: PushSubscriptionInfo; mine: boolean; onForget: (id: string) => void
}) {
  return (
    <li className="flex items-center gap-3 border border-[var(--color-border)] px-3 py-2">
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-xs text-[var(--color-text)]">{sub.label || sub.service}</span>
          {mine && (
            <span className="text-[9px] uppercase tracking-[0.16em] text-[var(--color-accent)]">this device</span>
          )}
        </span>
        <span className="mt-0.5 block text-[10px] text-[var(--color-text-faint)]">
          added {ago(sub.createdAt)}, last delivered {ago(sub.lastOkAt)}
          {sub.failCount > 0 && `, ${sub.failCount} failed`}
        </span>
        {sub.lastError && (
          <span className="mt-0.5 block truncate font-mono text-[10px] text-[var(--color-warning)]">{sub.lastError}</span>
        )}
      </span>
      <button
        type="button"
        onClick={() => onForget(sub.id)}
        aria-label={`forget ${sub.label || 'device'}`}
        className="shrink-0 p-2 text-[var(--color-text-faint)] hover:text-[var(--color-danger)]"
      >
        <Trash2 size={14} />
      </button>
    </li>
  )
}

export function PushSettings() {
  const qc = useQueryClient()
  const [mineId, setMineId] = useState<string | null>(null)
  const [busy, setBusy] = useState<'' | 'enable' | 'disable' | 'test'>('')
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const status = useQuery({ queryKey: ['push', 'status'], queryFn: fetchPushStatus, retry: 1 })
  // Recomputed after every change: the browser, not the server, is the truth
  // about whether this device holds a subscription.
  const refreshMine = () => { void currentSubscriptionId().then(setMineId) }
  useEffect(refreshMine, [])

  const blocked = pushBlockedReason()
  const subs = status.data?.subscriptions ?? []
  const enabled = Boolean(mineId && subs.some((s) => s.id === mineId))

  const after = () => {
    refreshMine()
    void qc.invalidateQueries({ queryKey: ['push', 'status'] })
  }

  const run = async (kind: 'enable' | 'disable' | 'test', fn: () => Promise<unknown>) => {
    setBusy(kind); setError(null); setNote(null)
    try {
      await fn()
      if (kind === 'enable') setNote('Enabled on this device.')
      if (kind === 'test') setNote('Test sent. It lands even with the app closed.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'that did not work')
    } finally {
      setBusy('')
      after()
    }
  }

  return (
    <section className="panel p-4 sm:p-5">
      <h2 className="text-[11px] font-bold uppercase tracking-[0.22em]" style={{ color: 'var(--color-accent)', textShadow: '0 0 8px var(--color-accent)' }}>
        &gt; notifications
      </h2>
      <p className="mt-2 text-xs leading-relaxed text-[var(--color-text-dim)]">
        Valkyrie pushes to this device when a Claude session starts waiting on you. Tapping the
        alert opens the session board. Turned on per device, so the phone can be on while the
        desktop stays quiet.
      </p>

      {status.data && !status.data.configured && (
        <p className="mt-3 border border-[var(--color-warning)]/40 px-3 py-2 text-[11px] text-[var(--color-warning)]">
          The server has no VAPID keys set, so nothing can be delivered yet.
        </p>
      )}

      {blocked ? (
        <p className="mt-3 border border-[var(--color-border)] px-3 py-2 text-[11px] leading-relaxed text-[var(--color-text-dim)]">
          {blocked}
        </p>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy !== '' || !status.data?.configured}
            onClick={() => (enabled
              ? void run('disable', disablePush)
              : void run('enable', enablePush))}
            className={`inline-flex min-h-12 items-center gap-2 border px-5 text-xs uppercase tracking-[0.16em] disabled:opacity-40 ${
              enabled
                ? 'border-[var(--color-accent)]/70 text-[var(--color-accent)]'
                : 'border-[var(--color-border)] text-[var(--color-text-dim)] hover:border-[var(--color-accent)]/60 hover:text-[var(--color-accent)]'
            }`}
          >
            {enabled ? <BellOff size={14} /> : <Bell size={14} />}
            {busy === 'enable' ? 'enabling...' : busy === 'disable' ? 'turning off...' : enabled ? 'turn off here' : 'enable on this device'}
          </button>

          <button
            type="button"
            disabled={busy !== '' || subs.length === 0}
            onClick={() => void run('test', sendPushTest)}
            className="inline-flex min-h-12 items-center gap-2 border border-[var(--color-border)] px-5 text-xs uppercase tracking-[0.16em] text-[var(--color-text-dim)] hover:border-[var(--color-accent)]/60 hover:text-[var(--color-accent)] disabled:opacity-40"
          >
            <Send size={14} /> {busy === 'test' ? 'sending...' : 'send test'}
          </button>
        </div>
      )}

      {error && <p className="mt-3 text-[11px] leading-relaxed text-[var(--color-danger)]">{error}</p>}
      {note && <p className="mt-3 text-[11px] text-[var(--color-success)]">{note}</p>}

      {subs.length > 0 && (
        <>
          <div className="mt-4 text-[9px] uppercase tracking-[0.28em] text-[var(--color-text-faint)]">
            // subscribed devices
          </div>
          <ul className="mt-2 space-y-2">
            {subs.map((s) => (
              <DeviceRow
                key={s.id}
                sub={s}
                mine={s.id === mineId}
                onForget={(id) => { void forgetPushDevice(id).then(after) }}
              />
            ))}
          </ul>
        </>
      )}

      {!blocked && !isStandalone() && (
        <p className="mt-3 text-[10px] leading-relaxed text-[var(--color-text-faint)]">
          Running in a browser tab. Add Valkyrie to the Home Screen and enable it there too, or the
          alerts stop when the tab is closed.
        </p>
      )}
    </section>
  )
}
