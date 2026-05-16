export function Sparkline({ values, color, height = 18 }: { values: number[]; color: string; height?: number }) {
  if (values.length < 2) return <div className="mt-1.5" style={{ height }} />
  const w = 100
  const h = height
  let min = Math.min(...values)
  let max = Math.max(...values)
  if (max - min < Math.max(1, Math.abs(max) * 0.001)) {
    const mid = (min + max) / 2
    min = mid - 1
    max = mid + 1
  }
  const range = max - min
  const pad = range * 0.15
  min -= pad
  max += pad
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w
    const y = h - ((v - min) / (max - min)) * h
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const last = values[values.length - 1]
  const lastY = h - ((last - min) / (max - min)) * h
  return (
    <svg className="mt-1.5 block w-full" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={w - 1.5} cy={lastY} r={1.5} fill={color} />
    </svg>
  )
}
