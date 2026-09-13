"use client"

import { useRef } from "react"
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
import { useLogSnapshot } from "@/components/logs-panel"
import type { ProjectImageBuild } from "@/lib/types"

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
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  build: ProjectImageBuild
  /** The row this was opened from — "local · Docker" in Lite. */
  targetLabel: string
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

        <div className="min-h-0 flex-1">
          <BuildLogTerminal build={build} />
        </div>
      </SheetContent>
    </Sheet>
  )
}

/**
 * Its own component, and not inlined above, because the terminal is mounted by
 * the *sheet* — `SheetContent` renders nothing while closed. Printing from the
 * component that owns the sheet would run the effect once, against a terminal
 * that doesn't exist yet, and never again: the log is already in `build` by
 * then, so no dependency ever changes to re-fire it. Here the handle and the
 * effect mount and unmount together, and opening the panel always prints.
 */
function BuildLogTerminal({ build }: { build: ProjectImageBuild }) {
  const term = useRef<TerminalHandle>(null)
  // No placeholder text in the buffer: an empty log is `TerminalPanel`'s own
  // `placeholder`/`loading` below, which swaps the surface out instead.
  useLogSnapshot(term, build.logs)

  const { status, label } = PANEL_STATUS[build.state]
  const empty = !build.logs

  return (
    <TerminalPanel
      ref={term}
      className="border-0"
      subtitle={build.imageRef}
      status={status}
      statusLabel={label}
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
