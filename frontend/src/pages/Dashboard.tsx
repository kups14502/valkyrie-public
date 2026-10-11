import { useEffect, useRef, useState, type ComponentType, type RefObject } from 'react'
import { Launcher } from '../components/dashboard/Launcher'
import { StatusLine } from '../components/dashboard/StatusLine'
import { TrackerTable } from '../components/dashboard/TrackerTable'
import { Agenda } from '../components/dashboard/Agenda'
import { AIUsage } from '../components/dashboard/AIUsage'
import { Lights } from '../components/dashboard/Lights'
import { Hosts } from '../components/dashboard/Hosts'
import { Services } from '../components/dashboard/Services'
import { TradeBot } from '../components/dashboard/TradeBot'

// The desktop dashboard, rebuilt 2026-10-11. One surface instead of a wall of
// boxes: a line of page links, a status line with the new-session buttons,
// then columns split by hairlines. Sections keep their natural height (stretched
// to the bottom of the window they read as tall boxes around a few lines), and
// the whole page fits 1600x900 without scrolling.

type Columns = 1 | 2 | 3

// Measured on the page, not the window: the UI zoom (Ctrl +/-) scales the
// page, and a media query never sees it.
const columnsFor = (width: number): Columns => (width >= 1240 ? 3 : width >= 760 ? 2 : 1)

function useColumnCount(ref: RefObject<HTMLDivElement | null>): Columns {
  const [n, setN] = useState<Columns>(() => {
    const zoom = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom')) || 1
    return columnsFor(Math.min(1800, window.innerWidth / zoom - 48))
  })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setN(columnsFor(entry.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return n
}

const SECTIONS: Record<string, ComponentType> = {
  tracker: TrackerTable,
  today: Agenda,
  trade: TradeBot,
  ai: AIUsage,
  lights: Lights,
  hosts: Hosts,
  services: Services,
}

// Left: the day (tracker, calendar, the bot's numbers). Middle: Claude limits
// and the machines. Right: the room and odin's services. Projects stay on
// their own page: a preview here was a second, shorter copy of it.
const LAYOUT: Record<Columns, string[][]> = {
  3: [['tracker', 'today', 'trade'], ['ai', 'hosts'], ['lights', 'services']],
  2: [['tracker', 'today', 'trade', 'services'], ['ai', 'lights', 'hosts']],
  1: [['tracker', 'today', 'ai', 'lights', 'hosts', 'services', 'trade']],
}

const GRID: Record<Columns, string> = {
  3: 'grid-cols-[21rem_minmax(0,1fr)_minmax(0,1fr)]',
  2: 'grid-cols-[21rem_minmax(0,1fr)]',
  1: 'grid-cols-1',
}

export default function Dashboard() {
  const root = useRef<HTMLDivElement>(null)
  const columns = useColumnCount(root)

  return (
    // vk-compact: lets the small text sizes on buttons apply (index.css).
    // overflow-x-clip clips sideways without making this a scroll container.
    <div ref={root} className="vk-compact min-w-0 overflow-x-clip sm:-mt-4">
      <Launcher />
      <StatusLine />
      <div className={`mt-2 grid divide-x divide-[var(--color-border)] ${GRID[columns]}`}>
        {LAYOUT[columns].map((col, i) => (
          <div key={i} className="min-w-0 space-y-5 px-5 first:pl-0 last:pr-0">
            {col.map((key) => {
              const Section = SECTIONS[key]
              return <Section key={key} />
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
