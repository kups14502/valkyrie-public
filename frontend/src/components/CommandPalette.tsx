import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { LayoutDashboard, Lightbulb, TrendingUp, KeyRound, Server, Activity as ActivityIcon, Search, CornerDownLeft, Clapperboard, Tablet, Smartphone, Settings as SettingsIcon, Terminal, CalendarDays, UtensilsCrossed } from 'lucide-react'
import { useProfile } from '../lib/deviceMode'

// Global command palette (Ctrl/Cmd+K): jump to any page by name. Opens over
// everything, keyboard-driven, closes on Esc / outside click / after acting.
// Mounted once in the app shell.

// Let anything (e.g. the menu's Search button) open the palette without
// prop-drilling: fire this event and the mounted palette opens.
const OPEN_EVENT = 'valkyrie:command-palette'
export function openCommandPalette() { window.dispatchEvent(new Event(OPEN_EVENT)) }

type Cmd = { id: string; label: string; hint?: string; icon: React.ReactNode; run: () => void }

const PAGES: { to: string; label: string; icon: React.ReactNode }[] = [
  { to: '/dashboard', label: 'Dashboard', icon: <LayoutDashboard size={15} /> },
  { to: '/calendar', label: 'Calendar', icon: <CalendarDays size={15} /> },
  { to: '/meals', label: 'Meals', icon: <UtensilsCrossed size={15} /> },
  { to: '/sessions', label: 'Sessions', icon: <Terminal size={15} /> },
  { to: '/plex', label: 'Plex', icon: <Clapperboard size={15} /> },
  { to: '/lights', label: 'Lights', icon: <Lightbulb size={15} /> },
  { to: '/trade', label: 'Trades', icon: <TrendingUp size={15} /> },
  { to: '/vault', label: 'Vault', icon: <KeyRound size={15} /> },
  { to: '/services', label: 'Services', icon: <Server size={15} /> },
  { to: '/activity', label: 'Activity', icon: <ActivityIcon size={15} /> },
  { to: '/settings', label: 'Settings', icon: <SettingsIcon size={15} /> },
]

// Only this device's own home screen is offered (see navFor in App.tsx).
const HOME_PAGES = {
  ipad: { to: '/pad', label: 'iPad home', icon: <Tablet size={15} /> },
  iphone: { to: '/phone', label: 'Phone home', icon: <Smartphone size={15} /> },
} as const

export function CommandPalette() {
  const navigate = useNavigate()
  const { resolved } = useProfile()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setOpen((v) => !v)
      } else if (e.key === 'Escape' && open) {
        setOpen(false)
      }
    }
    const onOpen = () => setOpen(true)
    window.addEventListener('keydown', onKey)
    window.addEventListener(OPEN_EVENT, onOpen)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener(OPEN_EVENT, onOpen)
    }
  }, [open])

  useEffect(() => {
    if (open) { setQuery(''); setActive(0); setTimeout(() => inputRef.current?.focus(), 20) }
  }, [open])

  const commands = useMemo<Cmd[]>(() => {
    const q = query.trim().toLowerCase()
    const home = resolved === 'ipad' ? HOME_PAGES.ipad : resolved === 'iphone' ? HOME_PAGES.iphone : null
    const pageCmds: Cmd[] = [...PAGES, ...(home ? [home] : [])]
      .filter((p) => !q || p.label.toLowerCase().includes(q))
      .map((p) => ({ id: `page:${p.to}`, label: p.label, hint: 'page', icon: p.icon, run: () => navigate(p.to) }))
    return pageCmds
  }, [query, navigate, resolved])

  useEffect(() => { setActive((a) => Math.min(a, Math.max(0, commands.length - 1))) }, [commands.length])

  if (!open) return null

  const act = (c: Cmd | undefined) => { if (!c) return; c.run(); setOpen(false) }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/60 pt-[12vh]"
      onMouseDown={() => setOpen(false)}
    >
      <div
        className="mx-4 w-full max-w-[560px] border border-[var(--color-border-strong)] bg-[var(--color-bg)]"
        style={{ boxShadow: '0 0 40px rgba(0,0,0,0.7), 0 0 14px rgba(var(--color-accent-rgb),0.15)' }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, commands.length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
          else if (e.key === 'Enter') { e.preventDefault(); act(commands[active]) }
        }}
      >
        <div className="flex items-center gap-2.5 border-b border-[var(--color-border)] px-3.5 py-2.5">
          <Search size={16} className="shrink-0 text-[var(--color-text-faint)]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0) }}
            placeholder="jump to a page…"
            className="min-w-0 flex-1 bg-transparent text-sm text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)]"
          />
          <kbd className="shrink-0 border border-[var(--color-border)] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.1em] text-[var(--color-text-faint)]">esc</kbd>
        </div>
        <div className="max-h-[50vh] overflow-y-auto py-1.5">
          {commands.length === 0 ? (
            <div className="px-3.5 py-3 text-sm text-[var(--color-text-faint)]">&gt; no matches</div>
          ) : (
            commands.map((c, i) => (
              <button
                key={c.id}
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => act(c)}
                className={`flex w-full items-center gap-3 px-3.5 py-2 text-left transition ${
                  i === active ? 'bg-[rgba(var(--color-accent-rgb),0.1)]' : ''
                }`}
              >
                <span className={`shrink-0 ${i === active ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-dim)]'}`}>{c.icon}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-text)]">{c.label}</span>
                {c.hint && <span className="shrink-0 text-[9px] uppercase tracking-[0.12em] text-[var(--color-text-faint)]">{c.hint}</span>}
                {i === active && <CornerDownLeft size={13} className="shrink-0 text-[var(--color-accent)]" />}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
