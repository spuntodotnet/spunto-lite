"use client"

import { useRef } from "react"
import { Loader2, RotateCw } from "lucide-react"
import { TerminalPanel, type TerminalHandle, type TerminalPanelStatus } from "@spunto/design-system"
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
 * An image build's log, framed by the design system's `TerminalPanel`.
 *
 * Its own module because two pages show the same log — the project panel's build sheet and a
 * workspace still waiting for its image — and the frame around it is the whole point: the state
 * chip, the image ref, and search / copy / download are exactly what `TerminalPanel` exists to
 * stop every page from re-inventing.
 *
 * The text needs no post-processing: the step markers the build script prints are turned into
 * banners by `BuildStepTracker` on the way *in* (services/workers.ts), so what is stored is what
 * a human reads, and the live tail and a reopened build are the same text.
 *
 * Presentational and controlled: the caller hands over the build it already polls, so this never
 * opens a second query against `/builds` behind a page tailing the same endpoint — the log
 * updates live as a consequence, without this component knowing a build is in flight.
 *
 * Owning the handle here, rather than leaving it to the caller, is also what makes it print
 * inside a sheet: `SheetContent` renders nothing while closed, so an effect written in the
 * component that owns the sheet would run once against a terminal that doesn't exist yet and
 * never again — the log is already in `build` by then, so no dependency ever changes to re-fire
 * it. Here the handle and the effect mount and unmount together.
 */
export function BuildLogTerminal({
  build,
  title,
  onRebuild,
  rebuilding = false,
  className,
}: {
  build: ProjectImageBuild
  /** Names the panel when it sits among others (the workspace page's tabs). */
  title?: string
  /** Runs another build of the same version, cache and all. Omitted → no button. */
  onRebuild?: () => void
  rebuilding?: boolean
  className?: string
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
      className={className}
      title={title}
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
