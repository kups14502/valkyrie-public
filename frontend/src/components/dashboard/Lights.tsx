import { useMemo } from 'react'
import { AllLightsControl } from '../LightControl'
import { ThorRgbControl } from '../ThorRgbControl'
import { lightColor, pctFromBrightness, useLightsControl } from '../../lib/lights'
import { Note, Section } from './Section'

// The room in one section: every light with its brightness and colors, each
// bulb as a one-click power toggle, then the desk relight. Per-bulb brightness
// and color live on the Lights page.
export function Lights() {
  const { lights, all, anyOn, availableTargets, litTargets, roomPct, updateOne, bulk, bulkBrightness, bulkPreset } = useLightsControl()
  const ordered = useMemo(() => [...all].sort((a, b) => Number(a.unavailable) - Number(b.unavailable)), [all])
  const onCount = all.filter((l) => l.on).length

  return (
    <Section title="lights" to="/lights" meta={all.length > 0 && `${onCount} of ${all.length} on`}>
      {lights.isLoading && !lights.data ? (
        <Note>loading…</Note>
      ) : lights.error ? (
        <Note tone="danger">Home Assistant unreachable</Note>
      ) : all.length > 0 && availableTargets.length === 0 ? (
        <Note tone="warning">All lights unavailable. Home Assistant can't reach any bulb.</Note>
      ) : all.length > 0 ? (
        <>
          {availableTargets.length > 1 && (
            <AllLightsControl
              size="dense"
              count={availableTargets.length}
              litCount={litTargets.length}
              anyOn={anyOn}
              pct={roomPct}
              onToggleAll={bulk}
              onBrightness={bulkBrightness}
              onPreset={bulkPreset}
            />
          )}
          <div className="mt-1.5 grid grid-cols-2 gap-x-4 border-t border-[var(--color-border)]/40 pt-1.5">
            {ordered.map((l) => {
              const pct = pctFromBrightness(l.brightness)
              const color = lightColor(l)
              return (
                <button
                  key={l.entity_id}
                  type="button"
                  disabled={l.unavailable}
                  onClick={() => updateOne(l.entity_id, { state: l.on ? 'off' : 'on' })}
                  title={l.unavailable ? `${l.name} is unavailable` : `Turn ${l.name} ${l.on ? 'off' : 'on'}`}
                  className="flex min-w-0 items-center gap-2 py-1 text-left transition hover:text-[var(--color-accent)] disabled:opacity-40"
                >
                  <span
                    className="h-2.5 w-2.5 shrink-0 border border-[var(--color-border-strong)]"
                    style={{ backgroundColor: l.on ? color : 'transparent', boxShadow: l.on ? `0 0 8px ${color}` : undefined }}
                    aria-hidden
                  />
                  <span className={`min-w-0 flex-1 truncate text-[12px] ${l.on ? 'text-[var(--color-text)]' : 'text-[var(--color-text-dim)]'}`}>{l.name}</span>
                  <span className="shrink-0 text-[11px] tabular-nums text-[var(--color-text-faint)]">
                    {l.unavailable ? 'n/a' : l.on ? (pct != null ? `${pct}%` : 'on') : 'off'}
                  </span>
                </button>
              )
            })}
          </div>
        </>
      ) : null}
      <div className="mt-1.5">
        <ThorRgbControl size="dense" />
      </div>
    </Section>
  )
}
