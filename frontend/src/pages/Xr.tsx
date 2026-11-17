import { useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchTermSessions, killTermSession } from '../lib/api'
import { TERM_NAME_RE, errText } from '../lib/term'
import { PAGES, loadFont } from '../lib/vr'
import { ScreenPicker, VrPagePane, VrTermPane } from './Vr'

// One panel of the Steam Frame app (xr/ in the repo). The app floats panels
// around the headset, each its own offscreen tab on /xr, so this page is one
// screen: a terminal (?s=vk-...), a Valkyrie page (?page=/calendar, in an
// iframe the way the /vr desk shows one), or with neither, the picker that
// chooses what goes here. The app installs the valkyrieXr binding before any
// script runs (lib/embed.ts reads it to drop the app chrome), and the page
// calls it to close its own panel. Where a panel sits, its size and which
// panels exist belong to the app; the URL is all it keeps of this page.

const noop = () => {}

function tellApp(msg: { op: 'close' }) {
  const bind = (window as { valkyrieXr?: (payload: string) => void }).valkyrieXr
  bind?.(JSON.stringify(msg))
}

export default function XrPanel() {
  const [params, setParams] = useSearchParams()
  const s = params.get('s') ?? ''
  const page = params.get('page') ?? ''
  const show = (next: Record<string, string>) => setParams(next, { replace: true })
  const close = () => tellApp({ op: 'close' })
  const pick = () => show({})

  if (TERM_NAME_RE.test(s)) return <XrTerm name={s} onSwap={pick} onClose={close} />
  if (PAGES.some((p) => p.path === page)) {
    return (
      <div className="absolute inset-0 grid bg-[var(--color-bg)]">
        <VrPagePane id="xr" path={page} focused onFocus={noop} onHide={close} onSwap={pick} />
      </div>
    )
  }
  return (
    <div className="absolute inset-0 overflow-y-auto bg-[var(--color-bg)] p-3">
      <ScreenPicker
        title="what goes on this panel"
        shown={new Set()}
        grid={() => termGrid(loadFont())}
        onTerm={(name) => show({ s: name })}
        onPage={(path) => show({ page: path })}
        onClose={close}
      />
    </div>
  )
}

// A new session starts at the size this whole panel gives a terminal.
function termGrid(font: number) {
  return {
    cols: Math.max(40, Math.floor((window.innerWidth - 16) / (font * 0.6))),
    rows: Math.max(12, Math.floor((window.innerHeight - 60) / (font * 1.32))),
  }
}

function XrTerm({ name, onSwap, onClose }: { name: string; onSwap: () => void; onClose: () => void }) {
  const qc = useQueryClient()
  const sessions = useQuery({ queryKey: ['term', 'sessions'], queryFn: fetchTermSessions })
  const ctrlRef = useRef(false)
  const [font] = useState(loadFont)
  const [error, setError] = useState<string | null>(null)
  const session = sessions.data?.find((x) => x.name === name)
  // Never off a list that is still loading, or a reload would flash it as gone.
  const settled = sessions.isSuccess && !sessions.isFetching

  const end = async () => {
    setError(null)
    try {
      await killTermSession(name)
    } catch (e) {
      setError(errText(e))
      return
    }
    await qc.invalidateQueries({ queryKey: ['term', 'sessions'] })
    void qc.invalidateQueries({ queryKey: ['sessionList'] })
    onClose()
  }

  return (
    <div className="absolute inset-0 grid bg-[var(--color-bg)]">
      <VrTermPane
        id="xr"
        name={name}
        session={session}
        missing={settled && !session}
        font={font}
        focused
        ctrlRef={ctrlRef}
        onCtrlUsed={noop}
        onFocus={noop}
        onHide={onClose}
        onEnd={() => void end()}
        onSwap={onSwap}
        register={noop}
      />
      {error && (
        <div
          onClick={() => setError(null)}
          title="dismiss"
          className="absolute inset-x-2 top-12 z-20 cursor-pointer border border-[var(--color-danger)]/60 bg-[var(--color-bg)] px-4 py-3 text-[13px] text-[var(--color-danger)]"
        >
          {error}
        </div>
      )}
    </div>
  )
}
