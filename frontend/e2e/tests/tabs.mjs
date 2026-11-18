// The v2 tab bar the tests expect, per e2e device: the shared tabs with the
// ones features add (extra.mjs) in place.

import { extraTabs } from './extra.mjs'

const BASE_TABS = ['Dashboard', 'Messages', 'AI', 'Lights', 'Car', 'Media', 'System']

/**
 * The base list with each extra placed right after the item whose key is its
 * anchor; extras sharing an anchor keep their order, and one with no anchor in
 * the list goes at the end (the app's own rule, src/features/apply.ts).
 */
export function placeAfter(base, extras, keyOf, anchorOf) {
  const out = [...base]
  const placed = new Map()
  for (const e of extras) {
    const a = anchorOf(e)
    const i = a === undefined ? -1 : out.findIndex((x) => keyOf(x) === a)
    if (i < 0) {
      out.push(e)
      continue
    }
    const n = placed.get(a) ?? 0
    out.splice(i + 1 + n, 0, e)
    placed.set(a, n + 1)
  }
  return out
}

/** The tab labels in order on an e2e device ('phone', 'ipad', 'desktop', ...). */
export function tabsFor(device) {
  const extras = extraTabs.filter((x) => !x.devices || x.devices.includes(device))
  return placeAfter(BASE_TABS, extras, (x) => (typeof x === 'string' ? x : x.label), (x) => x.after).map((x) => (typeof x === 'string' ? x : x.label))
}
