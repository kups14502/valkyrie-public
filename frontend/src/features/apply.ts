import { useMemo } from 'react'
import type { ScreenDef } from '../v2/kit/shell'
import type { IconRef } from '../v2/kit/icons'
import type { FeatureClassicPage, FeatureDef, FeatureRoute, FeatureScreen, FeatureSub, FeatureTodayBlock, FeatureWindow, Profile } from './types'
import { FEATURES } from './index'

// Places what features add (features/index.ts) into the shared lists: tabs,
// Today blocks, v2 routes, pop-out windows and classic pages. Generic: nothing
// here knows any one feature.

const all = <T>(pick: (f: FeatureDef) => T[] | undefined): T[] => FEATURES.flatMap((f) => pick(f) ?? [])

/**
 * The base list with each extra placed right after the item whose key is its
 * anchor. Extras sharing an anchor keep their order; one with no anchor, or an
 * anchor not in the list, goes at the end.
 */
export function placeAfter<T>(base: readonly T[], extras: readonly T[], keyOf: (x: T) => string, anchorOf: (x: T) => string | undefined): T[] {
  const out = [...base]
  const placed = new Map<string, number>()
  for (const e of extras) {
    const a = anchorOf(e)
    const i = a === undefined ? -1 : out.findIndex((x) => keyOf(x) === a)
    if (i < 0) {
      out.push(e)
      continue
    }
    const n = placed.get(a!) ?? 0
    out.splice(i + 1 + n, 0, e)
    placed.set(a!, n + 1)
  }
  return out
}

const SCREENS: FeatureScreen[] = all((f) => f.screens)
const BY_ID = new Map(SCREENS.map((s) => [s.id, s]))
const LIVE = SCREENS.some((s) => s.profiles || s.useSubs)
const SUB_HOOKS = SCREENS.filter((s) => s.useSubs)

/** The base tabs with every feature tab in place. */
export function withFeatures(base: ScreenDef[]): ScreenDef[] {
  return placeAfter<ScreenDef>(base, SCREENS, (s) => s.id, (s) => (s as FeatureScreen).after)
}

/**
 * The tabs for this device: a feature tab outside its profiles is left out, and
 * live sub-tabs replace the static ones once they load. With no such tab the
 * list comes back as given, so the shell sees the same array every render.
 */
export function useFeatureScreens(screens: ScreenDef[], device: Profile): ScreenDef[] {
  // FEATURES never changes while the app runs, so these hooks run in the same order on every render
  const subs: (FeatureSub[] | undefined)[] = SUB_HOOKS.map((s) => s.useSubs!())
  const key = JSON.stringify(subs)
  return useMemo(() => {
    if (!LIVE) return screens
    return screens.flatMap((def) => {
      const f = BY_ID.get(def.id)
      if (!f) return [def]
      if (f.profiles && !f.profiles.includes(device)) return []
      const i = SUB_HOOKS.indexOf(f)
      const live = i >= 0 ? subs[i] : undefined
      return [live?.length ? { ...def, subs: live } : def]
    })
    // subs is read through key, which changes exactly when one of them does
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screens, device, key])
}

/** Today's feature blocks for one column, in registry order. */
export const todayBlocks = (column: FeatureTodayBlock['column']): FeatureTodayBlock[] => all((f) => f.today).filter((b) => b.column === column)

/** Feature pages under /m/, mounted ahead of the tabs' catch-all route. */
export const featureRoutes = (): FeatureRoute[] => all((f) => f.routes)

/** A feature's pop-out window by id. */
export const featureWindow = (id: string): FeatureWindow | undefined => all((f) => f.windows).find((w) => w.id === id)

/** What features draw over every v2 screen (V2App mounts them beside the palette). */
export const featureOverlays = () => all((f) => f.overlays)

/** Classic pages features add (src/App.tsx routes, lib/nav.ts, lib/vr.ts, the home tiles, the v2 palette, Settings). */
export const classicPages = (): FeatureClassicPage[] => all((f) => f.classic)

/** The icon of the feature tab with this id, for anything a feature files under its own name (an inbox source). */
export const featureIcon = (id: string): IconRef | undefined => all((f) => f.screens).find((s) => s.id === id)?.icon
