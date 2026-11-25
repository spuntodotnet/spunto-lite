"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { SparklesIcon } from "lucide-react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, toast } from "@spunto/design-system"
import { api } from "@/lib/api"
import type { Project, Settings } from "@/lib/types"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

const NONE = "__none"

/**
 * Settings → Agents: the project the agent cockpit's "New" opens on — Spunto Cloud's organization
 * default project. The composer still lets you pick another; with none set, it asks. Saved on pick,
 * outside the settings form, like Appearance.
 */
export function DefaultProjectCard({ value }: { value: string | null | undefined }) {
  const qc = useQueryClient()
  const { data: projects = [] } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.get<Project[]>("/api/projects"),
    staleTime: 60_000,
  })

  const save = useMutation({
    mutationFn: (defaultProjectId: string | null) => api.patch<Settings>("/api/settings", { defaultProjectId }),
    onSuccess: (settings) => {
      qc.setQueryData(["settings"], settings)
      toast.success(settings.defaultProjectId ? "Default project saved" : "Default project removed")
    },
    onError: (e) => toast.error(`Couldn't save the default project — ${(e as Error).message}`),
  })

  const current = (save.isPending ? save.variables : value) ?? NONE

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <SparklesIcon className="size-4" /> Agents
        </CardTitle>
        <CardDescription>
          The project a new conversation starts on when you click New in Agents. You can still pick another one there.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Select value={current} onValueChange={(v) => save.mutate(v === NONE ? null : (v as string))} disabled={save.isPending}>
          <SelectTrigger aria-label="Default project" className="w-full sm:w-80">
            <SelectValue>{(v: unknown) => projects.find((p) => p.id === v)?.name ?? "No default — ask every time"}</SelectValue>
          </SelectTrigger>
          <SelectContent className="min-w-56">
            <SelectItem value={NONE}>No default — ask every time</SelectItem>
            {projects.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardContent>
    </Card>
  )
}
