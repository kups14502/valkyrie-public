import { lazy, Suspense, useEffect, useLayoutEffect, useState, type ComponentType, type ReactNode } from 'react'
import { BrowserRouter, Routes, Route, NavLink, Navigate, useLocation, useSearchParams } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { LayoutDashboard, Lightbulb, Menu, X, TrendingUp, Search,
  Film, Clapperboard, Tablet, RefreshCw, Settings as SettingsIcon, Smartphone, Terminal as TerminalIcon,
  CalendarDays, UtensilsCrossed, Glasses,
} from 'lucide-react'
import { LogOut } from 'lucide-react'
import { ThemePicker, applyAccent } from './components/ThemePicker'
import { setupZoom } from './lib/zoom'
import { TitleBar } from './components/TitleBar'
import { WindowControls } from './components/TauriTitleBar'
import { UpdateAlarm } from './components/UpdateAlarm'
import { CommandPalette, openCommandPalette } from './components/CommandPalette'
import { ErrorBoundary } from './components/ErrorBoundary'
import { AuthGate } from './components/AuthGate'
import { clearToken, setAuthSkipped, isTauri, isTauriMobile } from './lib/auth'
import { useProfile } from './lib/deviceMode'
import { isEmbedded } from './lib/embed'
import Dashboard from './pages/Dashboard'

// Routes are code-split, and a deploy replaces every hashed chunk at once. A
// tab still running the previous build therefore 404s the moment it opens a
// route it has not visited yet: the import rejects, React.lazy throws it out of
// render, and the page boundary shows a crash card. That is what turned "new
// session" on the board into an error — the session was created, the
// navigation to the terminal route could not find its chunk — and why a reload
// always cured it. index.html is served no-cache, so one reload IS the fix;
// this just does it without making Brendon find the menu.
//
// Once per route per tab: a chunk that is genuinely broken still surfaces as a
// crash card instead of a reload loop. The flag clears on a good load, so a
// second deploy into the same tab is handled like the first.
function lazyRoute(name: string, load: () => Promise<{ default: ComponentType }>) {
  const key = `valkyrie.chunk.${name}`
  return lazy(async () => {
    try {
      const mod = await load()
      try { sessionStorage.removeItem(key) } catch { /* storage unavailable */ }
      return mod
    } catch (err) {
      let retried = true
      try {
        retried = sessionStorage.getItem(key) === '1'
        if (!retried) sessionStorage.setItem(key, '1')
      } catch { /* private mode: no second chance, fall through to the card */ }
      if (retried) throw err
      window.location.reload()
      // The page is on its way out; never resolve, so nothing renders behind it.
      return new Promise<{ default: ComponentType }>(() => {})
    }
  })
}

const Lights = lazyRoute('lights', () => import('./pages/Lights'))
const Vault = lazyRoute('vault', () => import('./pages/Vault'))
const TradeBot = lazyRoute('trade', () => import('./pages/TradeBot'))
const SlopFactory = lazyRoute('slop', () => import('./pages/SlopFactory'))
const Services = lazyRoute('services', () => import('./pages/Services'))
const Activity = lazyRoute('activity', () => import('./pages/Activity'))
const Plex = lazyRoute('plex', () => import('./pages/Plex'))
const Pad = lazyRoute('pad', () => import('./pages/Pad'))
const Settings = lazyRoute('settings', () => import('./pages/Settings'))
const Phone = lazyRoute('phone', () => import('./pages/Phone'))
const Sessions = lazyRoute('sessions', () => import('./pages/Sessions'))
const Terminal = lazyRoute('terminal', () => import('./pages/Terminal'))
const Vr = lazyRoute('vr', () => import('./pages/Vr'))
const Calendar = lazyRoute('calendar', () => import('./pages/Calendar'))
const Meals = lazyRoute('meals', () => import('./pages/Meals'))

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

// Services, Vault, and Activity were pulled from the nav (unused day to day);
// they stay routable and remain in the Ctrl+K palette. The menu grid is 8 wide
// at lg, so nine items wrap one onto a second row; calendar and meals earn that
// because both are opened several times a day.
const navItems = [
  { to: '/dashboard', label: 'dashboard', icon: LayoutDashboard },
  { to: '/calendar', label: 'calendar', icon: CalendarDays },
  { to: '/meals', label: 'meals', icon: UtensilsCrossed },
  { to: '/sessions', label: 'sessions', icon: TerminalIcon },
  { to: '/vr', label: 'vr', icon: Glasses },
  { to: '/plex', label: 'plex', icon: Clapperboard },
  { to: '/lights', label: 'lights', icon: Lightbulb },
  { to: '/trade', label: 'trades', icon: TrendingUp },
  { to: '/slop', label: 'slop', icon: Film },
  { to: '/settings', label: 'settings', icon: SettingsIcon },
]

// The home screens are per form factor, so only show the one that belongs to
// this device: an iPad has no use for the phone dashboard, and a desktop has no
// use for either. The VR workspace is in the menu for everyone (a desktop
// browser is how it gets built and checked), so the vr profile adds nothing.
function navFor(resolved: 'desktop' | 'iphone' | 'ipad' | 'vr') {
  if (resolved === 'ipad') return [...navItems, { to: '/pad', label: 'ipad home', icon: Tablet }]
  if (resolved === 'iphone') return [...navItems, { to: '/phone', label: 'phone home', icon: Smartphone }]
  return navItems
}

// "/" lands on the dashboard, unless a same-origin embedder asked for a page
// by name (?go=/calendar). The VR workspace uses that instead of a deep link
// because "/" is the one path every build serves: the Tauri asset protocol has
// no SPA fallback for /calendar, while index.html at the root always loads.
function RootRedirect() {
  const [params] = useSearchParams()
  const go = params.get('go') ?? ''
  const to = /^\/[a-z0-9/_-]*$/i.test(go) && !go.startsWith('//') ? go : '/dashboard'
  return <Navigate to={to} replace />
}

const BUILD_ID = import.meta.env.VITE_BUILD_ID || 'dev'

// Resolve the app version. In the desktop/mobile app we ask Tauri for the real
// installed version at runtime (authoritative, reflects auto-updates). On
// web/PWA we show the release version baked in at build time from
// tauri.conf.json (see vite.config.ts) plus the short build id, so it's always
// a real version — never "dev" — and distinct deploys stay distinguishable.
// Returned as two parts, not one string: the header shows the build id only
// where there is room for it (see the badge), and the menu shows it always.
function useAppVersion(): { version: string; build: string } {
  const build = !isTauri() && BUILD_ID && BUILD_ID !== 'dev' ? BUILD_ID.slice(0, 7) : ''
  const [version, setVersion] = useState<string>(isTauri() ? '' : `v${__APP_VERSION__}`)
  useEffect(() => {
    if (!isTauri()) return
    void import('@tauri-apps/api/app')
      .then(({ getVersion }) => getVersion())
      .then((v) => setVersion(`v${v}`))
      .catch(() => setVersion(`v${__APP_VERSION__}`))
  }, [])
  return { version, build }
}

// The menu is the whole navigation at every width, and on a 390px phone it has
// to fit the screen with no scrolling in either direction. Two rules do that:
// the tiles stack their icon over the label below sm so three fit a row, and
// the controls row is icons only below sm. Spelled-out buttons plus a kbd hint
// came to about 440px on one line, which is where the sideways drag came from.
const MENU_ICON = 'inline-flex h-10 min-w-10 items-center justify-center gap-2 border border-[var(--color-border)] px-2.5 text-xs uppercase tracking-[0.12em] text-[var(--color-text-dim)] transition-colors hover:border-[var(--color-accent)]/60 hover:text-[var(--color-accent)] active:border-[var(--color-accent)]'

function MobileMenu({ onClose }: { onClose: () => void }) {
  const location = useLocation()
  const items = navFor(useProfile().resolved)
  const { version, build } = useAppVersion()
  return (
    <div className="border-b border-[var(--color-border)] bg-[var(--color-bg)]">
      <div className="mx-auto max-w-[1600px] space-y-3 px-4 py-3 sm:px-6">
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-8">
          {items.map(({ to, label, icon: Icon }) => {
            const isActive = location.pathname === to || (to !== '/dashboard' && location.pathname.startsWith(to))
            return (
              <NavLink
                key={to}
                to={to}
                onClick={onClose}
                className={`flex min-h-12 min-w-0 flex-col items-center justify-center gap-1 rounded-[3px] border px-2 py-1.5 text-[10px] uppercase tracking-[0.1em] transition-colors sm:min-h-0 sm:flex-row sm:justify-start sm:gap-2 sm:px-3 sm:py-2 sm:text-xs sm:tracking-[0.12em] ${
                  isActive
                    ? 'border-[var(--color-accent)]/70 bg-[rgba(0,255,65,0.12)] text-[var(--color-accent)]'
                    : 'border-[var(--color-border)] text-[var(--color-text-dim)] hover:border-[var(--color-accent)]/40 hover:text-[var(--color-text)]'
                }`}
                style={isActive ? { boxShadow: '0 0 10px rgba(0,255,65,0.22)', textShadow: '0 0 8px var(--color-accent)' } : {}}
              >
                <Icon size={14} className="shrink-0 sm:h-3 sm:w-3" />
                <span className="max-w-full truncate">{label}</span>
              </NavLink>
            )
          })}
        </div>
        <div className="flex items-center gap-2 border-t border-[var(--color-border)] pt-3">
          <button
            type="button"
            onClick={() => { onClose(); openCommandPalette() }}
            title="Search — jump to any page (Ctrl+K)"
            aria-label="Search"
            className={MENU_ICON}
          >
            <Search size={14} />
            <span className="hidden sm:inline">search</span>
            <kbd className="ml-1 hidden border border-[var(--color-border)] px-1 py-0.5 text-[8px] tracking-[0.1em] text-[var(--color-text-faint)] sm:inline-block">ctrl k</kbd>
          </button>
          <ThemePicker />
          {/* Added to the home screen, iOS gives no address bar, and the shell
              sets html{overflow:hidden} so pull-to-refresh can't fire either —
              this is the only way to force the newest build in that mode. */}
          <button
            type="button"
            onClick={() => window.location.reload()}
            title="Reload to get the latest build"
            aria-label="Reload"
            className={MENU_ICON}
          >
            <RefreshCw size={14} />
            <span className="hidden sm:inline">reload</span>
          </button>
          <button
            type="button"
            onClick={() => { onClose(); logout() }}
            aria-label="Sign out"
            className={`${MENU_ICON} hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]`}
          >
            <LogOut size={14} />
            <span className="hidden sm:inline">sign out</span>
          </button>
          {/* The header badge drops the build id on a narrow screen, so this is
              where the phone checks whether a deploy actually landed. On the
              same row as the controls, because a line of its own was one more
              thing pushing the menu past the bottom of the screen. */}
          {version && (
            <div className="ml-auto min-w-0 truncate font-mono text-[10px] tracking-[0.12em] text-[var(--color-text-faint)]">
              {version}{build ? ` · ${build}` : ''}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// One shared width for every page. Fluid below the cap so it scales with the
// device, then centered on very wide screens so line lengths stay sane. Every
// tabbed route uses this, so nothing is full-bleed while its neighbor sits in a
// narrow column any more. The device home screens (pad/phone) keep their own
// full-screen layouts.
function PageContainer({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-[1800px]">{children}</div>
}

function Shell() {
  const [menuOpen, setMenuOpen] = useState(false)
  const location = useLocation()
  const { version, build } = useAppVersion()

  // The device profile decides what "home" is: the pad screen on a phone or
  // tablet, the full dashboard on a desktop. The header button hides while
  // you're already there.
  const profile = useProfile()
  const home = profile.home
  const atHome = location.pathname === home
  const onHomeScreen = home !== '/dashboard'

  // The dashboard opens with the nav menu already down (as a launcher); it
  // stays closeable, and closing it while on the dashboard sticks because this
  // only fires when the route actually becomes /dashboard. Pad mode has its own
  // big tiles, so it doesn't need the menu auto-opened.
  const onDashboard = location.pathname === '/dashboard'
  useEffect(() => { if (onDashboard) setMenuOpen(true) }, [onDashboard])

  // The in-page terminal (/sessions/terminal) is pinned: it owns its own
  // height, must not scroll, and must not carry main's padding. The page itself
  // owns the document-level state (html[data-term-pin], --vp-kb, --vp-pin,
  // data-kb) so there is exactly one owner; the shell only owns what it
  // renders. Layout effect, not effect, so the menu is already closed in the
  // paint that first shows the terminal.
  // The VR workspace (/vr) is pinned for the same reason: its panes own the
  // height and a scrolling main would let a laser-pointer drag shift them.
  const pinned = location.pathname === '/sessions/terminal' || location.pathname === '/vr'
  useLayoutEffect(() => { if (pinned) setMenuOpen(false) }, [pinned])

  return (
    <div data-shell className="flex h-full max-w-full flex-col overflow-x-hidden bg-[var(--color-bg)] text-[var(--color-text)]">
      {!isEmbedded && <TitleBar />}
      {/* The header doubles as the frameless window's draggable title bar in the app.
          shrink-0 so it keeps its height; <main> below is the scroll container. */}
      {!isEmbedded && <header className="relative z-10 shrink-0 select-none border-b border-[var(--color-border)] bg-[var(--color-bg)]">
        {/* Full-area drag layer: grab anywhere in the header to move the frameless
            window (double-click toggles maximize). The interactive controls below
            re-enable pointer events so their clicks aren't swallowed by the drag. */}
        {/* In the app, reserve the window-controls strip (3 × 44px buttons, see
            TauriTitleBar) so the menu button never slides underneath it. */}
        <div className={`relative w-full py-0 ${isTauri() && !isTauriMobile() ? 'pl-4 pr-[140px] sm:pl-6' : 'px-4 sm:px-6'}`}>
          {/* Drag layer scoped to the toolbar row ONLY — not the dropdown menu
              below — and sits behind the controls so it never swallows clicks. */}
          <div data-tauri-drag-region aria-hidden className="pointer-events-auto absolute inset-0" />
          <div className="pointer-events-none relative">
            <div className="pointer-events-none flex items-center gap-3">
              {/* left cluster: brand + version */}
              {/* min-w-0, and the brand truncates: this cluster is the one
                  that gives up width. It used to be shrink-0 next to a
                  shrink-0 badge, so on a 390px phone the row overflowed and the
                  home and menu buttons were clipped off the right edge. */}
              <div className="flex min-w-0 items-center gap-2.5">
                <div
                  className="min-w-0 truncate text-base font-bold tracking-widest"
                  style={{ color: 'var(--color-accent)', textShadow: '0 0 12px var(--color-accent)' }}
                >
                  VALKYRIE<span className="opacity-40">//</span>SYS<span className="cursor-blink">_</span>
                </div>
                {version && (
                  <span
                    title={`Valkyrie ${version}${build ? ` · ${build}` : ''}`}
                    className="shrink-0 rounded-sm border border-[var(--color-accent)]/60 bg-[rgba(0,255,65,0.12)] px-2 py-0.5 font-mono text-[11px] font-bold tracking-[0.12em] text-[var(--color-accent)]"
                    style={{ textShadow: '0 0 8px var(--color-accent)' }}
                  >
                    {version}
                    {/* The build id is the deploy-freshness signal, and it is
                        ten more characters than a phone header has room for.
                        It stays here on a wide screen and lives in the menu on
                        a narrow one. */}
                    {build && <span className="hidden sm:inline"> · {build}</span>}
                  </span>
                )}
              </div>
              {/* Right cluster: update alarm (app only), quick dashboard, menu. */}
              {/* shrink-0: these two buttons are the only way out of a page,
                  so nothing in this row is allowed to push them off screen. */}
              <div className="pointer-events-none ml-auto flex shrink-0 items-center gap-2">
                <UpdateAlarm />
                {/* Quick jump home, shown only when you're not already there.
                    In iPad mode home is the pad screen. */}
                {!atHome && (
                  <NavLink
                    to={home}
                    aria-label={onHomeScreen ? 'Home screen' : 'Dashboard'}
                    title={onHomeScreen ? 'Go to your home screen' : 'Go to dashboard'}
                    className="pointer-events-auto p-2 text-[var(--color-text-dim)] transition hover:bg-[rgba(255,255,255,0.08)] hover:text-[var(--color-accent)]"
                  >
                    {onHomeScreen
                      ? (profile.resolved === 'ipad' ? <Tablet size={16} />
                        : profile.resolved === 'vr' ? <Glasses size={16} />
                          : <Smartphone size={16} />)
                      : <LayoutDashboard size={16} />}
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
      </header>}

      {/* `relative overflow-hidden` is inside the pinned branch only: making main
          a containing block on every route would re-anchor other pages'
          absolutely positioned descendants. overflow-hidden covers both axes, so
          overflow-x-hidden moves into the unpinned branch. */}
      <main
        className={`min-h-0 w-full flex-1 ${
          pinned
            ? 'relative overflow-hidden'
            : 'overflow-y-auto overflow-x-hidden px-3 py-5 sm:px-6 sm:py-8'
        }`}
      >
        <Suspense fallback={<PageFallback />}>
          {/* Per-route boundary: a crash in one page shows an inline error and
              keeps the nav usable; the key resets it when you navigate away. */}
          <ErrorBoundary compact key={location.pathname}>
          <Routes>
            <Route path="/" element={<RootRedirect />} />
            <Route path="/dashboard" element={<PageContainer><Dashboard /></PageContainer>} />
            <Route path="/lights" element={<PageContainer><Lights /></PageContainer>} />
            <Route path="/calendar" element={<PageContainer><Calendar /></PageContainer>} />
            <Route path="/meals" element={<PageContainer><Meals /></PageContainer>} />
            <Route path="/sessions" element={<PageContainer><Sessions /></PageContainer>} />
            {/* Bare, like /pad and /phone: PageContainer's mx-auto max-w-[1800px]
                exists for prose line length, and a non-positioned wrapper between
                main and an absolute inset-0 page root is dead weight. */}
            <Route path="/sessions/terminal" element={<Terminal />} />
            {/* The terminal had its own tab for a day. Bookmarks from then. */}
            <Route path="/terminal" element={<Navigate to="/sessions/terminal" replace />} />
            {/* The VR workspace: bare like the terminal, its panes fill main. */}
            <Route path="/vr" element={<Vr />} />
            <Route path="/services" element={<PageContainer><Services /></PageContainer>} />
            <Route path="/vault" element={<PageContainer><Vault /></PageContainer>} />
            <Route path="/trade" element={<PageContainer><TradeBot /></PageContainer>} />
            <Route path="/slop" element={<PageContainer><SlopFactory /></PageContainer>} />
            <Route path="/activity" element={<PageContainer><Activity /></PageContainer>} />
            <Route path="/plex" element={<PageContainer><Plex /></PageContainer>} />
            <Route path="/pad" element={<Pad />} />
            <Route path="/settings" element={<PageContainer><Settings /></PageContainer>} />
            <Route path="/phone" element={<Phone />} />
          </Routes>
          </ErrorBoundary>
        </Suspense>
      </main>
      {!isEmbedded && <CommandPalette />}
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
