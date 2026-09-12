"use client"

import { useState } from "react"
import Link from "next/link"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast, type ActionMenuEntry } from "@spunto/design-system"
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
  Play,
  Square,
  RotateCw,
  Trash2,
  Code2,
} from "lucide-react"
import { api } from "@/lib/api"
import { ConfirmDialog } from "@/components/confirm-dialog"
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

// ─── Confirmations ───────────────────────────────────────────────────────────
//
// Both live here rather than at each call site: the card, the table and the
// cockpit all delete a workspace, and the copy below is the only place saying
// what that costs. Three hand-written `confirm()` strings had already started
// drifting from what the API does.

/**
 * Deleting a worker is `removeWorker`: the container, its network, and the three
 * `mp-worker-<id>-*` volumes — workspace included. So uncommitted work is gone,
 * which the old "Delete this workspace?" never said. The project's shared
 * volumes (`mp-proj-*`) are deliberately untouched by that path.
 */
export function DeleteWorkerDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Delete this workspace?"
      description={
        <>
          Its container and its volumes are removed —{" "}
          <span className="font-medium text-foreground">anything uncommitted in /workspace is gone for good</span>. The
          project&rsquo;s shared volumes are left alone. This cannot be undone.
        </>
      }
      confirmLabel="Delete"
      icon={Trash2}
      destructive
      onConfirm={onConfirm}
    />
  )
}

/**
 * Rebuilding is `rebuildWorker`, not `deleteWorker`: the container is dropped and
 * respawned on the project's current version, and the `/workspace` volume — git
 * clone and uncommitted work — survives. Worth stating plainly, since the button
 * sits next to a Delete that doesn't spare it.
 */
export function RebuildWorkerDialog({
  open,
  onOpenChange,
  latestVersion,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  latestVersion: number
  onConfirm: () => void
}) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Update this workspace to v${latestVersion}?`}
      description="The container is recreated on the latest project config. Your workspace is kept — its files, including work you haven't committed."
      confirmLabel={`Update to v${latestVersion}`}
      icon={ArrowUpCircle}
      onConfirm={onConfirm}
    />
  )
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
  const [confirming, setConfirming] = useState(false)
  if (!isOutdated(worker, latestVersion)) return null
  return (
    <>
      <Tooltip content={`Rebuild to update this workspace from v${worker.projectVersion} to the latest project config (v${latestVersion}). Your workspace is kept.`} side="top">
        <button
          type="button"
          disabled={rebuild.isPending}
          onClick={(e) => {
            // The pill sits inside a row that is itself a link to the cockpit.
            e.preventDefault()
            e.stopPropagation()
            setConfirming(true)
          }}
          className="inline-flex items-center gap-1 rounded-full border border-amber-400/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium leading-none text-amber-600 dark:text-amber-400 transition-colors hover:bg-amber-500/20 disabled:opacity-50"
        >
          {rebuild.isPending ? <LoaderIcon className="h-3 w-3 animate-spin" /> : <ArrowUpCircle className="h-3 w-3" />}
          Update to v{latestVersion}
        </button>
      </Tooltip>
      <RebuildWorkerDialog open={confirming} onOpenChange={setConfirming} latestVersion={latestVersion} onConfirm={() => rebuild.mutate()} />
    </>
  )
}

/**
 * The `⋯` menu, as data for the design system's `ActionMenu` — passed through
 * `WorkerCard`'s `menu` prop, which builds the trigger, the popup and the items.
 * What each entry *does* stays here (a mutation); what it looks like belongs to
 * the package.
 *
 * The separators are deliberately unconditional: `ActionMenu` drops any rule
 * left alone by a missing neighbour, so "Open in VS Code" disappearing on a
 * stopped worker can't strand a line at the top of the popup.
 */
function workerMenu(
  worker: Worker,
  latestVersion: number,
  m: ReturnType<typeof useWorkerMutations>,
  onDelete: () => void,
): ActionMenuEntry[] {
  const running = worker.state === "ready"
  const stopped = worker.state === "stopped"

  return [
    // Only a live worker serves code-server.
    running && { label: "Open in VS Code", icon: Code2, href: workerBaseUrl(worker.id), target: "_blank" },
    "separator",
    stopped
      ? { label: "Start", icon: Play, onClick: () => m.start.mutate(), loading: m.start.isPending }
      : { label: "Stop", icon: Square, onClick: () => m.stop.mutate(), loading: m.stop.isPending },
    {
      label: "Rebuild",
      icon: RotateCw,
      onClick: () => m.rebuild.mutate(),
      loading: m.rebuild.isPending,
      // Same nudge as the card's own banner, in the menu's trailing slot.
      shortcut: isOutdated(worker, latestVersion) ? (
        <span className="font-medium text-amber-600 dark:text-amber-400">v{latestVersion} available</span>
      ) : undefined,
    },
    "separator",
    // Opens the card's dialog rather than mutating: an entry that destroys a
    // volume asks first, and the popup is gone by the time the dialog is up.
    { label: "Delete", icon: Trash2, destructive: true, loading: m.del.isPending, onClick: onDelete },
  ]
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
  // One set of mutations for the whole card: the outdated banner and the `⋯`
  // menu both rebuild, and sharing them means a rebuild in flight disables both.
  const mutations = useWorkerMutations(projectId, worker.id)
  const { rebuild, del } = mutations
  // Which confirmation is up, if any. Both are rendered beside the card rather
  // than inside the `⋯` popup, which Base UI unmounts on click.
  const [confirming, setConfirming] = useState<"delete" | "rebuild" | null>(null)

  const { data: gitStatus = [] } = useQuery({
    queryKey: ["git-status", worker.id],
    queryFn: () => api.get<GitStatus[]>(`/api/workers/${worker.id}/git-status`),
    enabled: running,
    refetchInterval: running ? 10000 : false,
  })

  const repos = reposFor(worker, gitStatus)
  const cockpitHref = `/projects/${projectId}/workers/${worker.id}`

  return (
    <>
      <DsWorkerCard
        // Everything but the state passes through untouched; see `toDsState`.
        worker={{ ...worker, state: toDsState(worker.state) }}
        href={cockpitHref}
        render={{ link: ({ href, className, children }) => <Link href={href} className={className}>{children}</Link> }}
        gitStatus={repos}
        // Only a live worker can serve code-server; otherwise the chip stays static.
        repoHref={running ? (repo) => workerBaseUrl(worker.id, { folder: repo.path }) : undefined}
        currentProjectVersion={projectVersion}
        onRebuild={() => setConfirming("rebuild")}
        rebuilding={rebuild.isPending}
        menu={workerMenu(worker, projectVersion, mutations, () => setConfirming("delete"))}
        // No `footer` slot: the package's default is exactly this card's — a
        // full-width "View" to the cockpit. Opening VS Code lives in the `⋯` menu,
        // and each repo chip above already links to code-server on that folder.
      />
      <DeleteWorkerDialog
        open={confirming === "delete"}
        onOpenChange={(o) => !o && setConfirming(null)}
        onConfirm={() => del.mutate()}
      />
      <RebuildWorkerDialog
        open={confirming === "rebuild"}
        onOpenChange={(o) => !o && setConfirming(null)}
        latestVersion={projectVersion}
        onConfirm={() => rebuild.mutate()}
      />
    </>
  )
}
