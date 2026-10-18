import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { LucideIcon } from 'lucide-react'
import { fmtBytes } from '../../lib/useThorUpload'
import { copyText } from '../../lib/clipboard'
import { ago, useTick } from './data'
import { Icon, type IconTone } from './icons'
import { Bar, Press, cx, toast } from './ui'
import {
  UP_ICONS, clearLanded, dismissUpload, onUploadSettled, retryUpload, upBusy, uploadItems, useUploadPicker, useUploads,
  type UpItem,
} from './uploads'
import './upload.css'

// The upload rows and the toolbar button. The queue, the transfer and the
// list kept on this device are kit/uploads.tsx.

/** A lucide icon drawn like kit/icons.tsx draws its own (tone, glow on lit ones). */
export function UpIcon({ C, size = 16, tone = 'fg', glow = false, className, style }: {
  C: LucideIcon
  size?: number
  tone?: IconTone
  glow?: boolean
  className?: string
  style?: CSSProperties
}) {
  return (
    <C
      size={size}
      strokeWidth={size <= 12 ? 1.8 : size <= 14 ? 1.6 : 1.4}
      className={cx('vl-icon', `vl-icon-${tone}`, glow && 'vl-icon-glow', className)}
      style={style}
      aria-hidden
    />
  )
}

function Thumb({ item }: { item: UpItem }) {
  // the picture that failed to draw, so a new one gets its own try
  const [broken, setBroken] = useState<string | null>(null)
  const pic = item.thumb && broken !== item.thumb ? item.thumb : null
  return (
    <span className="up-thumb" data-kind={item.kind} aria-hidden>
      {pic
        ? <img src={pic} alt="" draggable={false} onError={() => setBroken(pic)} />
        : <UpIcon C={item.kind === 'video' ? UP_ICONS.video : UP_ICONS.image} size={15} tone="dim" />}
      {item.kind === 'video' && pic && <i className="up-thumb-play" />}
    </span>
  )
}

const pctOf = (i: UpItem) => (i.size ? Math.min(100, Math.floor((i.sent / i.size) * 100)) : 0)

/** landed files stay out in the open this long (pick, send, copy the path); older ones fold behind "Recent" */
const FRESH_MS = 30 * 60_000

/**
 * The rows: files on their way (percent and a gauge), failed ones (why, Retry,
 * dismiss) and the ones that landed in the last half hour, newest first, with
 * the path to copy (a tap on the row or the copy button). Up to `limit`
 * landed rows show; the rest of the kept list opens from "Recent".
 */
export function UploadRows({ limit }: { limit: number }) {
  const list = useUploads()
  const now = useTick(30_000)
  const [all, setAll] = useState(false)
  const [copied, setCopied] = useState<number | null>(null)
  const timer = useRef(0)
  useEffect(() => () => clearTimeout(timer.current), [])

  const copy = async (i: UpItem) => {
    if (!i.path) return
    if (await copyText(i.path)) {
      setCopied(i.key)
      clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(null), 1600)
    } else {
      toast(`Copy failed. The path is ${i.path}`)
    }
  }

  const landed = list.filter((i) => i.state === 'done')
  const fresh = landed.filter((i) => now - i.at < FRESH_MS).slice(0, limit)
  const shownLanded = new Set((all ? landed : fresh).map((i) => i.key))
  const rows = list.filter((i) => i.state !== 'done' || shownLanded.has(i.key))
  const hidden = landed.length - shownLanded.size
  if (!rows.length && !landed.length) return null

  return (
    <div className="up-list">
      {rows.length > 0 && <div className="up-rows" role="list" aria-label="Uploads to thor">
        {rows.map((i) => {
          const pct = pctOf(i)
          const name = <span className="up-name">{i.name}</span>
          return (
            <div key={i.key} className="up-row" data-state={i.state} role="listitem">
              {i.state === 'done' ? (
                <Press className="up-main" onPress={() => void copy(i)} title={i.path} aria-label={`${i.name}, on thor. Copy the path`}>
                  <Thumb item={i} />
                  <span className="up-text">
                    <span className="up-line">{name}</span>
                    <span className="up-meta" data-copied={copied === i.key || undefined}>
                      {copied === i.key ? 'Path copied' : `${fmtBytes(i.size)} · ${now - i.at < 60_000 ? 'just now' : `${ago(i.at, now)} ago`}`}
                    </span>
                  </span>
                </Press>
              ) : (
                <div className="up-main" aria-label={i.state === 'err' ? `${i.name}: ${i.error ?? 'failed'}` : `${i.name}, ${i.state === 'up' ? `${pct}%` : 'waiting'}`}>
                  <Thumb item={i} />
                  <span className="up-text">
                    <span className="up-line">
                      {name}
                      {i.state === 'up' && <span className="up-pct">{pct}<small>%</small></span>}
                    </span>
                    {i.state === 'up' ? (
                      <Bar className="up-bar" value={pct} ticks={4} />
                    ) : (
                      <span className="up-meta">{i.state === 'queued' ? `Waiting · ${fmtBytes(i.size)}` : i.error ?? 'Failed'}</span>
                    )}
                  </span>
                </div>
              )}
              {i.state === 'done' && (
                <Press className="up-act" onPress={() => void copy(i)} aria-label={`Copy the path of ${i.name}`} title="Copy the path">
                  <Icon name={copied === i.key ? 'done' : 'copy'} size={15} tone={copied === i.key ? 'fg' : 'dim'} glow={copied === i.key} />
                </Press>
              )}
              {i.state === 'err' && i.retry && (
                <Press className="up-retry" onPress={() => retryUpload(i.key)} aria-label={`Send ${i.name} again`}>
                  <Icon name="refresh" size={12} tone="fg" />Retry
                </Press>
              )}
              {(i.state === 'err' || i.state === 'queued') && (
                <Press className="up-act" onPress={() => dismissUpload(i.key)} aria-label={`Dismiss ${i.name}`} title="Dismiss">
                  <Icon name="stop" size={14} tone="faint" />
                </Press>
              )}
            </div>
          )
        })}
      </div>}
      {landed.length > 0 && (
        <div className="up-foot">
          {hidden > 0 || all ? (
            <Press className="up-link" onPress={() => setAll((v) => !v)} aria-expanded={all}>
              {all ? 'Show fewer' : fresh.length ? `Show all ${landed.length}` : `Recent uploads · ${landed.length}`}
            </Press>
          ) : <span />}
          {shownLanded.size > 0 && <Press className="up-link up-link-dim" onPress={clearLanded}>Clear list</Press>}
        </div>
      )}
    </div>
  )
}

/**
 * One icon button for a toolbar (AI > Sessions): opens the library picker and
 * says how it went in a toast, with the path to copy. The rows show on the
 * Dashboard, since the queue is the same.
 */
export function UploadButton({ className }: { className?: string }) {
  const pick = useUploadPicker('sessions')
  const list = useUploads()
  const mine = list.filter((i) => i.from === 'sessions' && upBusy(i)).length

  useEffect(() => {
    // landed files collect until the last one from here settles: one toast for the batch
    let landed: UpItem[] = []
    return onUploadSettled((row, ok) => {
      if (row.from !== 'sessions') return
      if (!ok) toast(`${row.name} not sent: ${row.error ?? 'failed'}`, { action: { label: 'Retry', run: () => retryUpload(row.key) } })
      else landed.push(row)
      if (!landed.length || uploadItems().some((i) => i.from === 'sessions' && upBusy(i))) return
      const paths = landed.map((r) => r.path).filter(Boolean).join(' ')
      const msg = landed.length === 1 ? `${landed[0].name} is on thor` : `${landed.length} files are on thor`
      landed = []
      toast(msg, {
        ms: 6000,
        action: {
          label: 'Copy path',
          run: () => void copyText(paths).then((done) => { if (!done) toast(`Copy failed. ${paths}`) }),
        },
      })
    })
  }, [])

  return (
    <>
      {pick.inputs}
      <Press
        className={cx('vl-iconbtn up-btn', className)}
        // the picker opens from the click event (iOS wants a click); Press only gives the pressed look
        onPress={() => {}}
        onClick={pick.openFiles}
        data-lit={mine > 0 || undefined}
        aria-label={mine > 0 ? `Sending ${mine} to thor` : 'Send pictures to thor'}
        title="Send pictures to thor"
      >
        <UpIcon C={UP_ICONS.upload} size={18} tone={mine > 0 ? 'fg' : 'dim'} glow={mine > 0} className={mine > 0 ? 'vl-pulse' : undefined} />
        {mine > 0 && <span className="vl-iconbtn-badge">{mine}</span>}
      </Press>
    </>
  )
}
