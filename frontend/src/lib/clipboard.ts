// navigator.clipboard is missing over plain http and inside some webviews, so
// fall back to the old selection trick rather than silently doing nothing.
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* fall through to the textarea path */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-1000px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

// Reading is the half that has no fallback. navigator.clipboard only exists in
// a secure context, and on the tailnet this app is served over plain http, so
// on the phone and in the headset there is no clipboard object at all and
// execCommand has no read counterpart. Callers get null and have to put a field
// on screen instead, where the OS paste menu can do it (see PasteSheet).
export async function readText(): Promise<string | null> {
  try {
    if (!navigator.clipboard?.readText) return null
    const t = await navigator.clipboard.readText()
    return t || null
  } catch {
    // Denied, or a webview that answers with a rejected promise.
    return null
  }
}
