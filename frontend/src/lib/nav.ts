import {
  LayoutDashboard, Lightbulb, TrendingUp, Film, Clapperboard, Tablet, Settings as SettingsIcon, Smartphone,
  Terminal as TerminalIcon, CalendarDays, UtensilsCrossed, Glasses, FolderKanban, type LucideIcon,
} from 'lucide-react'

export type NavItem = { to: string; label: string; icon: LucideIcon }

// Services, Vault, and Activity were pulled from the nav (unused day to day);
// they stay routable and remain in the Ctrl+K palette. The menu grid is 8 wide
// at lg, so the tail wraps onto a second row. Brendon's order: the five he
// uses most first, settings always last.
const navItems: NavItem[] = [
  { to: '/dashboard', label: 'dashboard', icon: LayoutDashboard },
  { to: '/sessions', label: 'sessions', icon: TerminalIcon },
  { to: '/projects', label: 'projects', icon: FolderKanban },
  { to: '/lights', label: 'lights', icon: Lightbulb },
  { to: '/plex', label: 'plex', icon: Clapperboard },
  { to: '/trade', label: 'trades', icon: TrendingUp },
  { to: '/calendar', label: 'calendar', icon: CalendarDays },
  { to: '/meals', label: 'meals', icon: UtensilsCrossed },
  { to: '/vr', label: 'vr', icon: Glasses },
  { to: '/slop', label: 'slop', icon: Film },
]
const settingsItem: NavItem = { to: '/settings', label: 'settings', icon: SettingsIcon }

// The home screens are per form factor, so only show the one that belongs to
// this device: an iPad has no use for the phone dashboard, and a desktop has no
// use for either. The VR workspace is in the menu for everyone (a desktop
// browser is how it gets built and checked), so the vr profile adds nothing.
export function navFor(resolved: 'desktop' | 'iphone' | 'ipad' | 'vr'): NavItem[] {
  if (resolved === 'ipad') return [...navItems, { to: '/pad', label: 'ipad home', icon: Tablet }, settingsItem]
  if (resolved === 'iphone') return [...navItems, { to: '/phone', label: 'phone home', icon: Smartphone }, settingsItem]
  return [...navItems, settingsItem]
}
