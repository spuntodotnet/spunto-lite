"use client"

import { Sheet, SheetContent, SheetHeader, SheetTitle, formatRelativeTime } from "@spunto/design-system"
import { BuildStateLabel } from "@spunto/design-system/projects"
import { LogTerminal } from "@/components/logs-panel"
import type { ProjectImageBuild } from "@/lib/types"

/**
 * The build log behind a build-cache row, in a side panel.
 *
 * The log itself already existed — but only on a *workspace* page, and only while
 * that workspace had no container yet, which is the one moment you're least likely
 * to be looking for it. Why an image failed to build, or what went into the one
 * you're running on, is a property of the *project*; this is the panel the
 * dashboard opens from the same row, so the gesture is the same on both sides.
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
      {/* `gap-0` + `p-0`: the log surface goes edge to edge under its own header,
          like the logs pane of a workspace, rather than floating in panel padding. */}
      <SheetContent side="right" size="xl" className="gap-0 p-0">
        {/* `pr-12` keeps the title clear of the ✕ the panel draws in the corner. */}
        <SheetHeader className="shrink-0 border-b border-border pr-12">
          <div className="flex items-center gap-2">
            <SheetTitle className="truncate">Build log</SheetTitle>
            <BuildStateLabel state={build.state} />
          </div>
          <p className="truncate font-mono text-[11px] text-muted-foreground" title={build.imageRef}>
            {targetLabel} · {build.imageRef}
          </p>
          <p className="text-[11px] text-muted-foreground/70">
            v{build.version} · {formatRelativeTime(build.createdAt)}
          </p>
        </SheetHeader>

        <div className="min-h-0 flex-1 bg-[#09090b] p-2">
          <LogTerminal text={build.logs} placeholder="Building…" />
        </div>
      </SheetContent>
    </Sheet>
  )
}
