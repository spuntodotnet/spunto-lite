"use client"

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

/**
 * Confirmation for the one irreversible action on a project: deleting it. Controlled
 * by the caller (project card, project detail page) so each keeps its own trigger.
 * Deleting also destroys every workspace the project spawned — containers, volumes
 * and built images — hence the explicit dialog rather than a bare confirm().
 */
export function DeleteProjectDialog({
  open,
  onOpenChange,
  projectId,
  projectName,
  workerCount,
  onDeleted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  projectName: string
  /** Omitted where the caller doesn't know it (the dashboard card). */
  workerCount?: number
  onDeleted?: () => void
}) {
  const qc = useQueryClient()

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

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{projectName}”?</AlertDialogTitle>
          <AlertDialogDescription>
            The spec, its version history and its secrets are erased. {workspaces} This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={del.isPending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => del.mutate()} disabled={del.isPending}>
            {del.isPending ? <Loader2 className="animate-spin" /> : <Trash2 />}
            Delete
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
