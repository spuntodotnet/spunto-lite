"use client"

import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Loader2, Trash2 } from "lucide-react"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  toast,
} from "@spunto/design-system"
import { api } from "@/lib/api"
import type { SharedVolume } from "@/lib/types"

/**
 * Confirmation for the one irreversible action on a project: deleting it. Controlled
 * by the caller (project card, project detail page) so each keeps its own trigger.
 * Deleting also destroys every workspace the project spawned — containers, volumes
 * and built images — hence the explicit dialog rather than a bare confirm().
 *
 * Shared volumes get a second gate: they're the only thing here that survives
 * deleting a workspace, so what lives in them is data the user put there and
 * kept on purpose. Deleting the project is the one operation that erases them,
 * and it doesn't happen until the checkbox naming them is ticked.
 */
export function DeleteProjectDialog({
  open,
  onOpenChange,
  projectId,
  projectName,
  workerCount,
  sharedVolumes = [],
  onDeleted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  projectName: string
  /** Omitted where the caller doesn't know it (the dashboard card). */
  workerCount?: number
  /** The project's shared volumes, destroyed with it. */
  sharedVolumes?: SharedVolume[]
  onDeleted?: () => void
}) {
  const qc = useQueryClient()
  const [volumesAcknowledged, setVolumesAcknowledged] = useState(false)

  // Reopening the dialog must ask again — a ticked box is never inherited.
  useEffect(() => {
    if (!open) setVolumesAcknowledged(false)
  }, [open])

  const del = useMutation({
    mutationFn: () => api.del(`/api/projects/${projectId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] })
      toast.success(`Project “${projectName}” deleted`)
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (e) => toast.error((e as Error).message),
  })

  const workspaces =
    workerCount === undefined
      ? "Any workspace it spawned goes with it — containers, volumes and built images."
      : workerCount > 0
        ? `Its ${workerCount} workspace${workerCount > 1 ? "s" : ""} go${workerCount > 1 ? "" : "es"} with it — container${workerCount > 1 ? "s" : ""}, volumes and built images.`
        : "No workspace is running from it; the built images are removed too."

  const blocked = sharedVolumes.length > 0 && !volumesAcknowledged

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{projectName}”?</AlertDialogTitle>
          <AlertDialogDescription>
            The spec, its version history and its secrets are erased. {workspaces} This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {sharedVolumes.length > 0 && (
          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 shrink-0 accent-destructive"
              checked={volumesAcknowledged}
              onChange={(e) => setVolumesAcknowledged(e.target.checked)}
            />
            <span className="space-y-1">
              <span className="block font-medium">
                Also delete {sharedVolumes.length} shared volume{sharedVolumes.length > 1 ? "s" : ""} and everything
                in {sharedVolumes.length > 1 ? "them" : "it"}
              </span>
              <span className="block text-xs text-muted-foreground">
                {sharedVolumes.map((v) => v.name).join(", ")} — data kept across every workspace of this project
                (caches, datasets, artifacts). Nothing else erases them.
              </span>
            </span>
          </label>
        )}

        <AlertDialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={del.isPending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => del.mutate()} disabled={del.isPending || blocked}>
            {del.isPending ? <Loader2 className="animate-spin" /> : <Trash2 />}
            Delete
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
