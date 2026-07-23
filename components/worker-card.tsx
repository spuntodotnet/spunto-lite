"use client"

import { useState } from "react"
import Link from "next/link"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "@spunto/design-system"
import {
  Cpu,
  MemoryStick,
  GitBranch,
  ExternalLink,
  Clock,
  Loader as LoaderIcon,
  Check as CheckIcon,
  Circle as CircleIcon,
  ChevronRight,
  MoreVertical,
  Play,
  Square,
  RotateCw,
  ArrowUpCircle,
  Trash2,
  Code2,
  X,
  Plus,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import { buttonVariants } from "@/components/ui/button"
import { Tooltip } from "@/components/ui/tooltip"
import { workerBaseUrl } from "@/lib/worker-url"
import type { Worker, SetupStatus } from "@/lib/types"

// ─── State config (adapted to spunto-lite states) ────────────────────────────

type StatusCfg = { label: string; dotClass: string; pillClass: string }

export const STATUS_CONFIG: Record<string, StatusCfg> = {
  ready: {
    label: "Running",
    dotClass: "bg-green-500",
    pillClass: "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20",
  },
  building: {
    label: "Building image…",
    dotClass: "bg-yellow-400",
    pillClass: "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border-yellow-500/20",
  },
  starting: {
    label: "Starting…",
    dotClass: "bg-yellow-400",
    pillClass: "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border-yellow-500/20",
  },
  pending: {
    label: "Pending…",
    dotClass: "bg-yellow-400",
    pillClass: "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border-yellow-500/20",
  },
  stopped: {
    label: "Stopped",
    dotClass: "bg-zinc-400 dark:bg-zinc-500",
    pillClass: "bg-muted text-muted-foreground border-border",
  },
  error: {
    label: "Error",
    dotClass: "bg-red-500",
    pillClass: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20",
  },
}

export function isSettingUp(state: string) {
  return state === "pending" || state === "building" || state === "starting"
}
export function cfgFor(state: string): StatusCfg {
  return STATUS_CONFIG[state] ?? STATUS_CONFIG.pending
}

/**
 * A worker is out of date when it was built from an older project config than
 * the project's latest version. While it's (re)building we don't flag it — its
 * version is already being bumped to the latest.
 */
export function isOutdated(worker: { projectVersion: number; state: string }, latestVersion: number): boolean {
  return worker.projectVersion < latestVersion && !isSettingUp(worker.state)
}

// ─── Setup progress helpers ──────────────────────────────────────────────────

export function setupProgress(status: SetupStatus | null | undefined): number {
  if (!status) return 5
  switch (status.phase) {
    case "initializing":
      return 10
    case "credentials":
      return 25
    case "dotfiles":
      return 35
    case "cloning": {
      const total = status.repos.length || 1
      const done = status.repos.filter((r) => r.state === "done").length
      return 40 + Math.round((done / total) * 30)
    }
    case "lifecycle":
      if (status.postCreate === "running") return 75
      if (status.postCreate === "done" && status.postStart === "running") return 88
      return 80
    case "ready":
    case "error":
      return 100
    default:
      return 5
  }
}

export function phaseLabel(status: SetupStatus | null | undefined): string {
  if (!status) return "Starting up…"
  switch (status.phase) {
    case "initializing":
      return "Starting up…"
    case "credentials":
      return "Configuring credentials…"
    case "dotfiles":
      return "Installing dotfiles…"
    case "cloning":
      return "Cloning repositories…"
    case "lifecycle":
      if (status.postCreate === "running") return "Running post-create command…"
      if (status.postStart === "running") return "Running post-start command…"
      return "Running setup commands…"
    case "ready":
      return "Ready"
    case "error":
      return "Setup failed"
    default:
      return "Setting up…"
  }
}

export function StepIndicator({ state }: { state: "pending" | "running" | "done" | "error" }) {
  if (state === "running") return <LoaderIcon className="h-3 w-3 text-yellow-400 animate-spin shrink-0" />
  if (state === "done") return <CheckIcon className="h-3 w-3 text-green-500 shrink-0" />
  if (state === "error") return <CircleIcon className="h-3 w-3 text-red-500 shrink-0 fill-red-500" />
  return <CircleIcon className="h-3 w-3 text-muted-foreground/30 shrink-0" />
}

// ─── Resource bars (CPU / Memory) ────────────────────────────────────────────

export type Stats = { cpuPercent: number; memUsageMb: number; memLimitMb: number; memPercent: number }

export function ResourceBars({ stats, compact = false }: { stats: Stats; compact?: boolean }) {
  return (
    <div className={cn("grid grid-cols-2 gap-3", compact ? "" : "rounded-lg border border-border/40 bg-muted/20 px-3 py-2.5 mt-3")}>
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Cpu className="h-3 w-3" /> CPU
          </span>
          <span className={cn("text-[11px] font-mono tabular-nums", stats.cpuPercent > 80 ? "text-orange-400" : "text-foreground/70")}>
            {(stats.cpuPercent ?? 0).toFixed(1)}%
          </span>
        </div>
        <div className="h-1 rounded-full bg-muted overflow-hidden">
          <div
            className={cn("h-full rounded-full transition-all duration-500", stats.cpuPercent > 80 ? "bg-destructive" : "bg-primary")}
            style={{ width: `${Math.min(stats.cpuPercent, 100)}%` }}
          />
        </div>
      </div>
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <MemoryStick className="h-3 w-3" /> Memory
          </span>
          <span className="text-[11px] font-mono tabular-nums text-foreground/70">
            {stats.memUsageMb?.toFixed(0)}
            <span className="text-muted-foreground/50"> MB</span>
          </span>
        </div>
        <div className="h-1 rounded-full bg-muted overflow-hidden">
          <div
            className={cn("h-full rounded-full transition-all duration-500", stats.memPercent > 80 ? "bg-destructive" : "bg-build")}
            style={{ width: `${Math.min(stats.memPercent ?? 0, 100)}%` }}
          />
        </div>
      </div>
    </div>
  )
}

// ─── Misc helpers ────────────────────────────────────────────────────────────

const TAG_PALETTES = [
  { bg: "bg-orange-500/12", text: "text-orange-700 dark:text-orange-300", border: "border-orange-400/30" },
  { bg: "bg-amber-500/12", text: "text-amber-700 dark:text-amber-300", border: "border-amber-400/30" },
  { bg: "bg-lime-500/12", text: "text-lime-700 dark:text-lime-300", border: "border-lime-400/30" },
  { bg: "bg-green-500/12", text: "text-green-700 dark:text-green-300", border: "border-green-400/30" },
  { bg: "bg-teal-500/12", text: "text-teal-700 dark:text-teal-300", border: "border-teal-400/30" },
  { bg: "bg-sky-500/12", text: "text-sky-700 dark:text-sky-300", border: "border-sky-400/30" },
  { bg: "bg-violet-500/12", text: "text-violet-700 dark:text-violet-300", border: "border-violet-400/30" },
  { bg: "bg-pink-500/12", text: "text-pink-700 dark:text-pink-300", border: "border-pink-400/30" },
]
export function tagColor(tag: string) {
  let h = 0
  for (let i = 0; i < tag.length; i++) h = (Math.imul(31, h) + tag.charCodeAt(i)) | 0
  return TAG_PALETTES[Math.abs(h) % TAG_PALETTES.length]
}

export function formatRelativeTime(dateStr: string): string {
  const d = new Date(dateStr).getTime()
  const diff = Date.now() - d
  const m = Math.floor(diff / 60000)
  if (m < 1) return "just now"
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

// ─── Worker mutations + actions menu ─────────────────────────────────────────

export function useWorkerMutations(projectId: string, workerId: string) {
  const qc = useQueryClient()
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["workers", projectId] })
    qc.invalidateQueries({ queryKey: ["worker", workerId] })
  }
  const stop = useMutation({ mutationFn: () => api.post(`/api/workers/${workerId}/stop`), onSuccess: invalidate, onError: (e) => toast.error((e as Error).message) })
  const start = useMutation({ mutationFn: () => api.post(`/api/workers/${workerId}/start`), onSuccess: invalidate, onError: (e) => toast.error((e as Error).message) })
  const rebuild = useMutation({ mutationFn: () => api.post(`/api/workers/${workerId}/rebuild`), onSuccess: () => { invalidate(); toast.success("Rebuilding…") }, onError: (e) => toast.error((e as Error).message) })
  const del = useMutation({ mutationFn: () => api.del(`/api/workers/${workerId}`), onSuccess: invalidate, onError: (e) => toast.error((e as Error).message) })
  return { stop, start, rebuild, del }
}

/**
 * Amber "Update to vN" pill shown when a worker runs an older config than the
 * project's latest version. Clicking it triggers the existing rebuild, which
 * re-spawns the container against the latest version (workspace is kept).
 * Asks for confirmation first. Renders nothing when the worker is up to date.
 */
export function WorkerUpdateButton({ worker, projectId, latestVersion }: { worker: Worker; projectId: string; latestVersion: number }) {
  const { rebuild } = useWorkerMutations(projectId, worker.id)
  if (!isOutdated(worker, latestVersion)) return null
  return (
    <Tooltip content={`Rebuild to update this workspace from v${worker.projectVersion} to the latest project config (v${latestVersion}). Your workspace is kept.`} side="top">
      <button
        type="button"
        disabled={rebuild.isPending}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          if (confirm(`Update this workspace to v${latestVersion}?\n\nThe container is recreated on the latest project config — only your workspace (its files) is kept.`)) rebuild.mutate()
        }}
        className="inline-flex items-center gap-1 rounded-full border border-amber-400/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium leading-none text-amber-600 dark:text-amber-400 transition-colors hover:bg-amber-500/20 disabled:opacity-50"
      >
        {rebuild.isPending ? <LoaderIcon className="h-3 w-3 animate-spin" /> : <ArrowUpCircle className="h-3 w-3" />}
        Update to v{latestVersion}
      </button>
    </Tooltip>
  )
}

function ActionsMenu({ worker, projectId, latestVersion }: { worker: Worker; projectId: string; latestVersion: number }) {
  const [open, setOpen] = useState(false)
  const { stop, start, rebuild, del } = useWorkerMutations(projectId, worker.id)
  const running = worker.state === "ready"
  const stopped = worker.state === "stopped"
  const outdated = isOutdated(worker, latestVersion)

  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-accent transition-colors"
      >
        <MoreVertical className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute right-0 top-8 z-20 min-w-52 rounded-lg border border-border bg-popover shadow-lg py-1 text-xs">
          {running && (
            <a href={workerBaseUrl(worker.id)} target="_blank" rel="noreferrer" className="flex items-center gap-2 px-3 py-2 hover:bg-accent">
              <Code2 className="h-3.5 w-3.5" /> Open in VS Code
            </a>
          )}
          {stopped ? (
            <button onMouseDown={() => start.mutate()} className="w-full flex items-center gap-2 px-3 py-2 hover:bg-accent">
              <Play className="h-3.5 w-3.5" /> Start
            </button>
          ) : (
            <button onMouseDown={() => stop.mutate()} className="w-full flex items-center gap-2 px-3 py-2 hover:bg-accent">
              <Square className="h-3.5 w-3.5" /> Stop
            </button>
          )}
          <button onMouseDown={() => rebuild.mutate()} className="w-full flex items-center gap-2 px-3 py-2 hover:bg-accent">
            <RotateCw className="h-3.5 w-3.5" /> Rebuild
            {outdated && <span className="ml-auto text-[10px] font-medium text-amber-600 dark:text-amber-400">v{latestVersion} available</span>}
          </button>
          <div className="my-1 border-t border-border/60" />
          <button
            onMouseDown={() => confirm("Delete this workspace?") && del.mutate()}
            className="w-full flex items-center gap-2 px-3 py-2 hover:bg-destructive/10 text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </button>
        </div>
      )}
    </div>
  )
}

// ─── WorkerCard ──────────────────────────────────────────────────────────────

export type GitStatus = { path: string; branch: string; modified: number; ahead: number; behind: number }

function repoLabel(path: string) {
  return path.replace("/workspace/", "")
}

/** Per-repo git state (branch + modified/ahead/behind) — used in the VS Code tooltip. */
export function GitStatusSummary({ gitStatus }: { gitStatus: GitStatus[] }) {
  if (gitStatus.length === 0) return <span className="text-muted-foreground">No repositories</span>
  return (
    <div className="flex flex-col gap-1 text-left">
      {gitStatus.map((repo) => (
        <div key={repo.path} className="flex items-center gap-1.5 font-mono text-[11px]">
          <span className="font-medium text-foreground/80">{repoLabel(repo.path)}</span>
          <GitBranch className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
          <span className="text-muted-foreground">{repo.branch || "—"}</span>
          {repo.modified > 0 && <span className="text-amber-500 dark:text-amber-400">+{repo.modified}</span>}
          {repo.ahead > 0 && <span className="text-primary">↑{repo.ahead}</span>}
          {repo.behind > 0 && <span className="text-orange-400">↓{repo.behind}</span>}
        </div>
      ))}
    </div>
  )
}

export function WorkerCard({
  worker,
  projectId,
  projectVersion,
}: {
  worker: Worker
  projectId: string
  projectVersion: number
}) {
  const settingUp = isSettingUp(worker.state)
  const running = worker.state === "ready"
  const cfg = cfgFor(worker.state)
  const status = worker.setupStatus
  const pct = setupProgress(status)
  const isSetupError = worker.state === "error"

  const { data: gitStatus = [] } = useQuery({
    queryKey: ["git-status", worker.id],
    queryFn: () => api.get<GitStatus[]>(`/api/workers/${worker.id}/git-status`),
    enabled: running,
    refetchInterval: running ? 10000 : false,
  })

  const cockpitHref = `/projects/${projectId}/workers/${worker.id}`

  return (
    <div className="rounded-xl border border-border bg-card transition-colors hover:shadow-sm">
      {/* Header */}
      <div className="px-4 pt-3.5 pb-3 flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className="relative mt-1 shrink-0">
            <div className={cn("h-2 w-2 rounded-full", settingUp ? "bg-yellow-400" : cfg.dotClass)} />
            {running && <div className="absolute inset-0 h-2 w-2 rounded-full bg-green-500 animate-ping opacity-50" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <Link href={cockpitHref} className="font-semibold text-sm leading-none hover:text-primary">
                {worker.name}
              </Link>
              <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium leading-none", cfg.pillClass)}>
                {cfg.label}
              </span>
              <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-mono leading-none bg-muted text-muted-foreground border-border">
                v{worker.projectVersion}
              </span>
              <WorkerUpdateButton worker={worker} projectId={projectId} latestVersion={projectVersion} />
              {worker.tags.map((tag) => {
                const c = tagColor(tag)
                return (
                  <span key={tag} className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium leading-none", c.bg, c.text, c.border)}>
                    {tag}
                  </span>
                )
              })}
            </div>
            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground/60">
                <Clock className="h-3 w-3" /> {formatRelativeTime(worker.createdAt)}
              </span>
            </div>
          </div>
        </div>
        <ActionsMenu worker={worker} projectId={projectId} latestVersion={projectVersion} />
      </div>

      {/* Setup progress */}
      {settingUp && (
        <div className="px-4 pb-3">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-mono text-yellow-500 dark:text-yellow-400">{phaseLabel(status)}</span>
            <span className="text-[11px] font-mono text-muted-foreground tabular-nums">{pct}%</span>
          </div>
          <div className="h-1 rounded-full bg-muted overflow-hidden">
            <div className={cn("h-full rounded-full transition-all duration-700", isSetupError ? "bg-red-500" : "bg-yellow-400")} style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {/* Git branch chips — clickable, each opens VS Code on that repo folder */}
      {running && gitStatus.length > 0 && (
        <div className="px-4 pb-3 flex flex-wrap gap-1.5">
          {gitStatus.map((repo) => (
            <a
              key={repo.path}
              href={workerBaseUrl(worker.id, { folder: repo.path })}
              target="_blank"
              rel="noreferrer"
              title={`Open ${repoLabel(repo.path)} in VS Code`}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground font-mono transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-foreground"
            >
              <span className="font-medium text-foreground/70">{repoLabel(repo.path)}</span>
              <span className="text-muted-foreground/40 mx-0.5">·</span>
              <GitBranch className="h-2.5 w-2.5 shrink-0" />
              <span className="truncate max-w-[120px]">{repo.branch || "—"}</span>
              {repo.modified > 0 && <span className="text-amber-500 dark:text-amber-400 ml-0.5">+{repo.modified}</span>}
              {repo.ahead > 0 && <span className="text-primary ml-0.5">↑{repo.ahead}</span>}
              {repo.behind > 0 && <span className="text-orange-400 ml-0.5">↓{repo.behind}</span>}
            </a>
          ))}
        </div>
      )}

      {/* Footer */}
      <div className="px-3 py-2 border-t border-border/50 bg-muted/20 rounded-b-xl flex items-center gap-1.5">
        <Link href={cockpitHref} className={cn(buttonVariants({ variant: "default", size: "sm" }), "flex-1 h-7 text-xs gap-1.5")}>
          View <ChevronRight className="h-3.5 w-3.5" />
        </Link>
        {running && (
          <Tooltip content={gitStatus.length > 0 ? <GitStatusSummary gitStatus={gitStatus} /> : null} side="top">
            <a href={workerBaseUrl(worker.id)} target="_blank" rel="noreferrer" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-7 text-xs gap-1.5")}>
              <Code2 className="h-3.5 w-3.5" /> VS Code
            </a>
          </Tooltip>
        )}
      </div>
    </div>
  )
}

export { X as XIcon, Plus as PlusIcon }
