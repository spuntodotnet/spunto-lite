"use client"

import { useRef } from "react"
import { Loader2, RotateCw } from "lucide-react"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  TerminalPanel,
  formatRelativeTime,
  type TerminalHandle,
  type TerminalPanelStatus,
} from "@spunto/design-system"
import { BuildSteps } from "@spunto/design-system/projects"
import { useLogSnapshot } from "@/components/logs-panel"
import { applyBuildLog, planFromLog } from "@/lib/build-steps"
import type { BuildStep, ProjectImageBuild } from "@/lib/types"

/**
 * A build's three states, in the panel's vocabulary. The wording is overridden
 * back to the row's own (`building` / `ready` / `error`) rather than the DS
 * defaults, which are French and generic ("en cours", "terminé", "échec"): this
 * panel opens from a row that just said "ready", and it should say it too.
 */
const PANEL_STATUS: Record<ProjectImageBuild["state"], { status: TerminalPanelStatus; label: string }> = {
  building: { status: "running", label: "building" },
  ready: { status: "success", label: "ready" },
  error: { status: "failed", label: "error" },
}

/**
 * The build log behind a build-cache row, in a side panel.
 *
 * The log itself already existed — but only on a *workspace* page, and only while
 * that workspace had no container yet, which is the one moment you're least likely
 * to be looking for it. Why an image failed to build, or what went into the one
 * you're running on, is a property of the *project*; this is the panel the
 * dashboard opens from the same row, so the gesture is the same on both sides.
 *
 * The frame is the DS `TerminalPanel`, not a header hand-rolled around a bare
 * `Terminal` — the status chip, the image ref and the bar are exactly what it
 * exists to stop every page from re-inventing. `copy` and `download` are opt-in
 * there and earn their place here: reading why a build failed and pasting it
 * somewhere are the same errand.
 *
 * Presentational and controlled: the caller owns `open` and hands over the build
 * it already polls, so the panel never runs a second query against `/builds` while
 * the page behind it is polling the same endpoint — the log updates live as a
 * consequence, without this component knowing a build is in flight.
 */
export function BuildLogsSheet({
  open,
  onOpenChange,
  build,
  targetLabel,
  onRebuild,
  rebuilding = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  build: ProjectImageBuild
  /** The row this was opened from — "local · Docker" in Lite. */
  targetLabel: string
  /** Runs another build of the same version, cache and all. Omitted → no button. */
  onRebuild?: () => void
  rebuilding?: boolean
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* `gap-0` + `p-0`: the panel goes edge to edge under the sheet's own
          header, rather than floating in panel padding. */}
      <SheetContent side="right" size="xl" className="gap-0 p-0">
        {/* Names the dialog for assistive tech, and dates the build — which the
            terminal bar has no slot for. `pr-12` keeps it clear of the ✕. */}
        <SheetHeader className="shrink-0 border-b border-border pr-12">
          <SheetTitle>Build log</SheetTitle>
          <p className="text-[11px] text-muted-foreground">
            {targetLabel} · v{build.version} · {formatRelativeTime(build.createdAt)}
          </p>
        </SheetHeader>

        {/* Blocks beside the log, not instead of it: the list answers "what is it doing, and
            for how long", the log answers "what exactly did it say". Stacked below `lg`, where
            two columns would leave neither readable. */}
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <div className="min-h-0 shrink-0 border-b border-border lg:w-64 lg:border-r lg:border-b-0">
            <BuildSteps steps={stepsFor(build)} className="h-full max-h-48 lg:max-h-none" />
          </div>
          <div className="min-h-0 flex-1">
            <BuildLogTerminal build={build} onRebuild={onRebuild} rebuilding={rebuilding} />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

/**
 * The blocks to draw for a build, whichever release recorded it.
 *
 * A build stored since the `steps` column exists carries its own, timestamped as they ran —
 * nothing to recompute. One recorded before it never will, and re-deriving from its log is all
 * there is: the same states, minus the durations (a log has no clock in it) and minus the blocks
 * it never reached (a log cannot mention what never ran). Both read as a build; only the older
 * one reads as a shorter one, which is the honest rendering of what was kept about it.
 */
function stepsFor(build: ProjectImageBuild): BuildStep[] {
  return build.steps ?? applyBuildLog(planFromLog(build.logs), build.logs, build.state)
}

/**
 * Its own component, and not inlined above, because the terminal is mounted by
 * the *sheet* — `SheetContent` renders nothing while closed. Printing from the
 * component that owns the sheet would run the effect once, against a terminal
 * that doesn't exist yet, and never again: the log is already in `build` by
 * then, so no dependency ever changes to re-fire it. Here the handle and the
 * effect mount and unmount together, and opening the panel always prints.
 */
function BuildLogTerminal({
  build,
  onRebuild,
  rebuilding,
}: {
  build: ProjectImageBuild
  onRebuild?: () => void
  rebuilding?: boolean
}) {
  const term = useRef<TerminalHandle>(null)
  // No placeholder text in the buffer: an empty log is `TerminalPanel`'s own
  // `placeholder`/`loading` below, which swaps the surface out instead.
  useLogSnapshot(term, build.logs)

  const { status, label } = PANEL_STATUS[build.state]
  const empty = !build.logs
  // One build at a time per project — a second one would write into the same tag.
  const busy = rebuilding || build.state === "building"

  return (
    <TerminalPanel
      ref={term}
      className="border-0"
      subtitle={build.imageRef}
      status={status}
      statusLabel={label}
      // `actions` and not `onReconnect`: the DS reconnect button is for a stream
      // that dropped, and its label says so. This re-runs the build. Matches
      // `BarButton`'s geometry by hand — the DS keeps it internal.
      actions={
        onRebuild && (
          <button
            type="button"
            title={busy ? "A build is already running" : "Rebuild this image from scratch"}
            aria-label="Rebuild image"
            disabled={busy}
            onClick={onRebuild}
            className="flex size-6 cursor-pointer items-center justify-center rounded text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCw className="h-3.5 w-3.5" />}
          </button>
        )
      }
      // A build that has produced no output yet is only worth waiting on while
      // it's still running; an empty log on a finished build is a fact, not a
      // spinner.
      placeholder={empty ? (build.state === "building" ? "Building…" : "No output") : undefined}
      loading={empty && build.state === "building"}
      fontSize={12}
      search
      copy
      download
      downloadFileName={`${build.imageRef.replace(/[^\w.-]+/g, "-")}.log`}
      options={{ webLinks: true }}
    />
  )
}
