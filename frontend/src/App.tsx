import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { LayoutDashboard, Lightbulb, KeyRound, TrendingUp, Server } from 'lucide-react'
import Dashboard from './pages/Dashboard'

const Lights = lazy(() => import('./pages/Lights'))
const Vault = lazy(() => import('./pages/Vault'))
const TradeBot = lazy(() => import('./pages/TradeBot'))
const Services = lazy(() => import('./pages/Services'))

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
      loading…
    </div>
  )
}

const navItems = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/lights', label: 'Lights', icon: Lightbulb },
  { to: '/services', label: 'Services', icon: Server },
  { to: '/vault', label: 'Vault', icon: KeyRound },
  { to: '/trade', label: 'Trade Bot', icon: TrendingUp },
]

const BUILD_ID = import.meta.env.VITE_BUILD_ID || 'dev'

function Shell() {
  return (
    <div className="min-h-full bg-[var(--color-bg)] text-[var(--color-text)]">
      <header className="sticky top-0 z-10 border-b border-[var(--color-border)] bg-[var(--color-bg)]">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-6 px-6 py-4">
          <div className="shrink-0">
            <div className="text-[10px] uppercase tracking-[0.3em] text-[var(--color-text-faint)]">// master control</div>
            <div className="mt-1 text-lg font-bold tracking-[0.14em] text-[var(--color-accent)]">BRNDN//SYS</div>
            <div className="mt-1 text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-faint)]">build:{BUILD_ID}</div>
          </div>
          <nav className="flex flex-1 items-center justify-end gap-1 sm:justify-start">
            {navItems.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                aria-label={label}
                title={label}
                className={({ isActive }) =>
                  `group flex items-center gap-2 border p-2 text-sm transition sm:px-3 sm:py-1.5 ${
                    isActive
                      ? 'border-[var(--color-accent)] bg-[color:rgba(45,212,191,0.08)] text-[var(--color-accent)]'
                      : 'border-transparent text-[var(--color-text-dim)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <Icon size={16} className="text-[var(--color-accent)]/90" />
                    <span className="hidden whitespace-nowrap lowercase sm:inline">
                      {isActive ? `[${label}]` : label}
                    </span>
                  </>
                )}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        <Suspense fallback={<PageFallback />}>
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/lights" element={<Lights />} />
            <Route path="/services" element={<Services />} />
            <Route path="/vault" element={<Vault />} />
            <Route path="/trade" element={<TradeBot />} />
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
