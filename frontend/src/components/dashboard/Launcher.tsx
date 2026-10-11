import { NavLink } from 'react-router-dom'
import { Search } from 'lucide-react'
import { navFor } from '../../lib/nav'
import { useProfile } from '../../lib/deviceMode'
import { openCommandPalette } from '../CommandPalette'

// Every page in one line of text links. The nav menu used to open on its own
// here as the launcher, and its two rows of boxed buttons cost 200px of the
// screen before the first tile.
export function Launcher() {
  const items = navFor(useProfile().resolved)
  return (
    <nav className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-1 border-b border-[var(--color-border)]">
      {items.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) => `-mb-px flex items-center gap-1.5 border-b-2 py-1.5 text-[12px] transition-colors ${
            isActive
              ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
              : 'border-transparent text-[var(--color-text-dim)] hover:text-[var(--color-text)]'
          }`}
        >
          <Icon size={13} className="shrink-0" />
          {label}
        </NavLink>
      ))}
      <button
        type="button"
        onClick={openCommandPalette}
        title="Jump to any page"
        className="ml-auto flex items-center gap-1.5 py-1.5 text-[12px] text-[var(--color-text-faint)] transition-colors hover:text-[var(--color-text)]"
      >
        <Search size={13} />
        search
        <kbd className="border border-[var(--color-border)] px-1 text-[10px] text-[var(--color-text-faint)]">ctrl k</kbd>
      </button>
    </nav>
  )
}
