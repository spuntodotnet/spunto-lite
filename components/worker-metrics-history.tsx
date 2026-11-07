"use client"

// A worker's resource history, under the live bars of a task's Monitoring block: the samples Lite
// takes itself every 30 s (services/worker-metrics.ts), averaged per bucket. Spunto Cloud's
// `SandboxMetricsHistory`, the same charts and ranges, read from SQLite instead of OpenObserve.

import { useState } from "react"
import { useQuery, keepPreviousData } from "@tanstack/react-query"
import { Area, AreaChart, CartesianGrid, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import type { TooltipValueType } from "recharts"
import { ActivityIcon, CpuIcon, MemoryStickIcon } from "lucide-react"
import { chartColors } from "@spunto/design-system/colors"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"

export const RANGES = ["1h", "6h", "24h", "7d"] as const
export type Range = (typeof RANGES)[number]
const REFETCH_MS: Record<Range, number> = { "1h": 30_000, "6h": 60_000, "24h": 5 * 60_000, "7d": 10 * 60_000 }

type MetricPoint = { t: string; cpuPercent: number | null; cpuPercentMax: number | null; memUsedMb: number | null; memTotalMb: number | null }
type Metrics = { available: boolean; range: Range; points: MetricPoint[] }

const tooltipStyle = { background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 6, fontSize: 11 }
const axisTick = { fontSize: 9, fill: "hsl(var(--muted-foreground))" }
const num = (v: TooltipValueType | undefined) => (typeof v === "number" ? v : Number(v))
const tick = (iso: string, range: Range) => {
  const d = new Date(iso)
  return range === "7d"
    ? d.toLocaleDateString(undefined, { day: "numeric", month: "short" })
    : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
}
const label = (iso: unknown) => (typeof iso === "string" ? new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }) : "")
const mb = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${n.toFixed(0)} MB`)

function RangeTabs({ range, onChange }: { range: Range; onChange: (r: Range) => void }) {
  return (
    <div className="flex rounded-md border border-border p-0.5" role="tablist" aria-label="Time range">
      {RANGES.map((r) => (
        <button
          key={r}
          type="button"
          role="tab"
          aria-selected={r === range}
          onClick={() => onChange(r)}
          className={cn(
            "rounded px-1.5 py-0.5 font-mono text-[10px] tabular-nums transition-colors",
            r === range ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {r}
        </button>
      ))}
    </div>
  )
}

type Series = { key: string; label: string; color: string; dashed?: boolean }

function MiniChart({
  icon: Icon,
  title,
  latest,
  data,
  series,
  format,
  tickFormat,
  range,
  max,
}: {
  icon: typeof CpuIcon
  title: string
  latest: string | null
  data: MetricPoint[]
  series: Series[]
  format: (n: number) => string
  /** The axis' ticks, shorter than the tooltip's figures (the column is a few hundred pixels wide). */
  tickFormat?: (n: number) => string
  range: Range
  max?: number
}) {
  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-center gap-1.5">
        <Icon className="h-3 w-3 text-muted-foreground" />
        <span className="truncate font-mono text-xs text-muted-foreground">{title}</span>
        {latest && <span className="ml-auto font-mono text-xs tabular-nums text-foreground/80">{latest}</span>}
      </div>
      <ResponsiveContainer width="100%" height={70}>
        <AreaChart data={data} margin={{ top: 2, right: 4, bottom: 0, left: -8 }}>
          <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" opacity={0.5} vertical={false} />
          <XAxis dataKey="t" tickFormatter={(t: string) => tick(t, range)} tick={axisTick} tickLine={false} axisLine={false} minTickGap={40} />
          <YAxis
            domain={[0, max ?? "auto"]}
            tick={axisTick}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => (tickFormat ?? format)(v)}
            width={44}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            labelFormatter={label}
            formatter={(v: TooltipValueType | undefined, name) => [
              Number.isFinite(num(v)) ? format(num(v)) : "—",
              series.find((x) => x.key === name)?.label ?? String(name),
            ]}
          />
          {series.map((x) =>
            x.dashed ? (
              <Line
                key={x.key}
                type="monotone"
                dataKey={x.key}
                stroke={x.color}
                strokeOpacity={0.5}
                strokeDasharray="3 3"
                strokeWidth={1}
                dot={false}
                isAnimationActive={false}
              />
            ) : (
              <Area
                key={x.key}
                type="monotone"
                dataKey={x.key}
                stroke={x.color}
                fill={x.color}
                fillOpacity={0.15}
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            ),
          )}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

export function WorkerMetricsHistory({ workerId }: { workerId: string }) {
  const [range, setRange] = useState<Range>("1h")
  const { data, isLoading } = useQuery({
    queryKey: ["worker-metrics", workerId, range],
    queryFn: () => api.get<Metrics>(`/api/workers/${workerId}/metrics?range=${range}`),
    refetchInterval: REFETCH_MS[range],
    placeholderData: keepPreviousData,
  })
  const points = data?.points ?? []
  const lastOf = (k: "cpuPercent" | "memUsedMb") => [...points].reverse().find((p) => p[k] != null)?.[k] ?? null
  const cpu = lastOf("cpuPercent")
  const mem = lastOf("memUsedMb")
  const memTotal = points.reduce((m, p) => Math.max(m, p.memTotalMb ?? 0), 0) || undefined

  return (
    <div className="space-y-3" data-slot="worker-metrics-history">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
          <ActivityIcon className="h-3 w-3" /> History
        </span>
        <RangeTabs range={range} onChange={setRange} />
      </div>
      {isLoading && !data ? (
        <p className="py-4 text-center font-mono text-xs text-muted-foreground">Loading…</p>
      ) : points.length === 0 ? (
        <p className="py-4 text-center text-xs text-muted-foreground">No samples in this range yet — Lite measures a running worker every 30 s.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          <MiniChart
            icon={CpuIcon}
            title="CPU % · avg / max"
            latest={cpu != null ? `${cpu.toFixed(1)}%` : null}
            data={points}
            series={[
              { key: "cpuPercentMax", label: "max", color: chartColors.cpu, dashed: true },
              { key: "cpuPercent", label: "avg", color: chartColors.cpu },
            ]}
            format={(n) => `${Math.round(n)}%`}
            range={range}
          />
          <MiniChart
            icon={MemoryStickIcon}
            title="Memory"
            latest={mem != null ? mb(mem) : null}
            data={points}
            series={[{ key: "memUsedMb", label: "used", color: chartColors.memory }]}
            format={mb}
            tickFormat={(n) => (n >= 1024 ? `${(n / 1024).toFixed(1)}G` : `${Math.round(n)}M`)}
            range={range}
            max={memTotal}
          />
        </div>
      )}
    </div>
  )
}
