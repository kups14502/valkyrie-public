import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { BrowserRouter, Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { LayoutDashboard, Lightbulb, Server, KeyRound, Activity as ActivityIcon, Menu, X, TrendingUp, Search } from 'lucide-react'
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
import Dashboard from './pages/Dashboard'

const Lights = lazy(() => import('./pages/Lights'))
const Vault = lazy(() => import('./pages/Vault'))
const TradeBot = lazy(() => import('./pages/TradeBot'))
const Services = lazy(() => import('./pages/Services'))
const Activity = lazy(() => import('./pages/Activity'))

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

const navItems = [
  { to: '/dashboard', label: 'dashboard', icon: LayoutDashboard },
  { to: '/lights', label: 'lights', icon: Lightbulb },
  { to: '/trade', label: 'trades', icon: TrendingUp },
  { to: '/vault', label: 'vault', icon: KeyRound },
  { to: '/services', label: 'services', icon: Server },
  { to: '/activity', label: 'activity', icon: ActivityIcon },
]

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
  return (
    <div className="border-b border-[var(--color-border)] bg-[var(--color-bg)]">
      <div className="mx-auto max-w-[1600px] px-4 py-3 space-y-3 sm:px-6">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
          {navItems.map(({ to, label, icon: Icon }) => {
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

function CenterPage({ children }: { children: ReactNode }) {
  return (
    <div className="xl:grid xl:grid-cols-[minmax(280px,360px)_minmax(420px,1fr)_minmax(280px,420px)] xl:gap-6">
      <div className="xl:col-start-2">{children}</div>
    </div>
  )
}

function Shell() {
  const [menuOpen, setMenuOpen] = useState(false)
  const location = useLocation()
  const version = useAppVersion()

  // The dashboard opens with the nav menu already down (as a launcher); it
  // stays closeable, and closing it while on the dashboard sticks because this
  // only fires when the route actually becomes /dashboard.
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
                {/* Quick jump home, shown only when you're not already there. */}
                {!onDashboard && (
                  <NavLink
                    to="/dashboard"
                    aria-label="Dashboard"
                    title="Go to dashboard"
                    className="pointer-events-auto p-2 text-[var(--color-text-dim)] transition hover:bg-[rgba(255,255,255,0.08)] hover:text-[var(--color-accent)]"
                  >
                    <LayoutDashboard size={16} />
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
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/lights" element={<CenterPage><Lights /></CenterPage>} />
            <Route path="/services" element={<CenterPage><Services /></CenterPage>} />
            <Route path="/vault" element={<CenterPage><Vault /></CenterPage>} />
            <Route path="/trade" element={<TradeBot />} />
            <Route path="/activity" element={<CenterPage><Activity /></CenterPage>} />
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
