import type { ComponentType, ReactElement } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { ScreenDef } from '../v2/kit/shell'
import type { IconRef } from '../v2/kit/icons'
import type { DeviceMode } from '../lib/deviceMode'

// What a feature adds to the app. Features are listed in features/index.ts and
// placed by features/apply.ts, so no shared screen ever imports one. Keep the
// list itself light: anything heavy loads lazily from inside the feature, and
// the classic UI reads the same list.

/** A resolved device profile (lib/deviceMode.ts). */
export type Profile = Exclude<DeviceMode, 'auto'>

export type FeatureSub = { id: string; label: string }

/** A v2 tab. Icons are lucide components passed in, never new keys in kit/icons.tsx. */
export type FeatureScreen = ScreenDef & {
  /** the tab goes right after this tab id; unset or unknown puts it last */
  after?: string
  /** the profiles that get the tab; unset means every profile */
  profiles?: Profile[]
  /** live sub-tabs (for example one per configured line), replacing `subs` once they load */
  useSubs?: () => FeatureSub[] | undefined
}

/** A block on Dashboard > Today, after the shared blocks of its column. */
export type FeatureTodayBlock = { id: string; column: 'left' | 'right'; Component: ComponentType<{ active: boolean }> }

/** A v2 page outside the tabs, under /m/ (for example a pop-out window's page). */
export type FeatureRoute = { path: string; element: ReactElement }

/** A pop-out window kit/windows.ts opens for { kind: 'feature', id }, labeled feature-<id>. */
export type FeatureWindow = {
  id: string
  /** the window's page, a FeatureRoute under /m/w/ */
  route: string
  title: string
  size: { width: number; height: number; minWidth: number; minHeight: number }
  /** stays above other windows (the desktop app) */
  onTop?: boolean
  /** where the same thing lives in the main UI, for a device with no second window */
  inApp: string
}

/** A classic page (outside /m/), and where the classic and v2 menus list it. */
export type FeatureClassicPage = {
  path: string
  /** the chunk name src/App.tsx reloads by when a deploy replaced it */
  chunk: string
  load: () => Promise<{ default: ComponentType }>
  /** the classic menu (lib/nav.ts) and the phone and iPad home tiles */
  nav?: { label: string; icon: LucideIcon; tiles?: boolean }
  /** the headset's page list (lib/vr.ts), after the page at `after` */
  headset?: { label: string; after?: string }
  /** the v2 Ctrl+K palette's Classic group, after the page at `after` */
  palette?: { label: string; icon: IconRef; keys: string; after?: string }
  /** a row in v2 Settings, after Classic, with an Open link to the page */
  settings?: { label: string; value: string; icon: IconRef; aria: string }
}

export type FeatureDef = {
  id: string
  screens?: FeatureScreen[]
  today?: FeatureTodayBlock[]
  routes?: FeatureRoute[]
  windows?: FeatureWindow[]
  classic?: FeatureClassicPage[]
}
