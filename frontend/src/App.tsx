import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { LayoutDashboard, Lightbulb, Server, KeyRound, TrendingUp, Mail } from 'lucide-react'
import { ThemePicker } from './components/ThemePicker'
import Dashboard from './pages/Dashboard'

const Lights = lazy(() => import('./pages/Lights'))
const Vault = lazy(() => import('./pages/Vault'))
const TradeBot = lazy(() => import('./pages/TradeBot'))
const Services = lazy(() => import('./pages/Services'))
const Emails = lazy(() => import('./pages/Emails'))

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
  { to: '/services', label: 'services', icon: Server },
  { to: '/vault', label: 'vault', icon: KeyRound },
  { to: '/trade', label: 'trade', icon: TrendingUp },
  { to: '/emails', label: 'emails', icon: Mail },
]

const BUILD_ID = import.meta.env.VITE_BUILD_ID || 'dev'

function Shell() {
  return (
    <div className="min-h-full bg-[var(--color-bg)] text-[var(--color-text)]">
      <header className="sticky top-0 z-10 border-b border-[var(--color-border)] bg-[var(--color-bg)]">
        <div className="mx-auto flex max-w-[1600px] items-center gap-4 px-6 py-3">
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
          <ThemePicker />
          <nav className="flex flex-1 items-center justify-end gap-0.5 font-mono">
            {navItems.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                aria-label={label}
                title={label}
                className={({ isActive }) =>
                  `flex items-center gap-1.5 px-2.5 py-1.5 text-xs uppercase tracking-[0.14em] transition border ${
                    isActive
                      ? 'border-[var(--color-accent)] text-[var(--color-accent)] bg-[rgba(0,255,65,0.07)]'
                      : 'border-transparent text-[var(--color-text-dim)] hover:border-[var(--color-border)] hover:text-[var(--color-text)]'
                  }`
                }
                style={({ isActive }) => isActive ? { textShadow: '0 0 8px var(--color-accent)' } : {}}
              >
                {({ isActive }) => (
                  <>
                    <Icon size={13} />
                    <span className="hidden sm:inline">{isActive ? `[${label}]` : label}</span>
                  </>
                )}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] px-6 py-8">
        <Suspense fallback={<PageFallback />}>
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/lights" element={<Lights />} />
            <Route path="/services" element={<Services />} />
            <Route path="/vault" element={<Vault />} />
            <Route path="/trade" element={<TradeBot />} />
            <Route path="/emails" element={<Emails />} />
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
