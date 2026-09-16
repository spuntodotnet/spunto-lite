"use client"

import { Sheet, SheetContent, SheetHeader, SheetTitle, formatRelativeTime } from "@spunto/design-system"
import { BuildSteps } from "@spunto/design-system/projects"
import { BuildLogTerminal } from "@/components/build-log-terminal"
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
 * The log is `BuildLogTerminal`, shared with the workspace page. What this adds is
 * the sheet, the date, and the blocks beside it.
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
            {/* A build recorded before the `steps` column existed has none, and there is no
                honest way to invent them: the blocks are read back from markers its script never
                printed. Rather than parse its prose and guess, the list says so — the log below
                is intact, and it is what that build actually kept. */}
            <BuildSteps
              steps={build.steps ?? []}
              emptyLabel="This build predates step tracking"
              className="h-full max-h-48 lg:max-h-none"
            />
          </div>
          <div className="min-h-0 flex-1">
            <BuildLogTerminal build={build} onRebuild={onRebuild} rebuilding={rebuilding} className="border-0" />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
