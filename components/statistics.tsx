"use client"

// Settings → Statistics (Cloud #802, #803): how long workers take to be usable, and where that time
// goes — every start and every setup of the range on charts over time, one chart per measure: a
// start from disk (seconds) and a new worker whose image is built for it (minutes) never share a
// chart, nor clone and postCreate. Read from what Lite keeps of each start (services/statistics.ts).

import { useMemo, useState } from "react"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { CartesianGrid, ComposedChart, Line, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis } from "recharts"
import { BarChart3Icon, HammerIcon, LayersIcon, RocketIcon, TimerIcon } from "lucide-react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@spunto/design-system"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import type { Project } from "@/lib/types"
import type { LifecycleStats, PhaseSummary } from "@/services/statistics"

const RANGES = ["24h", "7d", "30d", "90d"] as const
type Range = (typeof RANGES)[number]
const SPAN: Record<Range, number> = { "24h": 864e5, "7d": 7 * 864e5, "30d": 30 * 864e5, "90d": 90 * 864e5 }
/** The median line's step: a few dozen points over the range. */
const BUCKET: Record<Range, number> = { "24h": 3600e3, "7d": 6 * 3600e3, "30d": 864e5, "90d": 3 * 864e5 }
const BUCKET_LABEL: Record<Range, string> = { "24h": "hour", "7d": "6 h", "30d": "day", "90d": "3 days" }

const PHASE: Record<string, { label: string; hint: string }> = {
  image: { label: "Image", hint: "The project's image — built for this worker, or found in Docker's cache" },
  container: { label: "Container", hint: "The container created and started" },
  boot: { label: "Boot", hint: "From the container's start to its agent's first hello" },
  recipe: { label: "Recipe", hint: "The agent gets its plan and bakes what the image lacks" },
  initializing: { label: "Initialize", hint: "From the setup script's start to its first step" },
  credentials: { label: "Credentials", hint: "Your SSH key and git identity" },
  shell: { label: "Shell", hint: "Shell and environment" },
  dotfiles: { label: "Dotfiles", hint: "Your dotfiles repository" },
  cloning: { label: "Clone repos", hint: "The project's repositories" },
  postCreate: { label: "postCreate", hint: "The project's postCreateCommand" },
  postStart: { label: "postStart", hint: "The project's postStartCommand" },
}
const KIND: Record<string, string> = { spawn: "New worker", rebuild: "Rebuild", start: "Start" }
const ORIGIN: Record<string, string> = { built: "image built for it", cached: "image from the cache", disk: "from its disk" }
const KIND_HINT: Record<string, string> = {
  "spawn/built": "a new worker whose image had to be built: the build and the whole setup",
  "spawn/cached": "a new worker on an image already built: the whole setup",
  "rebuild/built": "a new container for the same worker, its image rebuilt",
  "rebuild/cached": "a new container for the same worker",
  "start/disk": "a stopped worker started again from its disk — postStart replayed",
}

function seconds(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`
  if (ms < 120_000) return `${Math.round(ms / 1000)} s`
  return `${(ms / 60_000).toFixed(ms < 600_000 ? 1 : 0)} min`
}
/** An axis tick: as short as it gets, never two ticks alike. */
function tickOf(ms: number): string {
  if (ms === 0) return "0"
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 10_000) return `${+(ms / 1000).toFixed(1)}s`
  if (ms < 120_000) return `${Math.round(ms / 1000)}s`
  return `${+(ms / 60_000).toFixed(1)}m`
}

/** Round steps of time, so a chart reads 0 / 2m / 4m rather than 0 / 4.2m / 8.3m. */
const STEPS = [100, 250, 500, 1e3, 2e3, 5e3, 10e3, 15e3, 30e3, 60e3, 120e3, 300e3, 600e3, 900e3, 1800e3, 3600e3]
function ticksFor(max: number): number[] {
  const step = STEPS.find((s) => max / s <= 4) ?? STEPS[STEPS.length - 1]!
  return Array.from({ length: Math.max(1, Math.ceil(max / step)) + 1 }, (_, i) => i * step)
}

/** A phase whose p95 stays under this is shown in the bars only: a chart of it would be noise. */
const CHART_FLOOR_MS = 1000

const axisTick = { fontSize: 10, fill: "var(--muted-foreground)" }

function Section({ icon: Icon, title, hint, children }: { icon: typeof TimerIcon; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium">
        <span className="flex items-center gap-2">
          <Icon className="h-4 w-4 self-center text-muted-foreground" /> {title}
        </span>
        {hint && <span className="text-xs font-normal text-muted-foreground">{hint}</span>}
      </h2>
      {children}
    </section>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">{children}</p>
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  return s[Math.max(0, Math.ceil(0.5 * s.length) - 1)] ?? 0
}
function p95(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  return s[Math.max(0, Math.ceil(0.95 * s.length) - 1)] ?? 0
}

type Point = { at: number; ms: number }

/**
 * One measure over the range: every occurrence a dot (the spread is the information — a median
 * alone hides a 3 s start behind a 7 min one), and the median per bucket as a line.
 */
function TimeChart({ title, hint, points, range, now, mono }: { title: string; hint?: string; points: Point[]; range: Range; now: number; mono?: boolean }) {
  const from = now - SPAN[range]
  const step = BUCKET[range]
  const line = useMemo(() => {
    const buckets = new Map<number, number[]>()
    for (const p of points) {
      const b = Math.floor((p.at - from) / step)
      buckets.set(b, [...(buckets.get(b) ?? []), p.ms])
    }
    return [...buckets].sort((a, b) => a[0] - b[0]).map(([b, v]) => ({ at: from + (b + 0.5) * step, median: median(v), n: v.length }))
  }, [points, from, step])
  const values = points.map((p) => p.ms)
  const ticks = ticksFor(Math.max(1, ...values))
  const tick = (t: number) => {
    const d = new Date(t)
    return range === "24h" ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString(undefined, { day: "numeric", month: "short" })
  }
  return (
    <div className="min-w-0 rounded-lg border border-border bg-card px-3 pb-2 pt-3" data-slot="statistics-chart">
      <div className="mb-1 flex items-baseline justify-between gap-3 px-1">
        <div className="min-w-0">
          <div className={cn("truncate text-sm font-medium", mono && "font-mono text-[13px]")}>{title}</div>
          {hint && <div className="truncate text-[11px] text-muted-foreground">{hint}</div>}
        </div>
        <div className="shrink-0 text-right">
          <div className="font-mono text-lg font-semibold tabular-nums leading-tight">{seconds(median(values))}</div>
          <div className="font-mono text-[10px] tabular-nums text-muted-foreground">
            median · p95 {seconds(p95(values))} · n={values.length}
          </div>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={150}>
        <ComposedChart margin={{ top: 8, right: 8, bottom: 0, left: -4 }}>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
          <XAxis type="number" dataKey="at" domain={[from, now]} tickFormatter={tick} tick={axisTick} tickLine={false} axisLine={false} minTickGap={36} allowDuplicatedCategory={false} />
          <YAxis type="number" dataKey="ms" domain={[0, ticks[ticks.length - 1]!]} ticks={ticks} tickFormatter={tickOf} tick={axisTick} tickLine={false} axisLine={false} width={50} />
          <Tooltip
            cursor={{ stroke: "var(--muted-foreground)", strokeOpacity: 0.4 }}
            content={({ active, payload }) => {
              const row = active ? (payload?.[0]?.payload as { at: number; ms?: number; median?: number; n?: number } | undefined) : undefined
              if (!row) return null
              const isMedian = row.median != null
              return (
                <div className="rounded-md border border-border bg-card px-2 py-1.5 text-[11px] shadow-sm">
                  <div className="text-muted-foreground">
                    {new Date(row.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: isMedian && range !== "24h" ? undefined : "short" })}
                  </div>
                  <div className="font-mono tabular-nums">{isMedian ? `median ${seconds(row.median!)} · ${row.n} measured` : seconds(row.ms!)}</div>
                </div>
              )
            }}
          />
          <Scatter data={points} dataKey="ms" fill="var(--primary)" fillOpacity={0.45} shape="circle" isAnimationActive={false} />
          <Line data={line} dataKey="median" type="linear" stroke="var(--primary)" strokeWidth={2} dot={false} activeDot={{ r: 3 }} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

function Legend({ range }: { range: Range }) {
  return (
    <div className="flex items-center gap-4 text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-2 w-2 rounded-full bg-primary/50" /> each one
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-0.5 w-4 rounded-full bg-primary" /> median per {BUCKET_LABEL[range]}
      </span>
    </div>
  )
}

const phaseMeta = (phase: string) => ({ ...(PHASE[phase] ?? { label: phase, hint: "" }), mono: phase.startsWith("post") })

/** One bar per phase, on a shared scale: the median filled, the p95 as a tick past it. */
function PhaseBars({ phases }: { phases: PhaseSummary[] }) {
  const scale = Math.max(1, ...phases.map((p) => p.p95Ms))
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="mb-2 flex items-center justify-end gap-4 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-3 rounded-sm bg-primary" /> median
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-0.5 rounded-full bg-foreground/50" /> p95
        </span>
      </div>
      <ul className="space-y-2.5" data-slot="lifecycle-phases">
        {phases.map((p) => {
          const meta = phaseMeta(p.phase)
          return (
            <li
              key={p.phase}
              className="grid grid-cols-[7.5rem_1fr_9.5rem] items-center gap-3"
              title={`${meta.label}${meta.hint ? ` — ${meta.hint}` : ""}\nmedian ${seconds(p.p50Ms)} · p95 ${seconds(p.p95Ms)} · slowest ${seconds(p.maxMs)} · ${p.count} measured`}
            >
              <span className={cn("truncate text-sm", meta.mono && "font-mono text-[13px]")}>{meta.label}</span>
              <div className="relative h-3">
                <div className="absolute inset-y-1 left-0 right-0 rounded-full bg-muted" />
                <div className="absolute inset-y-0 left-0 rounded-r-[4px] bg-primary" style={{ width: `max(2px, ${(p.p50Ms / scale) * 100}%)` }} />
                <div className="absolute -inset-y-0.5 w-0.5 -translate-x-1/2 rounded-full bg-foreground/50" style={{ left: `${(p.p95Ms / scale) * 100}%` }} />
              </div>
              <span className="text-right font-mono text-xs tabular-nums">
                {seconds(p.p50Ms)} <span className="text-muted-foreground">· p95 {seconds(p.p95Ms)}</span>
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

const th = "px-3 py-2 text-right font-medium"
const td = "px-3 py-2 text-right font-mono tabular-nums"

export function Statistics() {
  const [range, setRange] = useState<Range>("30d")
  const [projectId, setProjectId] = useState("")
  const { data: projects = [] } = useQuery({ queryKey: ["projects"], queryFn: () => api.get<Project[]>("/api/projects") })
  const { data, isLoading, dataUpdatedAt } = useQuery({
    queryKey: ["statistics", range, projectId],
    queryFn: () => api.get<LifecycleStats>(`/api/statistics?range=${range}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ""}`),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  })
  const nameOf = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects])
  // The charts end when the data was read: the range is the API's, not the clock's at render.
  const now = data?.to ?? dataUpdatedAt

  const startCharts = useMemo(
    () => (data?.starts ?? []).map((s) => ({ key: `${s.kind}/${s.origin}`, s, points: (data?.startPoints ?? []).filter((p) => p.kind === s.kind && p.origin === s.origin) })),
    [data],
  )
  const phaseCharts = useMemo(() => {
    if (!data) return []
    const runs = data.setupRuns
    const total = { key: "total", title: "Whole start", hint: "from the spawn to ready — image, container and setup", mono: false, points: runs.map((r) => ({ at: r.at, ms: r.totalMs })) }
    const builds = { key: "build", title: "Image build", hint: "each build of a project's image, whatever started it", mono: false, points: data.buildPoints }
    const phases = data.phases
      .filter((p) => p.p95Ms >= CHART_FLOOR_MS)
      .map((p) => ({
        key: p.phase,
        title: PHASE[p.phase]?.label ?? p.phase,
        hint: PHASE[p.phase]?.hint,
        mono: p.phase.startsWith("post"),
        points: runs.flatMap((r) => (r.phases[p.phase] != null ? [{ at: r.at, ms: r.phases[p.phase]! }] : [])),
      }))
    return [total, builds, ...phases].filter((c) => c.points.length > 0)
  }, [data])

  return (
    <div className="space-y-8" data-slot="statistics">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Select value={projectId} onValueChange={(v) => setProjectId((v as string | null) ?? "")}>
          <SelectTrigger className="h-7 w-auto min-w-40 text-xs" aria-label="Project">
            <SelectValue>{(v: unknown) => (v ? (nameOf.get(v as string) ?? "Project") : "All projects")}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">All projects</SelectItem>
            {projects.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex rounded-md border border-border p-0.5" role="tablist" aria-label="Time range">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              role="tab"
              aria-selected={r === range}
              onClick={() => setRange(r)}
              className={cn("rounded px-2 py-0.5 font-mono text-[11px] tabular-nums transition-colors", r === range ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {isLoading && !data ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
      ) : !data ? (
        <Empty>Statistics could not be read.</Empty>
      ) : (
        <>
          <Section icon={RocketIcon} title="Startup times" hint="from the start of a start to the worker being usable — one chart per kind of start">
            {startCharts.length === 0 ? (
              <Empty>No start measured in this range yet — they are kept from this version on.</Empty>
            ) : (
              <>
                <Legend range={range} />
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                  {startCharts.map((c) => (
                    <TimeChart key={c.key} title={`${KIND[c.s.kind] ?? c.s.kind} · ${ORIGIN[c.s.origin] ?? c.s.origin}`} hint={KIND_HINT[c.key]} points={c.points} range={range} now={now} />
                  ))}
                </div>
              </>
            )}
          </Section>

          <Section icon={LayersIcon} title="Setup, phase by phase" hint="each new container's start as Lite and the setup script stamp it; phases under a second are in the bars below">
            {phaseCharts.length === 0 ? (
              <Empty>No setup measured in this range yet.</Empty>
            ) : (
              <>
                <Legend range={range} />
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                  {phaseCharts.map((c) => (
                    <TimeChart key={c.key} title={c.title} hint={c.hint} points={c.points} range={range} now={now} mono={c.mono} />
                  ))}
                </div>
              </>
            )}
          </Section>

          {data.phases.length > 0 && (
            <Section icon={TimerIcon} title="Where the setup goes" hint="the phases side by side, over the whole range — hover for details">
              <PhaseBars phases={data.phases} />
            </Section>
          )}

          {(data.builds.count > 0 || data.builds.failed > 0) && (
            <Section icon={HammerIcon} title="Image builds" hint="a project's image, built when its version changes or on Rebuild">
              <p className="text-sm text-muted-foreground" data-slot="statistics-builds">
                {data.builds.count} built
                {data.builds.p50Ms != null && (
                  <>
                    {" "}
                    · median <span className="font-mono tabular-nums text-foreground">{seconds(data.builds.p50Ms)}</span> · p95{" "}
                    <span className="font-mono tabular-nums text-foreground">{seconds(data.builds.p95Ms ?? 0)}</span>
                  </>
                )}
                {data.builds.failed > 0 && <span className="text-destructive"> · {data.builds.failed} failed</span>}
              </p>
            </Section>
          )}

          {!projectId && data.projects.length > 0 && (
            <Section icon={BarChart3Icon} title="By project" hint="medians — pick a row to see its charts">
              <div className="overflow-x-auto rounded-xl border border-border">
                <table className="w-full text-sm" data-slot="statistics-projects">
                  <thead>
                    <tr className="border-b border-border bg-muted/30 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                      <th className="px-4 py-2 font-medium">Project</th>
                      <th className={th}>Setups</th>
                      <th className={th}>Starts</th>
                      <th className={th}>Setup</th>
                      <th className={th}>Image build</th>
                      <th className={cn(th, "font-mono normal-case")}>postCreate</th>
                      <th className={cn(th, "font-mono normal-case")}>postStart</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.projects.map((p) => (
                      <tr key={p.projectId} className="cursor-pointer border-b border-border/50 last:border-0 hover:bg-muted/30" onClick={() => setProjectId(p.projectId)}>
                        <td className="px-4 py-2">{nameOf.get(p.projectId) ?? <span className="text-muted-foreground">deleted project</span>}</td>
                        <td className={td}>{p.setups}</td>
                        <td className={td}>{p.starts}</td>
                        <td className={td}>{p.setupP50Ms != null ? seconds(p.setupP50Ms) : "—"}</td>
                        <td className={td}>{p.buildP50Ms != null ? seconds(p.buildP50Ms) : "—"}</td>
                        <td className={td}>{p.postCreateP50Ms != null ? seconds(p.postCreateP50Ms) : "—"}</td>
                        <td className={td}>{p.postStartP50Ms != null ? seconds(p.postStartP50Ms) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}
        </>
      )}
    </div>
  )
}
