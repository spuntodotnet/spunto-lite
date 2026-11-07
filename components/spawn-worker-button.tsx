"use client"

import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  toast,
} from "@spunto/design-system"
import { Loader2, Zap } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { api } from "@/lib/api"

/**
 * Spawns a workspace, through a small form rather than straight away: both fields
 * are optional, so leaving them empty is exactly the previous one-click behaviour
 * (generated name, remote's default branch). Filling "Branch" starts the worker on
 * an existing branch — a PR under review, a release branch — instead of having to
 * check it out by hand once inside.
 */
export function SpawnWorkerButton({
  projectId,
  variant = "default",
  compact = false,
  onSpawned,
}: {
  projectId: string
  variant?: "default" | "outline"
  /** A row's shortcut (the Projects table): a small "Workspace" button instead of "New workspace". */
  compact?: boolean
  /** Called with the new workspace once the API accepted it — the Projects table opens its page. */
  onSpawned?: (worker: { id: string }) => void
}) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [branch, setBranch] = useState("")

  const spawn = useMutation({
    mutationFn: () =>
      api.post(`/api/projects/${projectId}/workers`, {
        name: name.trim() || undefined,
        branch: branch.trim() || undefined,
      }),
    onSuccess: (worker) => {
      qc.invalidateQueries({ queryKey: ["workers", projectId] })
      qc.invalidateQueries({ queryKey: ["projects"] })
      onSpawned?.(worker as { id: string })
      toast.success(branch.trim() ? `Workspace spawning on ${branch.trim()}…` : "Workspace spawning…")
      setOpen(false)
      setName("")
      setBranch("")
    },
    onError: (e) => toast.error((e as Error).message),
  })

  return (
    <>
      {compact ? (
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 px-2 text-xs"
          title="Spawn a workspace of this project"
          onClick={() => setOpen(true)}
        >
          <Zap className="h-3.5 w-3.5" /> Workspace
        </Button>
      ) : (
        <Button size="sm" variant={variant} className="gap-1.5 shrink-0" onClick={() => setOpen(true)}>
          <Zap className="h-3.5 w-3.5" /> New workspace
        </Button>
      )}
      <Dialog open={open} onOpenChange={(o) => !spawn.isPending && setOpen(o)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New workspace</DialogTitle>
            <DialogDescription>
              Both fields are optional — leave them empty for a generated name on the repository&apos;s default branch.
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              if (!spawn.isPending) spawn.mutate()
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="worker-name">Name</Label>
              <Input
                id="worker-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="auto-generated"
                autoFocus
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="worker-branch">Branch</Label>
              <Input
                id="worker-branch"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="default branch"
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                Checked out at clone time for every repository of the project. An unknown branch fails the setup with the
                reason in the workspace logs.
              </p>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={spawn.isPending}>
                Cancel
              </Button>
              <Button type="submit" className="gap-1.5" disabled={spawn.isPending}>
                {spawn.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
