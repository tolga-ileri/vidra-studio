import { useState } from "react"

import { cn } from "@/lib/utils"

/**
 * Minimal hand-written SVG charts. Values are drawn as given; callers pass only
 * real recorded data (no interpolation, no invented points).
 */

export interface Bar {
  key: string
  label: string
  value: number
  /** Optional second series stacked on top (e.g. failures). */
  value2?: number
}

export function ColumnChart({
  data,
  format,
  height = 160,
  ariaLabel,
  legend,
}: {
  data: Bar[]
  format: (n: number) => string
  height?: number
  ariaLabel: string
  legend?: [string, string]
}) {
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(...data.map((d) => d.value + (d.value2 ?? 0)), 0)
  const w = 100 / Math.max(1, data.length)
  const labelEvery = Math.ceil(data.length / 8)
  const active = hover != null ? data[hover] : null
  return (
    <figure className="space-y-2">
      <div className="flex h-5 items-center justify-between text-xs">
        <span className="text-muted-foreground">{active ? active.label : ""}</span>
        <span className="tabular-nums">
          {active ? (
            <>
              {format(active.value)}
              {active.value2 != null && legend && (
                <span className="text-muted-foreground">
                  {" "}
                  · {legend[1]} {format(active.value2)}
                </span>
              )}
            </>
          ) : (
            ""
          )}
        </span>
      </div>
      <svg
        role="img"
        aria-label={ariaLabel}
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height }}
        onMouseLeave={() => setHover(null)}
      >
        <line x1="0" x2="100" y1={height - 0.5} y2={height - 0.5} stroke="rgb(255 255 255 / 0.1)" vectorEffect="non-scaling-stroke" />
        {data.map((d, i) => {
          const h1 = max ? (d.value / max) * (height - 4) : 0
          const h2 = max ? ((d.value2 ?? 0) / max) * (height - 4) : 0
          const bw = Math.min(w * 0.7, 6)
          const x = i * w + (w - bw) / 2
          return (
            <g key={d.key} onMouseEnter={() => setHover(i)}>
              <rect x={i * w} y={0} width={w} height={height} fill="transparent" />
              <rect x={x} y={height - h1} width={bw} height={h1} rx={0.4} className={cn("fill-white/70", hover === i && "fill-white")} />
              {h2 > 0 && <rect x={x} y={height - h1 - h2} width={bw} height={h2} rx={0.4} className="fill-destructive/70" />}
            </g>
          )
        })}
      </svg>
      <div className="relative h-4 text-[10px] text-muted-foreground">
        {data.map((d, i) =>
          i % labelEvery === 0 ? (
            <span key={d.key} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${(i + 0.5) * w}%` }}>
              {d.label}
            </span>
          ) : null
        )}
      </div>
      {legend && (
        <figcaption className="flex gap-4 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-sm bg-white/70" />
            {legend[0]}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-sm bg-destructive/70" />
            {legend[1]}
          </span>
        </figcaption>
      )}
      <table className="sr-only">
        <tbody>
          {data.map((d) => (
            <tr key={d.key}>
              <th>{d.label}</th>
              <td>{format(d.value)}</td>
              {d.value2 != null && <td>{format(d.value2)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  )
}

export function BarList({ data, format, ariaLabel }: { data: Bar[]; format: (n: number) => string; ariaLabel: string }) {
  const max = Math.max(...data.map((d) => d.value), 0)
  return (
    <ul className="space-y-2.5" aria-label={ariaLabel}>
      {data.map((d) => (
        <li key={d.key} className="space-y-1">
          <div className="flex justify-between gap-3 text-xs">
            <span className="truncate">{d.label}</span>
            <span className="tabular-nums text-muted-foreground">{format(d.value)}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.05]">
            <div className="h-full rounded-full bg-white/70" style={{ width: `${max ? (d.value / max) * 100 : 0}%` }} />
          </div>
        </li>
      ))}
    </ul>
  )
}
