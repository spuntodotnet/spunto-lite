"use client"

import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { NewTaskDialog, type NewTaskValue } from "@spunto/design-system/tasks"
import { api } from "@/lib/api"
import { ALL_TASKS_KEY, PROJECT_TASKS_KEY, insertTask, type Task } from "@/lib/task-cache"
import type { HarnessPack } from "@/lib/harness-packs"
import type { Project } from "@/lib/types"

/**
 * Delegating work. The form is the design system's `NewTaskDialog`; this feeds it what it offers
 * (projects when none is in scope, the project's branch and default model, the harness catalogue's
 * models) and sends what it returns.
 *
 * Lite asks no forge for branches, so the base branch is free text with the repository's
 * configured branch as its placeholder — leaving it blank means the remote's default.
 */
export function NewTaskButton({
  projectId,
  variant = "default",
  label = "New task",
  onCreated,
}: {
  /** Omitted on the agent cockpit, which has no project in scope: the form asks for one first. */
  projectId?: string
  variant?: "default" | "outline"
  label?: string
  /** Lets the caller open the conversation it just started instead of leaving it to be found. */
  onCreated?: (task: Task) => void
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState("")
  const target = projectId ?? picked

  const { data: projects = [] } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.get<Project[]>("/api/projects"),
    enabled: open,
    staleTime: 60_000,
  })
  const { data: packs = [] } = useQuery({
    queryKey: ["harness-packs"],
    queryFn: () => api.get<HarnessPack[]>("/api/harness-packs"),
    enabled: open,
    staleTime: Infinity,
  })
  const project = projects.find((p) => p.id === target)

  const create = useMutation({
    mutationFn: ({ projectId, value }: { projectId: string; value: NewTaskValue }) =>
      api.post<Task>(`/api/projects/${projectId}/tasks`, {
        ...(value.title ? { title: value.title } : {}),
        prompt: value.prompt,
        ...(value.baseBranch ? { baseBranch: value.baseBranch } : {}),
        ...(value.model ? { model: value.model } : {}),
        ...(value.files.length > 0 ? { files: value.files.map(({ name, mediaType, data }) => ({ filename: name, mediaType, data })) } : {}),
      }),
    onSuccess: (task) => {
      insertTask(queryClient, task)
      queryClient.invalidateQueries({ queryKey: PROJECT_TASKS_KEY })
      queryClient.invalidateQueries({ queryKey: ALL_TASKS_KEY })
      setOpen(false)
      onCreated?.(task)
    },
  })

  return (
    <NewTaskDialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setPicked("")
          create.reset()
        }
        setOpen(next)
      }}
      label={label}
      variant={variant}
      projects={projectId ? undefined : projects.map((p) => ({ id: p.id, name: p.name }))}
      onProjectChange={setPicked}
      branches={[]}
      defaultBranch={project?.repositories[0]?.branch || null}
      modelGroups={packs.map((pack) => ({ id: pack.id, label: pack.label, models: pack.models }))}
      defaultModel={project?.taskAgentModel ?? null}
      submitting={create.isPending}
      error={create.isError ? (create.error as Error).message : null}
      onSubmit={(value) => {
        const id = projectId ?? value.projectId
        if (id) create.mutate({ projectId: id, value })
      }}
    />
  )
}
