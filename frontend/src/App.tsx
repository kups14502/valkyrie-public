import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { LayoutDashboard, Lightbulb, Gamepad2, KeyRound, TrendingUp } from 'lucide-react'
import Dashboard from './pages/Dashboard'
import Lights from './pages/Lights'
import Game from './pages/Game'
import Vault from './pages/Vault'
import TradeBot from './pages/TradeBot'

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchInterval: 5000, staleTime: 2000 } },
})

const navItems = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/lights', label: 'Lights', icon: Lightbulb },
  { to: '/game', label: 'Game', icon: Gamepad2 },
  { to: '/vault', label: 'Vault', icon: KeyRound },
  { to: '/trade', label: 'Trade Bot', icon: TrendingUp },
]

function Sidebar() {
  return (
    <aside className="w-56 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <h1 className="mb-6 text-lg font-semibold tracking-tight">Master Control</h1>
      <nav className="space-y-1">
        {navItems.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-md px-3 py-2 text-sm transition ${
                isActive
                  ? 'bg-[var(--color-accent)] text-white'
                  : 'text-[var(--color-text-dim)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]'
              }`
            }
          >
            <Icon size={16} />
            {label}
          </NavLink>
        ))}
      </nav>
    </aside>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <div className="flex h-full">
          <Sidebar />
          <main className="flex-1 overflow-auto p-6">
            <Routes>
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/lights" element={<Lights />} />
              <Route path="/game" element={<Game />} />
              <Route path="/vault" element={<Vault />} />
              <Route path="/trade" element={<TradeBot />} />
            </Routes>
          </main>
        </div>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
