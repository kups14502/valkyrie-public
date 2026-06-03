import { lazy, Suspense, useState, type ReactNode } from 'react'
import { BrowserRouter, Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { LayoutDashboard, Lightbulb, Server, KeyRound, Mail, Activity as ActivityIcon, Menu, X, Code2, TrendingUp } from 'lucide-react'
import { ThemePicker } from './components/ThemePicker'
import { TitleBar } from './components/TitleBar'
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

function MobileMenu({ onClose }: { onClose: () => void }) {
  const location = useLocation()
  return (
    <div className="sm:hidden border-b border-[var(--color-border)] bg-[var(--color-bg)]">
      <div className="mx-auto max-w-[1600px] px-4 py-3 space-y-3 sm:px-6">
        <div className="grid grid-cols-2 gap-2">
          {navItems.map(({ to, label, icon: Icon }) => {
            const isActive = location.pathname === to || (to !== '/dashboard' && location.pathname.startsWith(to))
            return (
              <NavLink
                key={to}
                to={to}
                onClick={onClose}
                className={`flex items-center gap-2 whitespace-nowrap border px-3 py-2 text-xs uppercase tracking-[0.12em] transition ${
                  isActive
                    ? 'border-[var(--color-accent)] text-[var(--color-accent)] bg-[rgba(0,255,65,0.07)]'
                    : 'border-[var(--color-border)] text-[var(--color-text-dim)]'
                }`}
                style={isActive ? { textShadow: '0 0 8px var(--color-accent)' } : {}}
              >
                <span className={isActive ? undefined : 'opacity-0'}>[</span>
                <Icon size={12} className="shrink-0" />
                <span>{label}</span>
                <span className={isActive ? undefined : 'opacity-0'}>]</span>
              </NavLink>
            )
          })}
        </div>
        <div className="flex items-center justify-between border-t border-[var(--color-border)] pt-3">
          <span className="text-[9px] uppercase tracking-[0.2em] text-[var(--color-text-faint)]">accent color</span>
          <ThemePicker />
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

  return (
    <div className="min-h-full max-w-full overflow-x-hidden bg-[var(--color-bg)] text-[var(--color-text)]">
      <TitleBar />
      <header className="sticky top-0 z-10 border-b border-[var(--color-border)] bg-[var(--color-bg)]">
        <div className="w-[calc(100vw-8px)] max-w-none px-4 py-3 sm:px-6">
          <div className="xl:grid xl:grid-cols-[minmax(280px,360px)_minmax(420px,1fr)_minmax(280px,420px)] xl:gap-6">
            <div className="flex items-center gap-3 xl:col-start-2">
              <div className="flex-1 min-w-0">
                <div
                  className="text-base font-bold tracking-widest"
                  style={{ color: 'var(--color-accent)', textShadow: '0 0 12px var(--color-accent)' }}
                >
                  BRNDN<span className="opacity-40">//</span>SYS<span className="cursor-blink">_</span>
                </div>
                <div className="hidden sm:block text-[9px] uppercase tracking-[0.28em] text-[var(--color-text-faint)] mt-0.5 truncate max-w-[180px]">
                  mc · build:{BUILD_ID.slice(0, 7)}
                </div>
              </div>
              {/* theme picker: hidden on mobile */}
              <div className="hidden sm:block"><ThemePicker /></div>
              {/* desktop nav */}
              <nav className="hidden sm:flex flex-1 items-center justify-end gap-0.5 font-mono">
                {navItems.map(({ to, label, icon: Icon }) => (
                  <NavLink
                    key={to}
                    to={to}
                    aria-label={label}
                    title={label}
                    className={({ isActive }) =>
                      `flex items-center gap-1.5 whitespace-nowrap px-3.5 py-1.5 text-xs uppercase tracking-[0.14em] transition border ${
                        isActive
                          ? 'border-[var(--color-accent)] text-[var(--color-accent)] bg-[rgba(0,255,65,0.07)]'
                          : 'border-transparent text-[var(--color-text-dim)] hover:border-[var(--color-border)] hover:text-[var(--color-text)]'
                      }`
                    }
                    style={({ isActive }) => isActive ? { textShadow: '0 0 8px var(--color-accent)' } : {}}
                  >
                    {({ isActive }) => (
                      <>
                        <span className={isActive ? undefined : 'opacity-0'}>[</span>
                        <Icon size={13} className="shrink-0" />
                        <span>{label}</span>
                        <span className={isActive ? undefined : 'opacity-0'}>]</span>
                      </>
                    )}
                  </NavLink>
                ))}
              </nav>
              {/* mobile hamburger */}
              <button
                type="button"
                className="sm:hidden border border-[var(--color-border)] p-2 text-[var(--color-text-dim)] transition hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
                onClick={() => setMenuOpen((v) => !v)}
                aria-label="Menu"
              >
                {menuOpen ? <X size={16} /> : <Menu size={16} />}
              </button>
            </div>
          </div>
        </div>
        {menuOpen && <MobileMenu onClose={() => setMenuOpen(false)} />}
      </header>

      <main className="w-[calc(100vw-8px)] max-w-none overflow-x-hidden px-3 py-5 sm:px-6 sm:py-8">
        <Suspense fallback={<PageFallback />}>
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
        </Suspense>
      </main>
    </div>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Shell />
      </BrowserRouter>
    </QueryClientProvider>
  )
}
