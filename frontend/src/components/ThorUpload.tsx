import { useState } from 'react'
import { Camera, Check, ImageUp, X } from 'lucide-react'
import { copyText } from '../lib/clipboard'
import { fmtBytes, uploadLine, useThorUpload, type UploadItem } from '../lib/useThorUpload'

// Pictures and videos from the phone to C:\Thor\uploads on thor, from the home
// screen. The terminal has the same two buttons in its session bar
// (pages/Terminal.tsx); the state behind both is lib/useThorUpload.tsx.

const BIG = 'flex min-h-11 flex-1 items-center justify-center gap-2 border border-[var(--color-border)] px-4 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-text-dim)] transition active:border-[var(--color-accent)] active:text-[var(--color-accent)]'

// The home screen's panel.
export function ThorUploadPanel() {
  const up = useThorUpload()
  const [copied, setCopied] = useState<number | null>(null)

  const copy = async (i: UploadItem) => {
    if (!i.path || !(await copyText(i.path))) return
    setCopied(i.key)
    setTimeout(() => setCopied((k) => (k === i.key ? null : k)), 1500)
  }

  return (
    <div className="panel p-4">
      {up.inputs}
      <div className="flex items-center gap-3">
        <ImageUp size={22} className="shrink-0 text-[var(--color-accent)]" />
        <div className="min-w-0">
          <div className="truncate text-base leading-tight text-[var(--color-text)]">send to thor</div>
          <div className="mt-0.5 truncate text-[10px] uppercase tracking-[0.2em] text-[var(--color-text-faint)]">
            {up.busy ? 'uploading…' : 'photos and videos to C:\\Thor\\uploads'}
          </div>
        </div>
      </div>

      <div className="mt-3 flex gap-2">
        <button type="button" onClick={() => up.openCamera()} className={BIG}>
          <Camera size={14} /> camera
        </button>
        <button type="button" onClick={() => up.openFiles()} className={BIG}>
          <ImageUp size={14} /> upload
        </button>
      </div>

      {up.items.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {[...up.items].reverse().slice(0, 8).map((i) => (
            <div key={i.key} className="flex items-center gap-2 border border-[var(--color-border)] px-2.5 py-2">
              <button
                type="button"
                onClick={() => void copy(i)}
                disabled={i.state !== 'done'}
                title={i.state === 'done' ? 'copy the path' : undefined}
                className="min-w-0 flex-1 text-left"
              >
                <div className={`truncate text-[11px] ${i.state === 'err' ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-dim)]'}`}>
                  {i.state === 'done' ? i.name : uploadLine(i)}
                </div>
                {i.state === 'up' && (
                  <div className="mt-1 h-0.5 w-full bg-[var(--color-border)]">
                    <div className="h-full bg-[var(--color-accent)]" style={{ width: `${i.total ? (i.sent / i.total) * 100 : 0}%` }} />
                  </div>
                )}
                {i.state === 'done' && (
                  <div className="mt-0.5 truncate text-[10px] text-[var(--color-text-faint)]">
                    {copied === i.key ? 'path copied' : `${fmtBytes(i.total)} · tap to copy the path`}
                  </div>
                )}
              </button>
              {i.state === 'done' && <Check size={13} className="shrink-0 text-[var(--color-accent)]" />}
              {(i.state === 'done' || i.state === 'err') && (
                <button
                  type="button"
                  onClick={() => up.dismiss(i.key)}
                  aria-label={`Dismiss ${i.name}`}
                  className="shrink-0 p-1 text-[var(--color-text-faint)] active:text-[var(--color-danger)]"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
