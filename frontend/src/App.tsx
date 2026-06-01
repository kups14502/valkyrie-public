import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
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
      &gt; loading<span className="cursor-blink">_</span>
    </div>
  )
}

const navItems = [
  { to: '/dashboard', label: 'sys', full: 'dashboard' },
  { to: '/lights', label: 'env', full: 'lights' },
  { to: '/services', label: 'svc', full: 'services' },
  { to: '/vault', label: 'vlt', full: 'vault' },
  { to: '/trade', label: 'bot', full: 'trade' },
]

const BUILD_ID = import.meta.env.VITE_BUILD_ID || 'dev'

function Shell() {
  return (
    <div className="min-h-full bg-[var(--color-bg)] text-[var(--color-text)]">
      <header className="sticky top-0 z-10 border-b border-[var(--color-border)] bg-[var(--color-bg)]">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-3">
          <div className="shrink-0 min-w-0">
            <div
              className="text-base font-bold tracking-widest"
              style={{ color: 'var(--color-accent)', textShadow: '0 0 12px var(--color-accent)' }}
            >
              BRNDN<span className="opacity-40">//</span>SYS<span className="cursor-blink">_</span>
            </div>
            <div className="text-[9px] uppercase tracking-[0.28em] text-[var(--color-text-faint)] mt-0.5">
              master-control · build:{BUILD_ID}
            </div>
          </div>
          <nav className="flex flex-1 items-center justify-end gap-0.5 font-mono">
            {navItems.map(({ to, label, full }) => (
              <NavLink
                key={to}
                to={to}
                aria-label={full}
                title={full}
                className={({ isActive }) =>
                  `px-2.5 py-1 text-xs uppercase tracking-[0.18em] transition border ${
                    isActive
                      ? 'border-[var(--color-accent)] text-[var(--color-accent)] bg-[rgba(0,255,65,0.07)]'
                      : 'border-transparent text-[var(--color-text-dim)] hover:border-[var(--color-border)] hover:text-[var(--color-text)]'
                  }`
                }
                style={({ isActive }) => isActive ? { textShadow: '0 0 8px var(--color-accent)' } : {}}
              >
                {({ isActive }) => isActive ? `[${label}]` : label}
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
