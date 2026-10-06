import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Sparkles } from 'lucide-react'
import { apiErrorText, openTermSession, termPath } from '../../lib/api'
import { seedTerminal } from '../SessionBoard'
import { BTN_ACCENT, BTN_TEXT, FIELD, LABEL, Sheet } from './Sheet'

// Brendon does not set projects up: a Claude session on thor does. This starts
// one with whatever he typed, and it finds the folder, names the project,
// creates it and fills its page (backend lib/projectDesk.ts). The terminal it
// opens returns to the list, where the new project appears.

const PROMPT_MAX = 2000

// The phone terminal's own font, so the first frame needs no resize.
function grid(): { cols: number; rows: number } {
  const cols = Math.floor(window.innerWidth / (12 * 0.6))
  const rows = Math.floor((window.innerHeight - 120) / (12 * 1.32))
  return { cols: Math.max(24, cols), rows: Math.max(10, rows) }
}

export function NewProjectAiSheet({ onClose, onManual }: { onClose: () => void; onManual: () => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const start = async () => {
    setBusy(true)
    setError('')
    try {
      const r = await openTermSession({ mode: 'new', desk: true, prompt: prompt.trim(), label: 'new project', ...grid() })
      seedTerminal(qc, r)
      navigate(termPath(r.name, '/projects'))
    } catch (e) {
      setError(apiErrorText(e, 'could not start the session'))
      setBusy(false)
    }
  }

  return (
    <Sheet title="new project" onClose={onClose}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void start() }}>
        <label className="block">
          <span className={LABEL}>what is it</span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            maxLength={PROMPT_MAX}
            rows={4}
            autoFocus
            placeholder="A client, a folder, an idea. Leave it empty and Claude asks."
            className={FIELD + ' resize-y'}
          />
        </label>
        <div className="text-[11px] text-[var(--color-text-faint)]">
          Claude finds the folder, names the project, creates it and fills its page.
        </div>
        {error && <div className="text-xs text-[var(--color-danger)]">{error}</div>}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <button type="submit" disabled={busy} className={BTN_ACCENT}>
            <Sparkles size={13} /> {busy ? 'starting' : 'start'}
          </button>
          <button type="button" onClick={onManual} className={BTN_TEXT}>set up by hand</button>
        </div>
      </form>
    </Sheet>
  )
}
