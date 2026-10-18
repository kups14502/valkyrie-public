import { Suspense, lazy, useLayoutEffect } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { applyFont, applyPalette, storedFont, storedMode } from './kit/theme'
import { V2Shell, type LegacyMap, type ScreenDef } from './kit/shell'
import Dashboard from './screens/Dashboard'
import Claude from './screens/Claude'
import Lights from './screens/Lights'
import Media from './screens/Media'
import System from './screens/System'
import { SettingsScreen } from './screens/Settings'
import './v2.css'

// AI > Terminal preview (/m/ai/skin): Claude Code in a Valkyrie skin, playing a
// recorded sample. Its own chunk, since it carries xterm.
const Skin = lazy(() => import('./screens/Skin'))

// Valkyrie v2: the phone-first shell, mounted by src/App.tsx at /m/* outside
// the classic Shell (no classic header, menu or player bar). URLs are
// /m/<screen>/<sub>, plus /m/settings (the strip's gear). Every global rule in
// v2.css is keyed on html[data-v2], which is set only while this is mounted,
// so the classic pages never change.

// Valkyrie's real sections, in tab order. No screen forces a mode.
const SCREENS: ScreenDef[] = [
  // Dashboard draws its own 3D floor (the hero's WireScene), so the shell's 2D floor fades out there
  { id: 'dashboard', label: 'Dashboard', Component: Dashboard, floor: false },
  // list screens keep the floor faint so rows never sit on bright dots
  { id: 'ai', label: 'AI', subs: [{ id: 'sessions', label: 'Sessions' }, { id: 'projects', label: 'Projects' }], Component: Claude, floor: 'faint' },
  // Lights draws its own full-page 3D floor under the room
  { id: 'lights', label: 'Lights', Component: Lights, floor: false },
  {
    id: 'media',
    label: 'Media',
    subs: [
      { id: 'dashboard', label: 'Dashboard' },
      { id: 'movies', label: 'Movies' },
      { id: 'shows', label: 'Shows' },
      { id: 'music', label: 'Music' },
      { id: 'requests', label: 'Requests' },
    ],
    Component: Media,
    floor: 'faint',
  },
  { id: 'system', label: 'System', subs: [{ id: 'hosts', label: 'Hosts' }, { id: 'services', label: 'Services' }, { id: 'trades', label: 'Trades' }], Component: System, floor: 'faint' },
]

// Old URLs (bookmarks, the home screen icon, screens still saying go('claude')) land on the new tabs
const LEGACY: LegacyMap = (screen, sub) => {
  if (screen === 'home') return sub === 'settings' ? 'settings' : 'dashboard'
  if (screen === 'claude') return sub ? `ai/${sub}` : 'ai'
  return null
}

// index.html loads JetBrains Mono (400 to 700); Settings > Font: Sans needs Inter Tight
const INTER_TIGHT = 'https://fonts.googleapis.com/css2?family=Inter+Tight:wght@300;400;500;600;700&display=swap'

/** html[data-v2] and the stored scheme, font and density, painted before the first frame. */
function useV2Document() {
  useLayoutEffect(() => {
    const root = document.documentElement
    root.dataset.v2 = ''
    // the first frames paint the stored scheme without a morph
    root.dataset.boot = ''
    applyPalette(storedMode())
    applyFont(storedFont())
    try {
      const density = localStorage.getItem('v2.density')
      if (density) root.dataset.density = density
    } catch { /* storage unavailable */ }
    if (!document.querySelector(`link[href="${INTER_TIGHT}"]`)) {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = INTER_TIGHT
      document.head.appendChild(link)
    }
    const endBoot = () => { delete root.dataset.boot }
    const timers: number[] = [window.setTimeout(endBoot, 2500)]
    const onLoad = () => { timers.push(window.setTimeout(endBoot, 350)) }
    if (document.readyState === 'complete') onLoad()
    else window.addEventListener('load', onLoad, { once: true })
    return () => {
      timers.forEach((t) => window.clearTimeout(t))
      window.removeEventListener('load', onLoad)
      delete root.dataset.v2
      delete root.dataset.boot
    }
  }, [])
}

function V2() {
  return <V2Shell screens={SCREENS} initial="dashboard" settings={SettingsScreen} legacy={LEGACY} />
}

export default function V2App() {
  useV2Document()
  return (
    <Routes>
      <Route index element={<Navigate to="dashboard" replace />} />
      <Route path="ai/skin" element={<Suspense fallback={<div className="fixed inset-0 bg-black" />}><Skin /></Suspense>} />
      <Route path=":screen/:sub?" element={<V2 />} />
    </Routes>
  )
}
