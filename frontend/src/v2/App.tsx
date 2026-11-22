import { Suspense, lazy, useEffect, useLayoutEffect } from 'react'
import { Navigate, Route, Routes, useNavigate, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { applyFont, applyPalette, storedFont, storedMode } from './kit/theme'
import { V2Shell, desktopWindow, type LegacyMap, type ScreenDef, type ScreenProps } from './kit/shell'
import { Palette } from './kit/palette'
import { FindBar } from './kit/find'
import { ContextMenuHost } from './kit/menu'
import { Tooltips } from './kit/tooltip'
import { useDropGuard } from './kit/dropGuard'
import { RavenBadge, RavenFab, RavenQuick } from './kit/raven'
import { isWidgetPage } from '../lib/ravenWidget'
import { toast } from './kit/ui'
import { fetchSessionList, fetchTermSessions } from '../lib/api'
import { v2TermPath } from '../lib/term'
import { useProfile } from '../lib/deviceMode'
import { featureRoutes, useFeatureScreens, withFeatures } from '../features/apply'
import Dashboard from './screens/Dashboard'
import Today from './screens/Today'
import Hotkeys from './screens/Hotkeys'
import Claude from './screens/Claude'
import Lights from './screens/Lights'
import Media from './screens/Media'
import System from './screens/System'
import { SettingsScreen } from './screens/Settings'
import { CalendarPage } from './screens/Calendar'
import MealsPage from './screens/Meals'
import InboxPage from './screens/Inbox'
import TasksPage from './screens/Tasks'
import Messages from './screens/Messages'
import Desk, { DeskBadge } from './screens/Desk'
import './v2.css'
import './kit/chrome.css'

// AI > Terminal preview (/m/ai/skin): Claude Code in a Valkyrie skin, playing a
// recorded sample. Its own chunk, since it carries xterm.
const Skin = lazy(() => import('./screens/Skin'))
// AI > a session (/m/ai/term/<name>): the real tmux pane in that skin. Every
// v2 entry point still asks for /sessions/terminal?s=<name>; src/App.tsx sends
// a v2 user (or the iPhone profile) here. Its own chunk, like the preview.
const Term = lazy(() => import('./screens/Term'))
// Pop-out windows (kit/windows.ts openDetached): one project or one session in
// a window of its own, no tab bar, the status strip as its title bar. The
// session one is the terminal above in its standalone mode.
const ProjectWindow = lazy(() => import('./screens/ProjectWindow'))
// The desktop app's Raven widget on the desktop (lib.rs opens it as raven-widget).
const RavenWidget = lazy(() => import('./screens/RavenWidget'))

// Valkyrie v2: the phone-first shell, mounted by src/App.tsx at /m/* outside
// the classic Shell (no classic header, menu or player bar). URLs are
// /m/<screen>/<sub>, plus /m/settings (the strip's gear). Every global rule in
// v2.css is keyed on html[data-v2], which is set only while this is mounted,
// so the classic pages never change.

// The Dashboard tab: Overview (the dashboard itself, still where the app opens), Today (the day
// in one place: capture, the brief, schedule, due tasks, unread inbox, busy sessions) and, on the
// iPad only, Hotkeys (thor's keyboard actions as buttons, for the iPad under the main monitor).
function DashboardTab(p: ScreenProps) {
  if (p.sub === 'today') return <Today active={p.active} />
  if (p.sub === 'hotkeys') return <Hotkeys active={p.active} />
  return <Dashboard {...p} />
}

const DASH_SUBS = [{ id: 'overview', label: 'Overview' }, { id: 'today', label: 'Today' }]
const DASH_SUBS_IPAD = [...DASH_SUBS, { id: 'hotkeys', label: 'Hotkeys' }]

// Valkyrie's real sections, in tab order. No screen forces a mode. Features
// (src/features) add their tabs in place: SCREENS is this list with theirs.
const BASE_SCREENS: ScreenDef[] = [
  // Overview draws its own 3D floor (the hero's WireScene), so the shell's 2D floor fades out there;
  // Today and Hotkeys are list screens and keep it faint
  {
    id: 'dashboard',
    label: 'Dashboard',
    subs: DASH_SUBS,
    Component: DashboardTab,
    floor: (sub) => (sub === 'today' || sub === 'hotkeys' ? 'faint' : false),
  },
  // the one conversation with Raven, his assistant (lib/raven on the backend); the badge counts Raven's unread.
  // No dot floor: dots behind the text made it hard to read. No bottom room either: the composer is pinned to the bottom edge.
  { id: 'raven', label: 'Raven', Component: Messages, floor: false, foot: false, badge: RavenBadge },
  // his Claude sessions in tabs, like Windows Terminal: one to three columns, each a strip of tabs over the active
  // session's terminal, filling the screen (no corner button over it); the badge counts tabs done and not opened
  { id: 'desk', label: 'Desk', Component: Desk, floor: 'faint', foot: false, badge: DeskBadge },
  // list screens keep the floor faint so rows never sit on bright dots; AI > Usage holds every account's 5h and week windows
  { id: 'ai', label: 'AI', subs: [{ id: 'sessions', label: 'Sessions' }, { id: 'projects', label: 'Projects' }, { id: 'usage', label: 'Usage' }], Component: Claude, floor: 'faint' },
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
  { id: 'system', label: 'System', subs: [{ id: 'hosts', label: 'Hosts' }, { id: 'trades', label: 'Trades' }, { id: 'services', label: 'Services' }], Component: System, floor: 'faint' },
]
const SCREENS = withFeatures(BASE_SCREENS)

// Old URLs (bookmarks, the home screen icon, screens still saying go('claude')) land on the new tabs.
// The Car tab is gone (the Tesla app has the controls): the car stays on System > Hosts. Messages is
// the Raven tab now; its old links (/m/messages?compose=1, older pushes) keep their query.
const LEGACY: LegacyMap = (screen, sub) => {
  if (screen === 'home') return sub === 'settings' ? 'settings' : sub === 'today' ? 'dashboard/today' : 'dashboard'
  if (screen === 'claude') return sub ? `ai/${sub}` : 'ai'
  if (screen === 'car') return 'system/hosts'
  if (screen === 'messages') return 'raven'
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
    // the desktop app's frameless window: the strip is its title bar (v2.css html[data-v2win])
    if (desktopWindow()) root.dataset.v2win = 'tauri'
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
      delete root.dataset.v2win
    }
  }, [])
}

const SCREENS_IPAD: ScreenDef[] = SCREENS.map((s) => (s.id === 'dashboard' ? { ...s, subs: DASH_SUBS_IPAD } : s))

/** The tabs for this device: the iPad's Dashboard also has Hotkeys, and features drop tabs outside their profiles. */
function useScreens(): ScreenDef[] {
  const device = useProfile().resolved
  return useFeatureScreens(device === 'ipad' ? SCREENS_IPAD : SCREENS, device)
}

const FEATURE_ROUTES = featureRoutes()

function V2({ screens }: { screens: ScreenDef[] }) {
  return <V2Shell screens={screens} initial="dashboard" settings={SettingsScreen} legacy={LEGACY} corner={<RavenFab />} />
}

const BASE_AI = '/m/ai'

/**
 * /m/ai/open?label=<name>: a "Session waiting" or "Session complete" alert
 * tapped on a v2 device (public/push-sw.js). The alert names the session the
 * way the board does (its title), never its tmux pane, so find the pane: one
 * labeled with that name, else one running a board session of that title.
 * Found, its terminal opens; not found (it runs in a window on its host, or
 * it ended), AI > Sessions opens with a line saying so. Black meanwhile.
 */
function OpenFromAlert() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const label = (params.get('label') ?? '').trim()
  useEffect(() => {
    let gone = false
    const same = (a: string) => a.trim().replace(/\s+/g, ' ').toLowerCase() === label.replace(/\s+/g, ' ').toLowerCase()
    void (async () => {
      let to = `${BASE_AI}/sessions`
      if (label) {
        try {
          const panes = (await qc.fetchQuery({ queryKey: ['term', 'sessions'], queryFn: fetchTermSessions, staleTime: 5_000 })).filter((t) => !t.dead)
          let pane = panes.find((t) => same(t.label))
          if (!pane) {
            const board = await fetchSessionList()
            const ids = new Set(board.installed ? board.sessions.filter((s) => same(s.title)).map((s) => s.sessionId) : [])
            pane = panes.find((t) => ids.has(t.sessionId) || (t.mode === 'resume' && ids.has(t.target)))
          }
          if (pane) to = v2TermPath(pane.name)
          else toast(`${label}: not open in a terminal`, { ms: 4000 })
        } catch {
          toast(`Could not look up ${label}`, { ms: 4000 })
        }
      }
      if (!gone) navigate(to, { replace: true })
    })()
    return () => { gone = true }
  }, [label, navigate, qc])
  return <div className="fixed inset-0 bg-black" />
}


export default function V2App() {
  useV2Document()
  useDropGuard()
  const screens = useScreens()
  const widget = isWidgetPage()
  return (
    <>
      <Routes>
        <Route index element={<Navigate to="dashboard" replace />} />
        <Route path="ai/skin" element={<Suspense fallback={<div className="fixed inset-0 bg-black" />}><Skin /></Suspense>} />
        <Route path="ai/term/:name" element={<Suspense fallback={<div className="fixed inset-0 bg-black" />}><Term /></Suspense>} />
        {/* never a terminal without a name: no session is ever picked for you */}
        <Route path="ai/term" element={<Navigate to="/m/ai/sessions" replace />} />
        <Route path="ai/open" element={<OpenFromAlert />} />
        <Route path="w/project/:id" element={<Suspense fallback={<div className="fixed inset-0 bg-black" />}><ProjectWindow /></Suspense>} />
        <Route path="w/term/:name" element={<Suspense fallback={<div className="fixed inset-0 bg-black" />}><Term standalone /></Suspense>} />
        <Route path="w/raven" element={<Suspense fallback={null}><RavenWidget /></Suspense>} />
        <Route path="calendar" element={<CalendarPage />} />
        <Route path="meals" element={<MealsPage />} />
        <Route path="inbox" element={<InboxPage />} />
        <Route path="tasks" element={<TasksPage />} />
        {FEATURE_ROUTES.map((r) => <Route key={r.path} path={r.path} element={r.element} />)}
        <Route path=":screen/:sub?" element={<V2 screens={screens} />} />
      </Routes>
      {/* Ctrl+K on every v2 screen: the tabs, Settings and a session. The Raven widget is Raven alone. */}
      {!widget && <Palette screens={screens} />}
      {/* Raven's quick sheet: the corner button, Ctrl+Shift+Space and the palette open it on every v2 screen */}
      {!widget && <RavenQuick />}
      {/* the app's own find bar (Ctrl+F), context menu (right click, a long press) and tooltips, in place of the browser's */}
      {!widget && <FindBar />}
      <ContextMenuHost />
      <Tooltips />
    </>
  )
}
