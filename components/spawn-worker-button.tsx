"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "@spunto/design-system"
import { Zap } from "lucide-react"
import { Button } from "@/components/ui/button"
import { api } from "@/lib/api"

export function SpawnWorkerButton({ projectId, variant = "default" }: { projectId: string; variant?: "default" | "outline" }) {
  const qc = useQueryClient()
  const spawn = useMutation({
    mutationFn: () => api.post(`/api/projects/${projectId}/workers`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["workers", projectId] })
      toast.success("Workspace spawning…")
    },
    onError: (e) => toast.error((e as Error).message),
  })
  return (
    <Button size="sm" variant={variant} className="gap-1.5 shrink-0" onClick={() => spawn.mutate()} disabled={spawn.isPending}>
      <Zap className="h-3.5 w-3.5" /> New workspace
    </Button>
  )
}
