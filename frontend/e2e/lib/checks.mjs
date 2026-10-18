// Checks that run inside the page. Each function is serialized with
// toString(), so it must be self-contained (no closures over this module).

/** The shell's layout and the active screen's state, in one read. */
export function layoutReport() {
  const W = document.documentElement.clientWidth
  const H = window.innerHeight
  const box = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }
  }
  const shown = (el) => {
    if (!el) return false
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05
  }
  const tag = (el) => (el ? `${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}` : '')
  const area = document.querySelector('.vl-page[data-active]') || document.querySelector('.vl-set') || document.querySelector('#root')
  const wide = [...document.querySelectorAll('body *')].filter((e) => {
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.right > W + 1 && getComputedStyle(e).position !== 'fixed' && !e.closest('.vl-page:not([data-active])')
  }).slice(0, 5).map((e) => `${tag(e)} right=${Math.round(e.getBoundingClientRect().right)}`)

  // the lights button: where it is, and that nothing covers it
  const lamp = document.querySelector('.vl-lamp')
  let lampHit = null
  if (lamp) {
    const r = lamp.getBoundingClientRect()
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    lampHit = at && (at === lamp || lamp.contains(at)) ? 'self' : tag(at)
  }

  // the status strip: the date must show whole, and nothing may sit on it
  const strip = document.querySelector('.vl-strip')
  const date = document.querySelector('.vl-strip-date')
  const leftKids = [...document.querySelectorAll('.vl-strip-left > *')].filter(shown)
  let dateClipped = null
  if (date && shown(date)) {
    const d = date.getBoundingClientRect()
    // a clipping box between the date and the strip, or the viewport, cuts it
    for (let a = date.parentElement; a && a !== document.body; a = a.parentElement) {
      const cs = getComputedStyle(a)
      if (cs.overflowX !== 'visible' || a === strip) {
        const r = a.getBoundingClientRect()
        if (d.left < r.left - 0.5 || d.right > r.right + 0.5) { dateClipped = `cut by ${tag(a)}`; break }
      }
      if (a === strip) break
    }
    if (!dateClipped && (d.left < -0.5 || d.right > W + 0.5)) dateClipped = 'runs off the screen'
    // and nothing paints over it
    if (!dateClipped) {
      for (const f of [0.15, 0.5, 0.85]) {
        const at = document.elementFromPoint(d.left + d.width * f, d.top + d.height / 2)
        if (at && at !== date && !date.contains(at)) { dateClipped = `covered by ${tag(at)}`; break }
      }
    }
  }
  const overlapsDate = date && shown(date)
    ? leftKids.filter((k) => {
      const a = k.getBoundingClientRect()
      const b = date.getBoundingClientRect()
      return a.right > b.left + 0.5 && a.left < b.right - 0.5 && a.bottom > b.top && a.top < b.bottom
    }).map(tag)
    : []

  // visible "Loading" / "Reading" lines in the active screen: a screen stuck before its first data
  const loading = []
  if (area) {
    const walker = document.createTreeWalker(area, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const s = (n.textContent || '').trim()
      if (!/^(loading|reading)\b/i.test(s)) continue
      const el = n.parentElement
      if (el && shown(el) && !el.closest('[aria-hidden="true"]')) loading.push(s.slice(0, 80))
    }
  }

  const tabs = [...document.querySelectorAll('.vl-nav .vl-tab-prim')].map((e) => ({ label: (e.textContent || '').trim(), box: box(e), on: e.getAttribute('aria-current') === 'page', shown: shown(e) }))
  const subs = [...document.querySelectorAll('.vl-nav .vl-tab-sub')].map((e) => ({ label: (e.textContent || '').trim(), box: box(e), on: e.getAttribute('aria-current') === 'page', shown: shown(e) }))
  const txt = area ? (area.innerText || '').replace(/\s+/g, ' ').trim() : ''

  return {
    W, H,
    path: location.pathname,
    v2: document.documentElement.hasAttribute('data-v2'),
    mode: document.documentElement.dataset.mode ?? null,
    docSW: document.documentElement.scrollWidth,
    areaSW: area ? area.scrollWidth : 0,
    areaCW: area ? area.clientWidth : 0,
    wide,
    crash: /render failed|VALKYRIE CRASH/i.test(document.body.innerText || ''),
    // what is on screen when v2 is not (the sign-in gate, a blank reload)
    body: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    nav: box(document.querySelector('.vl-nav')),
    setbar: box(document.querySelector('.vl-setbar')),
    gear: box(document.querySelector('.vl-strip-gear')),
    tabs, subs,
    lamp: box(lamp), lampShown: shown(lamp), lampHit,
    strip: box(strip),
    five: !!document.querySelector('.vl-strip-five') && shown(document.querySelector('.vl-strip-five')),
    stripText: strip ? (strip.innerText || '').replace(/\s+/g, ' ').trim() : '',
    date: box(date), dateShown: shown(date),
    dateClipped,
    dateText: date ? (date.innerText || '').trim() : '',
    overlapsDate,
    loading: [...new Set(loading)].slice(0, 6),
    txt: txt.slice(0, 4000),
    visibility: document.visibilityState,
  }
}

/**
 * Yellow on the Trades view: canvas pixels (the equity chart draws on 2D
 * canvases) and the computed colors of every element. Yellow = hue 40..70,
 * saturated, bright.
 */
export function yellowReport(rootSel) {
  const root = document.querySelector(rootSel)
  if (!root) return { error: `no ${rootSel}` }
  const isYellow = (r, g, b) => {
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    if (max < 140 || max === min) return false
    const s = (max - min) / max
    if (s < 0.45) return false
    let h
    if (max === r) h = ((g - b) / (max - min)) % 6
    else if (max === g) h = (b - r) / (max - min) + 2
    else h = (r - g) / (max - min) + 4
    h = (h * 60 + 360) % 360
    return h >= 40 && h <= 70
  }
  const canvases = []
  for (const c of root.querySelectorAll('canvas')) {
    const r = c.getBoundingClientRect()
    if (r.width < 2 || r.height < 2 || !c.width || !c.height) continue
    let data
    try {
      data = c.getContext('2d')?.getImageData(0, 0, c.width, c.height).data
    } catch (e) {
      canvases.push({ w: c.width, h: c.height, error: String(e) })
      continue
    }
    if (!data) { canvases.push({ w: c.width, h: c.height, error: 'no 2d context' }); continue }
    let ink = 0
    let yellow = 0
    const sample = []
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 40) continue
      ink++
      if (isYellow(data[i], data[i + 1], data[i + 2])) {
        yellow++
        if (sample.length < 3) sample.push(`rgba(${data[i]},${data[i + 1]},${data[i + 2]},${data[i + 3]})`)
      }
    }
    canvases.push({ w: c.width, h: c.height, ink, yellow, sample })
  }
  const parse = (v) => {
    const out = []
    const re = /rgba?\(([^)]+)\)/g
    for (let m = re.exec(v); m; m = re.exec(v)) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number)
      if ((p[3] ?? 1) >= 0.3) out.push(p)
    }
    return out
  }
  const dom = []
  for (const el of [root, ...root.querySelectorAll('*')]) {
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.05) continue
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
    const props = {
      color: hasText || el instanceof SVGElement ? cs.color : '',
      background: cs.backgroundColor,
      border: cs.borderTopWidth !== '0px' ? cs.borderTopColor : '',
      fill: el instanceof SVGElement ? cs.fill : '',
      stroke: el instanceof SVGElement && cs.stroke !== 'none' ? cs.stroke : '',
      shadow: `${cs.textShadow} ${cs.boxShadow} ${cs.filter}`,
    }
    for (const [k, v] of Object.entries(props)) {
      if (!v) continue
      const hit = parse(v).find((p) => isYellow(p[0], p[1], p[2]))
      if (hit) {
        const name = `${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : el.className?.baseVal ? '.' + el.className.baseVal.split(' ')[0] : ''}`
        dom.push(`${name} ${k} rgb(${hit.slice(0, 3).join(',')})`)
        break
      }
    }
  }
  return { canvases, dom: [...new Set(dom)] }
}
