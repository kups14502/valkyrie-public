import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { BrowserRouter, Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { LayoutDashboard, Lightbulb, Server, KeyRound, Mail, Activity as ActivityIcon, Menu, X, Code2, TrendingUp } from 'lucide-react'
import { LogOut } from 'lucide-react'
import { ThemePicker, applyAccent } from './components/ThemePicker'
import { setupZoom } from './lib/zoom'
import { TitleBar } from './components/TitleBar'
import { WindowControls } from './components/TauriTitleBar'
import { ErrorBoundary } from './components/ErrorBoundary'
import { AuthGate } from './components/AuthGate'
import { clearToken, setAuthSkipped, isTauri } from './lib/auth'
import { runUpdateCheck } from './lib/updater'
import Dashboard from './pages/Dashboard'

const Lights = lazy(() => import('./pages/Lights'))
const Vault = lazy(() => import('./pages/Vault'))
const TradeBot = lazy(() => import('./pages/TradeBot'))
const Services = lazy(() => import('./pages/Services'))
const Emails = lazy(() => import('./pages/Emails'))
const Activity = lazy(() => import('./pages/Activity'))
const CodeDeck = lazy(() => import('./pages/CodeDeck'))

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
  { to: '/code-deck', label: 'code deck', icon: Code2 },
  { to: '/emails', label: 'emails', icon: Mail },
  { to: '/lights', label: 'lights', icon: Lightbulb },
  { to: '/trade', label: 'trades', icon: TrendingUp },
  { to: '/vault', label: 'vault', icon: KeyRound },
  { to: '/services', label: 'services', icon: Server },
  { to: '/activity', label: 'activity', icon: ActivityIcon },
]

const BUILD_ID = import.meta.env.VITE_BUILD_ID || 'dev'

// Resolve the app version: the real Tauri app version (e.g. "v0.1.9") when
// running in the app, otherwise the web build id.
function useAppVersion(): string {
  const [version, setVersion] = useState<string>(isTauri() ? '' : (BUILD_ID && BUILD_ID !== 'dev' ? `build ${BUILD_ID.slice(0, 7)}` : 'dev'))
  useEffect(() => {
    if (!isTauri()) return
    void import('@tauri-apps/api/app')
      .then(({ getVersion }) => getVersion())
      .then((v) => setVersion(`v${v}`))
      .catch(() => setVersion('app'))
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
        <div className="flex items-center justify-between border-t border-[var(--color-border)] pt-3">
          <span className="text-[9px] uppercase tracking-[0.2em] text-[var(--color-text-faint)]">accent color</span>
          <ThemePicker />
        </div>
        <button
          type="button"
          onClick={() => { onClose(); logout() }}
          className="flex w-full items-center justify-center gap-2 border border-[var(--color-border)] px-3 py-2 text-xs uppercase tracking-[0.12em] text-[var(--color-text-dim)] hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]"
        >
          <LogOut size={12} /> sign out
        </button>
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

  return (
    <div className="min-h-full max-w-full overflow-x-hidden bg-[var(--color-bg)] text-[var(--color-text)]">
      <TitleBar />
      {/* The header doubles as the frameless window's draggable title bar in the app. */}
      <header className="sticky top-0 z-10 select-none border-b border-[var(--color-border)] bg-[var(--color-bg)]">
        {/* Full-area drag layer: grab anywhere in the header to move the frameless
            window (double-click toggles maximize). The interactive controls below
            re-enable pointer events so their clicks aren't swallowed by the drag. */}
        <div className="relative w-full px-4 py-2.5 sm:px-6">
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
                    className="shrink-0 rounded-sm border border-[var(--color-accent)]/40 bg-[rgba(0,255,65,0.08)] px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-[0.1em] text-[var(--color-accent)]"
                  >
                    {version}
                  </span>
                )}
              </div>
              {/* Pages live in the menu at every width — one consistent layout. */}
              <button
                type="button"
                className="pointer-events-auto ml-auto border border-[var(--color-border)] p-2 text-[var(--color-text-dim)] transition hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
                onClick={() => setMenuOpen((v) => !v)}
                aria-label="Menu"
              >
                {menuOpen ? <X size={16} /> : <Menu size={16} />}
              </button>
              {/* Frameless-window controls (app only) — sit at the top-right corner. */}
              <WindowControls />
            </div>
          </div>
        </div>
        {menuOpen && <MobileMenu onClose={() => setMenuOpen(false)} />}
      </header>

      <main className="w-full overflow-x-hidden px-3 py-5 sm:px-6 sm:py-8">
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
            <Route path="/trade" element={<CenterPage><TradeBot /></CenterPage>} />
            <Route path="/emails" element={<CenterPage><Emails /></CenterPage>} />
            <Route path="/code-deck" element={<CodeDeck />} />
            <Route path="/activity" element={<CenterPage><Activity /></CenterPage>} />
          </Routes>
          </ErrorBoundary>
        </Suspense>
      </main>
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
    applyAccent(localStorage.getItem('mc-accent') ?? '#00ff41')
  }, [])
  // Restore saved UI zoom and enable Ctrl/Cmd +/-/0 to resize the whole UI.
  useEffect(() => setupZoom(), [])
  // Desktop app: check for updates once on launch (no-op on web).
  useEffect(() => { void runUpdateCheck() }, [])
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
