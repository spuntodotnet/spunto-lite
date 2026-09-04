"use client"

import { useState } from "react"
import Link from "next/link"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "@spunto/design-system"
import {
  WorkerCard as DsWorkerCard,
  GitStatusSummary,
  ResourceBars,
  SetupProgress,
  StepIndicator,
  formatRelativeTime,
  phaseLabel,
  resolveWorkerStatus,
  setupProgress,
  tagColor,
  type GitRepoStatus,
  type WorkerStats,
  type WorkerStatus,
} from "@spunto/design-system/workers"
import {
  ArrowUpCircle,
  Loader as LoaderIcon,
  ChevronRight,
  MoreVertical,
  Play,
  Square,
  RotateCw,
  Trash2,
  Code2,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import { buttonVariants } from "@/components/ui/button"
import { Tooltip } from "@/components/ui/tooltip"
import { workerBaseUrl } from "@/lib/worker-url"
import type { Worker } from "@/lib/types"

// ─── Status ──────────────────────────────────────────────────────────────────

/**
 * Lite's state machine → the vocabulary `resolveWorkerStatus` speaks.
 *
 * Only two states need translating. `pending` and `building` are Lite's own: the
 * design system resolves anything it doesn't recognise to `pending`, which is
 * *not* flagged as "setting up" — so left as-is they would silently drop the
 * setup progress bar, the one thing worth looking at while a worker boots.
 * `provisioning` is the design system's name for the same moment.
 *
 * Known cost: the pill then reads "Setting up…" where Lite said "Building
 * image…". The package has a `pulling` state but no `building` one, and calling
 * a `docker build` a pull would be worse than being vague.
 */
function toDsState(state: string): string {
  return state === "pending" || state === "building" ? "provisioning" : state
}

export function cfgFor(state: string): WorkerStatus {
  return resolveWorkerStatus({ id: "", state: toDsState(state) })
}

export function isSettingUp(state: string): boolean {
  return cfgFor(state).settingUp
}

/**
 * A worker is out of date when it was built from an older project config than
 * the project's latest version. While it's (re)building we don't flag it — its
 * version is already being bumped to the latest.
 */
export function isOutdated(worker: { projectVersion: number; state: string }, latestVersion: number): boolean {
  return worker.projectVersion < latestVersion && !isSettingUp(worker.state)
}

// The design system owns these now — re-exported so the rest of the app keeps
// importing them from here (same pattern as `components/ui/*`).
export { ResourceBars, SetupProgress, StepIndicator, GitStatusSummary, setupProgress, phaseLabel, formatRelativeTime, tagColor }

/**
 * Lite's container stats. Structurally a `WorkerStats` (so `ResourceBars` takes
 * it as-is) but with every field required: the package widens `memLimitMb` and
 * `memPercent` to optional for apps that don't report them, and Lite's
 * `/api/workers/<id>/stats` always does — a consumer like the memory chart wants
 * the number, not `number | undefined`.
 */
export type Stats = Required<WorkerStats>

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

/** Rebuild-to-latest, with the confirmation the card's own banner doesn't ask for. */
function confirmRebuild(latestVersion: number): boolean {
  return confirm(`Update this workspace to v${latestVersion}?\n\nThe container is recreated on the latest project config — only your workspace (its files) is kept.`)
}

/**
 * Amber "Update to vN" pill shown when a worker runs an older config than the
 * project's latest version. Clicking it triggers the existing rebuild, which
 * re-spawns the container against the latest version (workspace is kept).
 * Asks for confirmation first. Renders nothing when the worker is up to date.
 *
 * Kept for the surfaces that draw their own row — the table, the cockpit header.
 * The card doesn't use it: `WorkerCard` has its own outdated banner.
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
          if (confirmRebuild(latestVersion)) rebuild.mutate()
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

/** What `/api/workers/<id>/git-status` returns — Lite's own shape. */
export type GitStatus = { path: string; branch: string; modified: number; ahead: number; behind: number }

export function repoLabel(path: string) {
  return path.replace("/workspace/", "")
}

/**
 * Repositories to draw as branch chips, in whichever tense we actually know.
 *
 * `WorkerCard` draws this list as given and deliberately doesn't second-guess
 * it: live checkouts once the worker answers `/git-status`, and — before that,
 * or once it's stopped — the branch it was *asked* to clone, which is the only
 * thing we can still say truthfully.
 */
function reposFor(worker: Worker, gitStatus: GitStatus[]): GitRepoStatus[] {
  if (gitStatus.length > 0) {
    return gitStatus.map((r) => ({
      path: r.path,
      name: repoLabel(r.path),
      branch: r.branch,
      modified: r.modified,
      ahead: r.ahead,
      behind: r.behind,
    }))
  }
  return worker.branch ? [{ path: "/workspace", name: "workspace", branch: worker.branch }] : []
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
  const running = worker.state === "ready"
  const { rebuild } = useWorkerMutations(projectId, worker.id)

  const { data: gitStatus = [] } = useQuery({
    queryKey: ["git-status", worker.id],
    queryFn: () => api.get<GitStatus[]>(`/api/workers/${worker.id}/git-status`),
    enabled: running,
    refetchInterval: running ? 10000 : false,
  })

  const repos = reposFor(worker, gitStatus)
  const cockpitHref = `/projects/${projectId}/workers/${worker.id}`

  return (
    <DsWorkerCard
      // Everything but the state passes through untouched; see `toDsState`.
      worker={{ ...worker, state: toDsState(worker.state) }}
      href={cockpitHref}
      render={{ link: ({ href, className, children }) => <Link href={href} className={className}>{children}</Link> }}
      gitStatus={repos}
      // Only a live worker can serve code-server; otherwise the chip stays static.
      repoHref={running ? (repo) => workerBaseUrl(worker.id, { folder: repo.path }) : undefined}
      currentProjectVersion={projectVersion}
      onRebuild={() => confirmRebuild(projectVersion) && rebuild.mutate()}
      rebuilding={rebuild.isPending}
      actions={<ActionsMenu worker={worker} projectId={projectId} latestVersion={projectVersion} />}
      footer={
        <>
          <Link href={cockpitHref} className={cn(buttonVariants({ variant: "default", size: "sm" }), "flex-1 h-7 text-xs gap-1.5")}>
            View <ChevronRight className="h-3.5 w-3.5" />
          </Link>
          {running && (
            <Tooltip content={gitStatus.length > 0 ? <GitStatusSummary repos={repos} /> : null} side="top">
              <a href={workerBaseUrl(worker.id)} target="_blank" rel="noreferrer" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-7 text-xs gap-1.5")}>
                <Code2 className="h-3.5 w-3.5" /> VS Code
              </a>
            </Tooltip>
          )}
        </>
      }
    />
  )
}
