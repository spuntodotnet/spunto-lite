"use client"

import { Suspense, useMemo, useState } from "react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import type { TooltipValueType } from "recharts"
import { ArrowDownToLine, ArrowUpFromLine, CircleDollarSign, MessagesSquare, RefreshCw, Wrench } from "lucide-react"
import { segColors } from "@spunto/design-system/colors"
import { formatTokens } from "@spunto/design-system/tasks"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import type { UsageGroup, UsageReport, UsageTask } from "@/lib/types"
import { formatRelativeTime } from "@/components/worker-card"

/**
 * What the agents consumed — cost, tokens, turns, tools — over a period, across every project.
 * Spunto's own consumption dashboard (obs, `/consommation`), on Lite's own `task_events`
 * (services/usage.ts). The period lives in the URL (`?days=`), so a view is linkable.
 */

const PERIODS = [
  { value: 1, label: "Today" },
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
  { value: 0, label: "All" },
] as const

// The three parts of the context sent, in the design system's fixed segment order.
const SENT = [
  { key: "cacheRead", label: "cache read", color: segColors.deployments },
  { key: "cacheCreation", label: "cache write", color: segColors.buildcache },
  { key: "input", label: "uncached", color: segColors.workers },
] as const

const tooltipStyle = { background: "var(--popover)", color: "var(--popover-foreground)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 11 }
const axisTick = { fontSize: 10, fill: "var(--muted-foreground)" }
const cursor = { fill: "var(--muted)", opacity: 0.6 }

// Cents hide the sum of a few cheap turns ($0.0123 + $0.0246 is not $0.01 + $0.02): a third
// decimal under a dollar.
const usd = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: n > 0 && n < 1 ? 3 : 2 })}`
const int = (n: number) => Math.round(n).toLocaleString()
const pct = (n: number) => `${n.toLocaleString(undefined, { maximumFractionDigits: n < 10 ? 1 : 0 })}%`
const plural = (n: number, one: string, many = `${one}s`) => `${int(n)} ${n === 1 ? one : many}`
const sent = (t: { input: number; cacheRead: number; cacheCreation: number }) => t.input + t.cacheRead + t.cacheCreation
const num = (v: TooltipValueType | undefined) => (typeof v === "number" ? v : Number(v))
const dayTick = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" })
const dayLabel = (d: unknown) =>
  typeof d === "string" ? new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }) : ""

function seconds(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} s`
  return `${Math.round(ms / 60_000)} min`
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

function StatTile({ icon: Icon, label, value, sub }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="size-4" /> {label}
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </div>
  )
}

function Section({ title, description, children, className }: { title: string; description?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("min-w-0", className)}>
      <div className="mb-3">
        <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
        {description && <p className="text-xs text-muted-foreground/80">{description}</p>}
      </div>
      {children}
    </section>
  )
}

function Legend({ items }: { items: readonly { label: string; color: string }[] }) {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1">
          <span className="size-2 rounded-sm" style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </span>
  )
}

/** The top of an axis: the data's maximum, up to four round steps (1, 2, 2.5 or 5 × 10ⁿ each). */
function niceCeil(max: number): number {
  if (!(max > 0)) return 1
  const raw = max / 4
  const mag = 10 ** Math.floor(Math.log10(raw))
  return 4 * mag * [1, 2, 2.5, 5, 10].find((n) => n * mag >= raw)!
}

/** A chart of one measure per day, one or several stacked series. */
function DailyChart({
  title,
  aside,
  data,
  series,
  format,
}: {
  title: string
  aside?: React.ReactNode
  data: UsageReport["daily"]
  series: readonly { key: string; label: string; color: string }[]
  format: (n: number) => string
}) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="whitespace-nowrap font-medium">{title}</span>
        {aside}
      </div>
      <ResponsiveContainer width="100%" height={160}>
        <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -4 }} barCategoryGap="20%">
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis dataKey="day" tickFormatter={dayTick} tick={axisTick} tickLine={false} axisLine={false} minTickGap={24} />
          <YAxis domain={[0, niceCeil]} tickCount={5} tick={axisTick} tickLine={false} axisLine={false} tickFormatter={(v: number) => format(v)} width={48} />
          <Tooltip
            cursor={cursor}
            contentStyle={tooltipStyle}
            labelFormatter={dayLabel}
            formatter={(v: TooltipValueType | undefined, name) => [format(num(v)), series.find((s) => s.key === name)?.label ?? String(name)]}
          />
          {series.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              stackId="day"
              fill={s.color}
              stroke="var(--card)"
              strokeWidth={series.length > 1 ? 1 : 0}
              radius={i === series.length - 1 ? [3, 3, 0, 0] : 0}
              maxBarSize={28}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/** A share of the total, as a thin bar behind a row. */
function Share({ value, total }: { value: number; total: number }) {
  const p = total > 0 ? (value / total) * 100 : 0
  return (
    <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
      <div className="h-full rounded-full bg-primary/70" style={{ width: `${Math.max(p, p > 0 ? 1 : 0)}%` }} />
    </div>
  )
}

function GroupList({ rows, label, priced }: { rows: UsageGroup[]; label: (g: UsageGroup) => React.ReactNode; priced: boolean }) {
  // Share of cost when anything reported one, else of the tokens generated.
  const measure = (g: UsageGroup) => (priced ? (g.cost ?? 0) : g.output)
  const total = rows.reduce((s, g) => s + measure(g), 0)
  if (rows.length === 0) return <p className="text-xs text-muted-foreground">Nothing in this period.</p>
  return (
    <ul className="space-y-2.5">
      {rows.map((g) => (
        <li key={g.id} className="text-xs">
          <div className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate font-medium">{label(g)}</span>
            <span className="shrink-0 text-muted-foreground tabular-nums">
              {plural(g.tasks, "task")} · {formatTokens(g.output)} out
            </span>
            <span className="w-16 shrink-0 text-right font-mono tabular-nums">{g.cost === null ? "—" : usd(g.cost)}</span>
          </div>
          <Share value={measure(g)} total={total} />
        </li>
      ))}
    </ul>
  )
}

const SORTS = [
  { value: "cost", label: "Most expensive" },
  { value: "tokens", label: "Most tokens" },
  { value: "recent", label: "Recent" },
] as const
type Sort = (typeof SORTS)[number]["value"]

function Tabs<T extends string | number>({ items, value, onChange, label }: { items: readonly { value: T; label: string }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div className="flex w-fit rounded-md border border-border p-0.5" role="tablist" aria-label={label}>
      {items.map((i) => (
        <button
          key={i.value}
          type="button"
          role="tab"
          aria-selected={i.value === value}
          onClick={() => onChange(i.value)}
          className={cn(
            "rounded px-2 py-0.5 text-xs transition-colors",
            i.value === value ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {i.label}
        </button>
      ))}
    </div>
  )
}

function TaskTable({ tasks }: { tasks: UsageTask[] }) {
  const [sort, setSort] = useState<Sort>("cost")
  const [all, setAll] = useState(false)
  const sorted = useMemo(() => {
    const out = [...tasks]
    if (sort === "tokens") out.sort((a, b) => sent(b) + b.output - (sent(a) + a.output))
    else if (sort === "recent") out.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
    else out.sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1) || b.output - a.output)
    return out
  }, [tasks, sort])
  const shown = all ? sorted : sorted.slice(0, 15)

  return (
    <div className="space-y-3">
      <Tabs items={SORTS} value={sort} onChange={setSort} label="Sort tasks" />
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2 font-medium">Task</th>
              <th className="px-3 py-2 text-right font-medium">Cost</th>
              <th className="px-3 py-2 text-right font-medium">Turns</th>
              <th className="px-3 py-2 text-right font-medium" title="Context sent (cached or not) / tokens generated">
                Sent / out
              </th>
              <th className="px-3 py-2 text-right font-medium" title="Largest context of a single call, out of the model's window">
                Peak ctx
              </th>
              <th className="px-3 py-2 text-right font-medium">Tools</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((t) => (
              <tr key={t.id} className="border-b border-border/50 last:border-0">
                <td className="max-w-[320px] px-4 py-2">
                  <Link href={`/projects/${t.projectId}/tasks/${t.id}`} className="block truncate text-[13px] font-medium hover:text-primary" title={t.title}>
                    {t.title}
                  </Link>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {t.projectName ?? "(deleted project)"} · {t.agentAppName}
                    {t.model && <> · <span className="font-mono">{t.model}</span></>} · {formatRelativeTime(t.lastActivityAt)}
                  </div>
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">{t.cost === null ? "—" : usd(t.cost)}</td>
                <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">{int(t.turns)}</td>
                <td className="px-3 py-2 text-right font-mono text-xs tabular-nums whitespace-nowrap">
                  {formatTokens(sent(t))} / {formatTokens(t.output)}
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs tabular-nums whitespace-nowrap">
                  {t.peakContext ? (
                    <>
                      {formatTokens(t.peakContext)}
                      {t.contextWindow ? <span className="text-muted-foreground"> / {formatTokens(t.contextWindow)}</span> : null}
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">
                  {int(t.toolCalls)}
                  {t.toolErrors > 0 && <span className="text-destructive" title={plural(t.toolErrors, "error")}> · {int(t.toolErrors)}✕</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sorted.length > shown.length && (
        <button type="button" onClick={() => setAll(true)} className="text-xs text-muted-foreground hover:text-foreground">
          Show all {int(sorted.length)} tasks
        </button>
      )}
    </div>
  )
}

function ToolTable({ tools, total }: { tools: UsageReport["tools"]; total: number }) {
  if (tools.length === 0) return <p className="text-xs text-muted-foreground">No tool called in this period.</p>
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/30 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            <th className="px-4 py-2 font-medium">Tool</th>
            <th className="px-3 py-2 text-right font-medium">Calls</th>
            <th className="px-3 py-2 text-right font-medium">Share</th>
            <th className="px-3 py-2 text-right font-medium">Errors</th>
            <th className="px-3 py-2 text-right font-medium" title="Average time from the call to its result">
              Avg time
            </th>
          </tr>
        </thead>
        <tbody>
          {tools.slice(0, 25).map((t) => (
            <tr key={t.name} className="border-b border-border/50 last:border-0">
              <td className="max-w-[260px] truncate px-4 py-2 font-mono text-xs" title={t.name}>
                {t.name}
              </td>
              <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">{int(t.n)}</td>
              <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-muted-foreground">{pct((t.n / Math.max(total, 1)) * 100)}</td>
              <td className={cn("px-3 py-2 text-right font-mono text-xs tabular-nums", t.errors > 0 ? "text-destructive" : "text-muted-foreground")}>
                {t.errors > 0 ? `${int(t.errors)} · ${pct((t.errors / t.n) * 100)}` : "—"}
              </td>
              <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-muted-foreground">{t.ms > 0 ? seconds(t.ms / t.n) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Page ────────────────────────────────────────────────────────────────────

function Usage() {
  const router = useRouter()
  const pathname = usePathname()
  const search = useSearchParams()
  const asked = Number(search.get("days") ?? 30)
  const days = PERIODS.some((p) => p.value === asked) ? asked : 30
  const timeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, [])

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ["usage", days, timeZone],
    queryFn: () => api.get<UsageReport>(`/api/usage?days=${days}&tz=${encodeURIComponent(timeZone)}`),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  })

  const setDays = (d: number) => {
    const params = new URLSearchParams(search)
    if (d === 30) params.delete("days")
    else params.set("days", String(d))
    router.replace(params.size ? `${pathname}?${params}` : pathname, { scroll: false })
  }

  const t = data?.totals
  const priced = !!t && t.cost > 0

  return (
    <div className="mx-auto max-w-6xl space-y-8 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-[family-name:var(--font-syne)] text-2xl font-bold tracking-tight">Usage</h1>
          <p className="mt-1 text-sm text-muted-foreground">What your agents consumed across all projects — cost, tokens, turns and tools.</p>
        </div>
        <div className="flex items-center gap-3">
          <RefreshCw className={cn("size-3.5 animate-spin text-muted-foreground transition-opacity", isFetching ? "opacity-100" : "opacity-0")} />
          <Tabs items={PERIODS} value={days} onChange={setDays} label="Period" />
        </div>
      </div>

      {error ? (
        <p className="text-sm text-destructive">Could not load usage: {(error as Error).message}</p>
      ) : isLoading || !data || !t ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : t.tasks === 0 ? (
        <div className="rounded-xl border border-dashed border-border py-12 text-center">
          <MessagesSquare className="mx-auto mb-2 size-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No agent activity in this period.</p>
          <Link href="/agents" className="mt-2 inline-block text-sm text-primary hover:underline">
            Delegate a task
          </Link>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
            <StatTile
              icon={CircleDollarSign}
              label="Cost"
              value={usd(t.cost)}
              sub={t.unpricedTasks > 0 ? `+ ${plural(t.unpricedTasks, "task")} with no reported cost` : "at API prices, as the harness reports it"}
            />
            <StatTile icon={MessagesSquare} label="Turns" value={int(t.turns)} sub={plural(t.tasks, "task")} />
            <StatTile
              icon={ArrowUpFromLine}
              label="Context sent"
              value={formatTokens(sent(t))}
              sub={sent(t) > 0 ? `${pct((t.cacheRead / sent(t)) * 100)} read from cache` : undefined}
            />
            <StatTile icon={ArrowDownToLine} label="Tokens generated" value={formatTokens(t.output)} sub={t.apiCalls ? plural(t.apiCalls, "API call") : undefined} />
            <StatTile icon={Wrench} label="Tool calls" value={int(t.toolCalls)} sub={t.toolCalls ? `${pct((t.toolErrors / t.toolCalls) * 100)} errors` : undefined} />
          </div>

          <div className="grid gap-3 lg:grid-cols-3">
            <DailyChart title="Cost per day" data={data.daily} series={[{ key: "cost", label: "cost", color: "var(--primary)" }]} format={usd} />
            <DailyChart title="Context sent per day" aside={<Legend items={SENT} />} data={data.daily} series={SENT} format={formatTokens} />
            <DailyChart title="Tokens generated per day" data={data.daily} series={[{ key: "output", label: "generated", color: segColors.images }]} format={formatTokens} />
          </div>

          <div className="grid gap-8 lg:grid-cols-12">
            <Section title="Tasks" description="Cost, turns and tokens of each task over the period" className="lg:col-span-8">
              <TaskTable tasks={data.tasks} />
            </Section>
            <div className="space-y-8 lg:col-span-4">
              <Section title="Projects">
                <GroupList rows={data.projects} priced={priced} label={(g) => <Link href={`/projects/${g.id}`} className="hover:text-primary">{g.name}</Link>} />
              </Section>
              <Section title="Agents">
                <GroupList rows={data.apps} priced={priced} label={(g) => g.name} />
              </Section>
              <Section title="Models">
                <GroupList rows={data.models} priced={priced} label={(g) => <span className="font-mono">{g.name}</span>} />
              </Section>
            </div>
          </div>

          <Section title="Tools" description="Calls, share, errors, and the time from call to result">
            <ToolTable tools={data.tools} total={t.toolCalls} />
          </Section>
        </>
      )}
    </div>
  )
}

// Suspense: the page reads its period from the URL (`useSearchParams`).
export default function UsagePage() {
  return (
    <Suspense>
      <Usage />
    </Suspense>
  )
}
