"use client"

import Link from "next/link"
import { useQuery } from "@tanstack/react-query"
import {
  Activity,
  Cpu,
  MemoryStick,
  HardDrive,
  Layers,
  Box,
  Container,
  Code2,
  ChevronRight,
  RefreshCw,
  Server,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import type { ResourcesOverview, ServiceResource, WorkerResource } from "@/lib/types"
import { workerBaseUrl } from "@/lib/worker-url"
import { cfgFor, ResourceBars, formatRelativeTime } from "@/components/worker-card"

// ─── Formatting helpers ──────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 0) return "—"
  if (bytes === 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const val = bytes / Math.pow(1024, i)
  return `${val.toFixed(val >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

function formatMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`
}

const VOLUME_KIND_LABEL: Record<string, string> = {
  workspace: "Workspace",
  docker: "Docker (DinD)",
  containerd: "containerd (DinD)",
  service: "Service data",
  other: "Other",
}

// ─── Summary tile ────────────────────────────────────────────────────────────

function StatTile({
  icon: Icon,
  label,
  value,
  sub,
  accent,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
  sub?: string
  accent?: string
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className={cn("size-4", accent)} /> {label}
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  )
}

// ─── Worker row (container) ──────────────────────────────────────────────────

function WorkerRow({ w }: { w: WorkerResource }) {
  const cfg = cfgFor(w.state)
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={cn("h-2 w-2 rounded-full shrink-0", cfg.dotClass)} />
            <Link
              href={`/projects/${w.projectId}/workers/${w.id}`}
              className="font-semibold text-sm leading-none hover:text-primary truncate"
            >
              {w.name}
            </Link>
            <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium leading-none", cfg.pillClass)}>
              {cfg.label}
            </span>
            <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-mono leading-none bg-muted text-muted-foreground border-border">
              v{w.projectVersion}
            </span>
          </div>
          <div className="mt-1.5 text-[11px] text-muted-foreground flex items-center gap-1.5 flex-wrap">
            <Link href={`/projects/${w.projectId}`} className="hover:text-foreground truncate">
              {w.projectName}
            </Link>
            <span className="text-muted-foreground/40">·</span>
            <span>{formatRelativeTime(w.createdAt)}</span>
          </div>
        </div>
        {w.running && (
          <a
            href={workerBaseUrl(w.id)}
            target="_blank"
            rel="noreferrer"
            title="Open in VS Code"
            className="shrink-0 inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors"
          >
            <Code2 className="size-3.5" /> VS Code
          </a>
        )}
      </div>

      {w.running && w.stats ? (
        <ResourceBars stats={w.stats} />
      ) : (
        <div className="mt-3 rounded-lg border border-border/40 bg-muted/20 px-3 py-2.5 text-[11px] text-muted-foreground">
          Not consuming resources ({cfg.label.toLowerCase()}).
        </div>
      )}
    </div>
  )
}

// ─── Shared-service row (container) ──────────────────────────────────────────

/**
 * A shared service, listed next to the workers because it's the same kind of thing
 * on the daemon — a container burning CPU and RAM — but with a lifecycle of its own:
 * no project, no worker, and it survives both.
 */
function ServiceRow({ s }: { s: ServiceResource }) {
  const cfg = cfgFor(s.state)
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={cn("h-2 w-2 rounded-full shrink-0", cfg.dotClass)} />
            <Link href="/services" className="font-semibold text-sm leading-none hover:text-primary truncate">
              {s.slug}
            </Link>
            <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium leading-none", cfg.pillClass)}>
              {cfg.label}
            </span>
            <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-mono leading-none bg-muted text-muted-foreground border-border">
              shared
            </span>
          </div>
          <div className="mt-1.5 text-[11px] text-muted-foreground flex items-center gap-1.5 flex-wrap">
            <span className="font-mono truncate">{s.address}</span>
            <span className="text-muted-foreground/40">·</span>
            <span className="font-mono truncate" title={s.image}>
              {s.image}
            </span>
          </div>
        </div>
      </div>

      {s.running && s.stats ? (
        <ResourceBars stats={s.stats} />
      ) : (
        <div className="mt-3 rounded-lg border border-border/40 bg-muted/20 px-3 py-2.5 text-[11px] text-muted-foreground">
          Not consuming resources ({cfg.label.toLowerCase()}).
        </div>
      )}
    </div>
  )
}

// ─── Section wrapper ─────────────────────────────────────────────────────────

function SectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
      <span className="inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-muted text-[11px] text-muted-foreground tabular-nums">
        {count}
      </span>
    </div>
  )
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function ResourcesPage() {
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["resources"],
    queryFn: () => api.get<ResourcesOverview>("/api/resources"),
    refetchInterval: 4000,
  })

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-8">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="font-[family-name:var(--font-syne)] text-2xl font-bold tracking-tight">Resources</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Everything that&apos;s switched on across all projects — running containers, live CPU/memory, volumes and images.
          </p>
        </div>
        <div
          className={cn(
            "flex items-center gap-1.5 text-xs text-muted-foreground transition-opacity",
            isFetching ? "opacity-100" : "opacity-0",
          )}
        >
          <RefreshCw className="size-3.5 animate-spin" /> Refreshing…
        </div>
      </div>

      {isLoading || !data ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          {/* Summary tiles */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
            <StatTile
              icon={Activity}
              accent="text-green-500"
              label="Running containers"
              value={`${data.totals.workersRunning + data.totals.servicesRunning}`}
              sub={`${data.totals.workersRunning}/${data.totals.workersTotal} workspaces · ${data.totals.servicesRunning}/${data.totals.servicesTotal} services`}
            />
            <StatTile
              icon={Cpu}
              label="CPU in use"
              value={`${data.totals.cpuPercent.toFixed(1)}%`}
              sub="summed across running"
            />
            <StatTile
              icon={MemoryStick}
              label="Memory in use"
              value={formatMb(data.totals.memUsageMb)}
              sub="summed across running"
            />
            <StatTile
              icon={HardDrive}
              label="Volumes"
              value={`${data.totals.volumesCount}`}
              sub={formatBytes(data.totals.volumesSizeBytes)}
            />
            <StatTile
              icon={Layers}
              label="Project images"
              value={`${data.totals.imagesCount}`}
              sub={formatBytes(data.totals.imagesSizeBytes)}
            />
          </div>

          {/* Containers */}
          <section>
            <SectionHeader title="Containers" count={data.workers.length} />
            {data.workers.length === 0 ? (
              <EmptyState icon={Container} text="No workspaces spawned yet." />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {data.workers.map((w) => (
                  <WorkerRow key={w.id} w={w} />
                ))}
              </div>
            )}
          </section>

          {/* Shared services */}
          <section>
            <SectionHeader title="Shared services" count={data.services.length} />
            {data.services.length === 0 ? (
              <EmptyState icon={Server} text="No shared service declared yet." />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {data.services.map((s) => (
                  <ServiceRow key={s.id} s={s} />
                ))}
              </div>
            )}
          </section>

          {/* Volumes */}
          <section>
            <SectionHeader title="Volumes" count={data.volumes.length} />
            {data.volumes.length === 0 ? (
              <EmptyState icon={HardDrive} text="No worker or service volumes on disk." />
            ) : (
              <div className="overflow-hidden rounded-xl border border-border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/30 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                      <th className="px-4 py-2 font-medium">Volume</th>
                      <th className="px-4 py-2 font-medium">Type</th>
                      <th className="px-4 py-2 font-medium">Owner</th>
                      <th className="px-4 py-2 font-medium text-right">Size</th>
                      <th className="px-4 py-2 font-medium text-center">In use</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.volumes.map((v) => (
                      <tr key={v.name} className="border-b border-border/50 last:border-0">
                        <td className="px-4 py-2 font-mono text-[11px] text-muted-foreground truncate max-w-[240px]" title={v.name}>
                          {v.name}
                        </td>
                        <td className="px-4 py-2 text-xs">{VOLUME_KIND_LABEL[v.kind] ?? v.kind}</td>
                        <td className="px-4 py-2 text-xs">
                          {v.kind === "service" ? (
                            <Link href="/services" className="inline-flex items-center gap-0.5 hover:text-primary truncate">
                              {v.serviceSlug ?? "orphaned service"} <ChevronRight className="size-3" />
                            </Link>
                          ) : v.workerId ? (
                            <span className="truncate">
                              {v.workerName ?? v.workerId}
                              {v.projectName && <span className="text-muted-foreground"> · {v.projectName}</span>}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">orphaned</span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right font-mono tabular-nums text-xs">{formatBytes(v.sizeBytes)}</td>
                        <td className="px-4 py-2 text-center">
                          <span
                            className={cn(
                              "inline-block h-2 w-2 rounded-full",
                              v.inUse ? "bg-green-500" : "bg-zinc-400 dark:bg-zinc-600",
                            )}
                            title={v.inUse ? "Attached to a container" : "Not attached"}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Images */}
          <section>
            <SectionHeader title="Project images" count={data.images.length} />
            {data.images.length === 0 ? (
              <EmptyState icon={Box} text="No project images built yet." />
            ) : (
              <div className="overflow-hidden rounded-xl border border-border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/30 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                      <th className="px-4 py-2 font-medium">Image</th>
                      <th className="px-4 py-2 font-medium">Project</th>
                      <th className="px-4 py-2 font-medium text-right">Containers</th>
                      <th className="px-4 py-2 font-medium text-right">Size</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.images.map((img) => (
                      <tr key={img.ref} className="border-b border-border/50 last:border-0">
                        <td className="px-4 py-2 font-mono text-[11px] text-muted-foreground truncate max-w-[260px]" title={img.ref}>
                          {img.ref}
                        </td>
                        <td className="px-4 py-2 text-xs">
                          {img.projectId ? (
                            <Link href={`/projects/${img.projectId}`} className="inline-flex items-center gap-0.5 hover:text-primary">
                              {img.projectName} <ChevronRight className="size-3" />
                            </Link>
                          ) : (
                            <span className="text-muted-foreground">{img.projectName ?? "—"}</span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right font-mono tabular-nums text-xs">{img.containers < 0 ? "—" : img.containers}</td>
                        <td className="px-4 py-2 text-right font-mono tabular-nums text-xs">{formatBytes(img.sizeBytes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}

function EmptyState({ icon: Icon, text }: { icon: React.ComponentType<{ className?: string }>; text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border py-10 text-center">
      <Icon className="size-6 mx-auto text-muted-foreground mb-2" />
      <p className="text-sm text-muted-foreground">{text}</p>
    </div>
  )
}
