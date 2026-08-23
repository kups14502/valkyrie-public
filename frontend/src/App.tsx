import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { BrowserRouter, Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { LayoutDashboard, Lightbulb, Menu, X, TrendingUp, Search,
  Film, Clapperboard, Tablet, RefreshCw, Settings as SettingsIcon, Smartphone, Terminal as TerminalIcon,
} from 'lucide-react'
import { LogOut } from 'lucide-react'
import { ThemePicker, applyAccent } from './components/ThemePicker'
import { setupZoom } from './lib/zoom'
import { TitleBar } from './components/TitleBar'
import { WindowControls } from './components/TauriTitleBar'
import { UpdateAlarm } from './components/UpdateAlarm'
import { CommandPalette, openCommandPalette } from './components/CommandPalette'
import { ErrorBoundary } from './components/ErrorBoundary'
import { AuthGate } from './components/AuthGate'
import { clearToken, setAuthSkipped, isTauri } from './lib/auth'
import { useProfile } from './lib/deviceMode'
import Dashboard from './pages/Dashboard'

const Lights = lazy(() => import('./pages/Lights'))
const Vault = lazy(() => import('./pages/Vault'))
const TradeBot = lazy(() => import('./pages/TradeBot'))
const SlopFactory = lazy(() => import('./pages/SlopFactory'))
const Services = lazy(() => import('./pages/Services'))
const Activity = lazy(() => import('./pages/Activity'))
const Plex = lazy(() => import('./pages/Plex'))
const Pad = lazy(() => import('./pages/Pad'))
const Settings = lazy(() => import('./pages/Settings'))
const Phone = lazy(() => import('./pages/Phone'))
const Sessions = lazy(() => import('./pages/Sessions'))

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchInterval: 15_000,
      staleTime: 10_000,
      refetchOnWindowFocus: false,
    },
  },
})

function PageFallback() {
  return (
    <div className="flex h-40 items-center justify-center text-xs uppercase tracking-[0.3em] text-[var(--color-text-faint)]">
      &gt; loading<span className="cursor-blink">_</span>
    </div>
  )
}

// Services, Vault, and Activity were pulled from the nav (unused day to day);
// they stay routable and remain in the Ctrl+K palette. Seven items now fit one
// row at lg, so there is no orphaned second row.
const navItems = [
  { to: '/dashboard', label: 'dashboard', icon: LayoutDashboard },
  { to: '/sessions', label: 'sessions', icon: TerminalIcon },
  { to: '/plex', label: 'plex', icon: Clapperboard },
  { to: '/lights', label: 'lights', icon: Lightbulb },
  { to: '/trade', label: 'trades', icon: TrendingUp },
  { to: '/slop', label: 'slop', icon: Film },
  { to: '/settings', label: 'settings', icon: SettingsIcon },
]

// The home screens are per form factor, so only show the one that belongs to
// this device: an iPad has no use for the phone dashboard, and a desktop has no
// use for either.
function navFor(resolved: 'desktop' | 'iphone' | 'ipad') {
  if (resolved === 'ipad') return [...navItems, { to: '/pad', label: 'ipad home', icon: Tablet }]
  if (resolved === 'iphone') return [...navItems, { to: '/phone', label: 'phone home', icon: Smartphone }]
  return navItems
}

const BUILD_ID = import.meta.env.VITE_BUILD_ID || 'dev'

// Resolve the app version. In the desktop/mobile app we ask Tauri for the real
// installed version at runtime (authoritative, reflects auto-updates). On
// web/PWA we show the release version baked in at build time from
// tauri.conf.json (see vite.config.ts) plus the short build id, so it's always
// a real version — never "dev" — and distinct deploys stay distinguishable.
function useAppVersion(): string {
  const webVersion = `v${__APP_VERSION__}${BUILD_ID && BUILD_ID !== 'dev' ? ` · ${BUILD_ID.slice(0, 7)}` : ''}`
  const [version, setVersion] = useState<string>(isTauri() ? '' : webVersion)
  useEffect(() => {
    if (!isTauri()) return
    void import('@tauri-apps/api/app')
      .then(({ getVersion }) => getVersion())
      .then((v) => setVersion(`v${v}`))
      .catch(() => setVersion(`v${__APP_VERSION__}`))
  }, [])
  return version
}

function MobileMenu({ onClose }: { onClose: () => void }) {
  const location = useLocation()
  const items = navFor(useProfile().resolved)
  return (
    <div className="border-b border-[var(--color-border)] bg-[var(--color-bg)]">
      <div className="mx-auto max-w-[1600px] px-4 py-3 space-y-3 sm:px-6">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
          {items.map(({ to, label, icon: Icon }) => {
            const isActive = location.pathname === to || (to !== '/dashboard' && location.pathname.startsWith(to))
            return (
              <NavLink
                key={to}
                to={to}
                onClick={onClose}
                className={`flex items-center gap-2 whitespace-nowrap rounded-[3px] border px-3 py-2 text-xs uppercase tracking-[0.12em] transition-colors ${
                  isActive
                    ? 'border-[var(--color-accent)]/70 bg-[rgba(0,255,65,0.12)] text-[var(--color-accent)]'
                    : 'border-[var(--color-border)] text-[var(--color-text-dim)] hover:border-[var(--color-accent)]/40 hover:text-[var(--color-text)]'
                }`}
                style={isActive ? { boxShadow: '0 0 10px rgba(0,255,65,0.22)', textShadow: '0 0 8px var(--color-accent)' } : {}}
              >
                <Icon size={12} className="shrink-0" />
                <span>{label}</span>
              </NavLink>
            )
          })}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-[var(--color-border)] pt-3">
          <button
            type="button"
            onClick={() => { onClose(); openCommandPalette() }}
            title="Search — jump to any page (Ctrl+K)"
            className="inline-flex items-center gap-2 border border-[var(--color-border)] px-3 py-2 text-xs uppercase tracking-[0.12em] text-[var(--color-text-dim)] hover:border-[var(--color-accent)]/60 hover:text-[var(--color-accent)]"
          >
            <Search size={12} /> search
            <kbd className="ml-1 border border-[var(--color-border)] px-1 py-0.5 text-[8px] tracking-[0.1em] text-[var(--color-text-faint)]">ctrl k</kbd>
          </button>
          <div className="flex items-center gap-2">
            <ThemePicker />
            {/* Added to the home screen, iOS gives no address bar, and the shell
                sets html{overflow:hidden} so pull-to-refresh can't fire either —
                this is the only way to force the newest build in that mode. */}
            <button
              type="button"
              onClick={() => window.location.reload()}
              title="Reload to get the latest build"
              className="inline-flex items-center gap-2 border border-[var(--color-border)] px-3 py-2 text-xs uppercase tracking-[0.12em] text-[var(--color-text-dim)] hover:border-[var(--color-accent)]/60 hover:text-[var(--color-accent)] active:border-[var(--color-accent)]"
            >
              <RefreshCw size={12} /> reload
            </button>
            <button
              type="button"
              onClick={() => { onClose(); logout() }}
              className="inline-flex items-center gap-2 border border-[var(--color-border)] px-3 py-2 text-xs uppercase tracking-[0.12em] text-[var(--color-text-dim)] hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]"
            >
              <LogOut size={12} /> sign out
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// One shared width for every page. Fluid below the cap so it scales with the
// device, then centered on very wide screens so line lengths stay sane. Every
// tabbed route uses this, so nothing is full-bleed while its neighbor sits in a
// narrow column any more. The device home screens (pad/phone) keep their own
// full-screen layouts.
function PageContainer({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-[1800px]">{children}</div>
}

function Shell() {
  const [menuOpen, setMenuOpen] = useState(false)
  const location = useLocation()
  const version = useAppVersion()

  // The device profile decides what "home" is: the pad screen on a phone or
  // tablet, the full dashboard on a desktop. The header button hides while
  // you're already there.
  const profile = useProfile()
  const home = profile.home
  const atHome = location.pathname === home
  const onHomeScreen = home !== '/dashboard'

  // The dashboard opens with the nav menu already down (as a launcher); it
  // stays closeable, and closing it while on the dashboard sticks because this
  // only fires when the route actually becomes /dashboard. Pad mode has its own
  // big tiles, so it doesn't need the menu auto-opened.
  const onDashboard = location.pathname === '/dashboard'
  useEffect(() => { if (onDashboard) setMenuOpen(true) }, [onDashboard])

  return (
    <div className="flex h-full max-w-full flex-col overflow-x-hidden bg-[var(--color-bg)] text-[var(--color-text)]">
      <TitleBar />
      {/* The header doubles as the frameless window's draggable title bar in the app.
          shrink-0 so it keeps its height; <main> below is the scroll container. */}
      <header className="relative z-10 shrink-0 select-none border-b border-[var(--color-border)] bg-[var(--color-bg)]">
        {/* Full-area drag layer: grab anywhere in the header to move the frameless
            window (double-click toggles maximize). The interactive controls below
            re-enable pointer events so their clicks aren't swallowed by the drag. */}
        {/* In the app, reserve the window-controls strip (3 × 44px buttons, see
            TauriTitleBar) so the menu button never slides underneath it. */}
        <div className={`relative w-full py-0 ${isTauri() ? 'pl-4 pr-[140px] sm:pl-6' : 'px-4 sm:px-6'}`}>
          {/* Drag layer scoped to the toolbar row ONLY — not the dropdown menu
              below — and sits behind the controls so it never swallows clicks. */}
          <div data-tauri-drag-region aria-hidden className="pointer-events-auto absolute inset-0" />
          <div className="pointer-events-none relative">
            <div className="pointer-events-none flex items-center gap-3">
              {/* left cluster: brand + version */}
              <div className="flex shrink-0 items-center gap-2.5">
                <div
                  className="text-base font-bold tracking-widest"
                  style={{ color: 'var(--color-accent)', textShadow: '0 0 12px var(--color-accent)' }}
                >
                  VALKYRIE<span className="opacity-40">//</span>SYS<span className="cursor-blink">_</span>
                </div>
                {version && (
                  <span
                    title={`Valkyrie ${version}`}
                    className="shrink-0 rounded-sm border border-[var(--color-accent)]/60 bg-[rgba(0,255,65,0.12)] px-2 py-0.5 font-mono text-[11px] font-bold tracking-[0.12em] text-[var(--color-accent)]"
                    style={{ textShadow: '0 0 8px var(--color-accent)' }}
                  >
                    {version}
                  </span>
                )}
              </div>
              {/* Right cluster: update alarm (app only), quick dashboard, menu. */}
              <div className="pointer-events-none ml-auto flex items-center gap-2">
                <UpdateAlarm />
                {/* Quick jump home, shown only when you're not already there.
                    In iPad mode home is the pad screen. */}
                {!atHome && (
                  <NavLink
                    to={home}
                    aria-label={onHomeScreen ? 'Home screen' : 'Dashboard'}
                    title={onHomeScreen ? 'Go to your home screen' : 'Go to dashboard'}
                    className="pointer-events-auto p-2 text-[var(--color-text-dim)] transition hover:bg-[rgba(255,255,255,0.08)] hover:text-[var(--color-accent)]"
                  >
                    {onHomeScreen ? (profile.resolved === 'ipad' ? <Tablet size={16} /> : <Smartphone size={16} />) : <LayoutDashboard size={16} />}
                  </NavLink>
                )}
                {/* Pages live in the menu at every width — one consistent layout.
                    Borderless like the window controls so the top-right icon
                    cluster reads as one row. */}
                <button
                  type="button"
                  className="pointer-events-auto p-2 text-[var(--color-text-dim)] transition hover:bg-[rgba(255,255,255,0.08)] hover:text-[var(--color-text)]"
                  onClick={() => setMenuOpen((v) => !v)}
                  aria-label="Menu"
                >
                  {menuOpen ? <X size={16} /> : <Menu size={16} />}
                </button>
              </div>
            </div>
          </div>
          {/* Window controls live inside the toolbar row (not the header) so
              they pin to the top-right corner and keep the row's height instead
              of stretching down when the nav menu opens below. */}
          <WindowControls />
        </div>
        {menuOpen && <MobileMenu onClose={() => setMenuOpen(false)} />}
      </header>

      <main className="min-h-0 w-full flex-1 overflow-y-auto overflow-x-hidden px-3 py-5 sm:px-6 sm:py-8">
        <Suspense fallback={<PageFallback />}>
          {/* Per-route boundary: a crash in one page shows an inline error and
              keeps the nav usable; the key resets it when you navigate away. */}
          <ErrorBoundary compact key={location.pathname}>
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<PageContainer><Dashboard /></PageContainer>} />
            <Route path="/lights" element={<PageContainer><Lights /></PageContainer>} />
            <Route path="/sessions" element={<PageContainer><Sessions /></PageContainer>} />
            <Route path="/services" element={<PageContainer><Services /></PageContainer>} />
            <Route path="/vault" element={<PageContainer><Vault /></PageContainer>} />
            <Route path="/trade" element={<PageContainer><TradeBot /></PageContainer>} />
            <Route path="/slop" element={<PageContainer><SlopFactory /></PageContainer>} />
            <Route path="/activity" element={<PageContainer><Activity /></PageContainer>} />
            <Route path="/plex" element={<PageContainer><Plex /></PageContainer>} />
            <Route path="/pad" element={<Pad />} />
            <Route path="/settings" element={<PageContainer><Settings /></PageContainer>} />
            <Route path="/phone" element={<Phone />} />
          </Routes>
          </ErrorBoundary>
        </Suspense>
      </main>
      <CommandPalette />
    </div>
  )
}

function logout() {
  setAuthSkipped(false)
  clearToken()
}

export default function App() {
  // Apply the saved accent color immediately on launch so the correct color
  // is shown before the user opens the hamburger menu (ThemePicker mounts
  // lazily inside MobileMenu, causing a green flash without this).
  useEffect(() => {
    applyAccent(localStorage.getItem('valkyrie-accent') ?? localStorage.getItem('mc-accent') ?? '#00ff41')
  }, [])
  // Restore saved UI zoom and enable Ctrl/Cmd +/-/0 to resize the whole UI.
  useEffect(() => setupZoom(), [])
  return (
    <QueryClientProvider client={queryClient}>
      <AuthGate>
        <BrowserRouter>
          <Shell />
        </BrowserRouter>
      </AuthGate>
    </QueryClientProvider>
  )
}
