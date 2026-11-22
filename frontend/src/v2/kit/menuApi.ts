import type { MouseEvent as ReactMouseEvent } from 'react'
import type { LucideIcon } from 'lucide-react'
import { copyText } from '../../lib/clipboard'
import { toast } from './ui'

// The context menu's doors (kit/menu.tsx draws it): addMenu for a screen's own rows, from its onContextMenu.

export type MenuItem = {
  label: string
  icon?: LucideIcon
  /** dim text at the right end: a shortcut */
  hint?: string
  run: () => void
  disabled?: boolean
  danger?: boolean
}

export const menuAdded = new WeakMap<Event, MenuItem[][]>()

/** Add a section to the menu this right click (or long press) opens. Call it from onContextMenu; inner calls come first. */
export function addMenu(e: ReactMouseEvent | MouseEvent, items: (MenuItem | false | null | undefined | '' | 0)[]): void {
  const ev = 'nativeEvent' in e ? e.nativeEvent : e
  const list = items.filter(Boolean) as MenuItem[]
  if (!list.length) return
  const cur = menuAdded.get(ev) ?? []
  cur.push(list)
  menuAdded.set(ev, cur)
}

/** Copy, with the toast the menu's rows say. */
export async function copyWithToast(text: string, what = 'Copied'): Promise<void> {
  toast((await copyText(text)) ? what : 'Could not reach the clipboard', { ms: 1800 })
}
