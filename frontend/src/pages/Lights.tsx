import { useMemo } from 'react'
import { Card } from '../components/Card'
import { AllLightsControl, LightControl } from '../components/LightControl'
import { useLightsControl } from '../lib/lights'

export default function Lights() {
  const {
    lights, mutation, all, anyOn, availableTargets, litTargets, roomPct,
    updateOne, bulk, bulkBrightness, bulkPreset,
  } = useLightsControl()

  // Plugged-in bulbs first, so two live lights don't drown in dead cards.
  const ordered = useMemo(
    () => [...all].sort((a, b) => Number(a.unavailable) - Number(b.unavailable)),
    [all],
  )

  return (
    <div className="space-y-6">
      <div>
        <div className="text-[9px] uppercase tracking-[0.35em] text-[var(--color-text-faint)]">// env</div>
        <h1 className="mt-1 text-2xl font-bold tracking-[0.12em]" style={{ color: 'var(--color-accent)', textShadow: '0 0 16px var(--color-accent)' }}>
          lights<span className="cursor-blink">_</span>
        </h1>
      </div>

      {lights.isLoading && !lights.data ? (
        <Card><div className="text-sm text-[var(--color-text-dim)]">Loading…</div></Card>
      ) : lights.error ? (
        <Card><div className="text-sm text-[var(--color-danger)]">Home Assistant unreachable</div></Card>
      ) : (
        <>
          {all.length > 0 && availableTargets.length === 0 && (
            <Card>
              <div className="space-y-1 text-sm">
                <div className="text-[var(--color-warning)]">All lights unavailable</div>
                <div className="text-[var(--color-text-dim)]">
                  Home Assistant can't reach any bulb. If some are plugged in, the Cync
                  integration likely needs re-authentication (HA → Settings → Devices &
                  Services → Cync).
                </div>
              </div>
            </Card>
          )}

          {availableTargets.length > 1 && (
            <AllLightsControl
              count={availableTargets.length}
              litCount={litTargets.length}
              anyOn={anyOn}
              pct={roomPct}
              onToggleAll={bulk}
              onBrightness={bulkBrightness}
              onPreset={bulkPreset}
            />
          )}

          <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
            {ordered.map((light) => (
              <LightControl key={light.entity_id} light={light} onUpdate={updateOne} />
            ))}
          </div>
        </>
      )}

      {mutation.error && (
        <div className="border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 text-xs text-[var(--color-danger)]">
          {(mutation.error as Error).message}
        </div>
      )}
    </div>
  )
}
