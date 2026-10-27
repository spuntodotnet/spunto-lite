"use client"

import { useState } from "react"
import Link from "next/link"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { SlidersHorizontalIcon, SparklesIcon } from "lucide-react"
import { NewTaskComposer, clearTaskDraft, newTaskChipClassName, type NewTaskCustomField } from "@spunto/design-system/tasks"
// The package's Select, not a local copy: the chips must look like the composer's own.
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@spunto/design-system"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import { nextLink } from "@/lib/link-render"
import { ALL_TASKS_KEY, PROJECT_TASKS_KEY, insertTask, type Task } from "@/lib/task-cache"
import type { AgentAppInfo, Project } from "@/lib/types"
import { buttonVariants } from "@/components/ui/button"

/** The agent apps and their catalogs — static per release, so read once. */
export function useAgentApps(enabled = true) {
  return useQuery({
    queryKey: ["agent-apps"],
    queryFn: () => api.get<AgentAppInfo[]>("/api/agent-apps"),
    enabled,
    staleTime: Infinity,
  })
}

/** Where a new task is written: inside a project, or on the agent cockpit (`?new=1`). */
export function newTaskHref(projectId?: string) {
  return projectId ? `/projects/${projectId}/tasks/new` : "/agents?new=1"
}

/** The way in: a link to where the conversation will be, not a dialog over the page. */
export function NewTaskButton({
  projectId,
  variant = "default",
  label = "New task",
}: {
  /** Omitted on the agent cockpit, which has no project in scope: the composer asks for one first. */
  projectId?: string
  variant?: "default" | "outline"
  label?: string
}) {
  return (
    <Link href={newTaskHref(projectId)} className={cn(buttonVariants({ variant, size: "sm" }), "h-8 gap-1.5")}>
      <SparklesIcon className="h-3.5 w-3.5" />
      {label}
    </Link>
  )
}

/**
 * Delegating work, in the place the conversation will stream. The form is the design system's
 * `NewTaskComposer` — the empty transcript, the box at the bottom, where the session starts arriving
 * once delegated; this feeds it what it offers (projects when none is in scope, the project's
 * branch, and — RFC 0048 — the harnesses the project allows, the models of the one picked, and one
 * chip per parameter its app declares) and sends what it returns.
 *
 * Lite asks no forge for branches, so the base branch is free text with the repository's
 * configured branch as its placeholder — leaving it blank means the remote's default. And no
 * title: the task takes one from the prompt, then the name the agent gives the conversation.
 */
export function NewTask({
  projectId,
  onCreated,
  backHref,
  onBack,
}: {
  /** Omitted on the agent cockpit, which has no project in scope: the composer asks for one first. */
  projectId?: string
  /** Where the conversation that was just started opens — the composer gives way to it. */
  onCreated: (task: Task) => void
  backHref?: string
  onBack?: () => void
}) {
  const queryClient = useQueryClient()
  const [picked, setPicked] = useState("")
  const target = projectId ?? picked
  // What is being written survives leaving the page: one draft per place a task is started from.
  const draftKey = `new:${projectId ?? "all"}`

  const { data: projects = [] } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.get<Project[]>("/api/projects"),
    staleTime: 60_000,
  })
  const { data: apps = [] } = useAgentApps()
  const project = projects.find((p) => p.id === target)

  // The harnesses this project allows, first because everything after depends on it. The pick is
  // kept here, not only in the composer: the models and the parameters follow it.
  const [harnessPick, setHarnessPick] = useState<string | null>(null)
  const allowedIds = project?.agentAppIds ?? []
  const allowedApps = allowedIds.map((id) => apps.find((a) => a.id === id)).filter((a): a is AgentAppInfo => !!a)
  const harness = (harnessPick && allowedIds.includes(harnessPick) ? harnessPick : null) ?? allowedIds[0] ?? null
  const harnessApp = allowedApps.find((a) => a.id === harness)
  const catalog = harnessApp?.catalog
  // What runs when nobody picks a model: the project's default for this harness, else the app's own.
  const catalogDefault = catalog?.models.find((m) => m.default)?.value ?? null
  const defaultModel = (harness ? project?.taskAgentModels?.[harness] : null) || catalogDefault

  // Changing project or harness gives the composer a new key: the model and the parameters picked
  // under the previous one are dropped (the harness pick itself lives here, so it survives).
  const composerKey = `${target}:${harness ?? "none"}`
  // The model as typed or picked, tagged with the key it was picked under — so the parameters
  // offered are the ones *that* model takes, not the default's.
  const [typedModel, setTypedModel] = useState<{ key: string; value: string } | null>(null)
  const effectiveModel = (typedModel?.key === composerKey && typedModel.value) || defaultModel
  const modelEntry = catalog?.models.find((m) => m.value === effectiveModel)

  const harnessField: NewTaskCustomField = {
    id: "harness",
    label: "Harness",
    hint: "Which agent runs the task — any the project allows. The model and the parameters are this harness's.",
    defaultValue: harness,
    required: true,
    // Before the model chip, which lists this harness's models.
    placement: "lead",
    render: (value, onChange) => (
      <Select value={(value as string | undefined) ?? null} onValueChange={(v) => onChange(v)}>
        <SelectTrigger aria-label="Harness" className={newTaskChipClassName}>
          <SparklesIcon />
          <SelectValue>{(v: unknown) => allowedApps.find((a) => a.id === v)?.name ?? "Pick a harness"}</SelectValue>
        </SelectTrigger>
        <SelectContent className="min-w-56">
          {allowedApps.map((a) => (
            <SelectItem key={a.id} value={a.id}>
              <span>{a.name}</span>
              {a.id === allowedIds[0] && <span className="ml-auto pl-4 text-xs text-muted-foreground">default</span>}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ),
  }

  // One chip per parameter the harness's app defines — Lite knows none of them by name.
  // Unset = the harness's default for the model, said in the chip ("Effort: default").
  const paramFields: NewTaskCustomField[] = (catalog?.params ?? []).map((param) => {
    const allowed = modelEntry?.params?.[param.id]
    const values = allowed ? param.values.filter((x) => allowed.includes(x.value)) : param.values
    const modelDefault = modelEntry?.paramDefaults?.[param.id]
    const defaultLabel = modelDefault ? `default (${param.values.find((x) => x.value === modelDefault)?.label ?? modelDefault})` : "default"
    return {
      id: `param:${param.id}`,
      label: param.label,
      hint: param.description,
      defaultValue: "",
      render: (value: unknown, onChange: (v: unknown) => void) => {
        // A value the model does not take (picked under another model) shows — and is sent — as unset.
        const current = typeof value === "string" && value && (!allowed || allowed.includes(value)) ? value : "__default"
        return (
          <Select value={current} onValueChange={(v) => onChange(v === "__default" ? "" : v)}>
            <SelectTrigger aria-label={param.label} className={newTaskChipClassName}>
              <SlidersHorizontalIcon />
              <SelectValue>
                {(v: unknown) => `${param.label}: ${v && v !== "__default" ? (param.values.find((x) => x.value === v)?.label ?? String(v)) : defaultLabel}`}
              </SelectValue>
            </SelectTrigger>
            <SelectContent className="min-w-56">
              <SelectItem value="__default">{defaultLabel.charAt(0).toUpperCase() + defaultLabel.slice(1)}</SelectItem>
              {values.map((x) => (
                <SelectItem key={x.value} value={x.value}>
                  <span className="flex min-w-0 flex-col">
                    <span>{x.label}</span>
                    {x.description && <span className="truncate text-[10px] text-muted-foreground">{x.description}</span>}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )
      },
    }
  })

  const create = useMutation({
    mutationFn: ({ projectId, body }: { projectId: string; body: Record<string, unknown> }) =>
      api.post<Task>(`/api/projects/${projectId}/tasks`, body),
    onSuccess: (task) => {
      // In the caches before the composer gives way, so the cockpit opens on it at once.
      insertTask(queryClient, task)
      clearTaskDraft(draftKey)
      queryClient.invalidateQueries({ queryKey: PROJECT_TASKS_KEY })
      queryClient.invalidateQueries({ queryKey: ALL_TASKS_KEY })
      onCreated(task)
    },
  })

  return (
    <NewTaskComposer
      projects={projectId ? undefined : projects.map((p) => ({ id: p.id, name: p.name }))}
      onProjectChange={(id) => {
        setPicked(id)
        setHarnessPick(null)
      }}
      draftKey={draftKey}
      branches={[]}
      defaultBranch={project?.repositories[0]?.branch || null}
      modelGroups={harnessApp ? [{ id: harnessApp.id, label: harnessApp.name, models: harnessApp.catalog.models.map(({ value, label }) => ({ value, label })) }] : []}
      defaultModel={defaultModel}
      onModelChange={(value) => setTypedModel({ key: composerKey, value })}
      fields={[...(allowedApps.length > 0 ? [harnessField] : []), ...paramFields]}
      onFieldChange={(id, value) => {
        if (id === "harness" && typeof value === "string") setHarnessPick(value)
      }}
      remembered={{ key: composerKey }}
      description={
        project && allowedIds.length === 0
          ? `${project.name} has no harness yet: switch on an agent app in its settings (Edit → Delegated work) to delegate here.`
          : project
            ? `In ${project.name}, on a worker and a branch of its own. Its session streams right here as soon as it starts — answer it as it works.`
            : undefined
      }
      backHref={backHref}
      onBack={onBack}
      render={{ link: nextLink }}
      submitting={create.isPending}
      error={create.isError ? (create.error as Error).message : null}
      onSubmit={(value) => {
        const id = projectId ?? value.projectId
        if (!id) return
        // The harness's parameters, as its app named them — only the ones set, and only the ones
        // the model takes.
        const agentOptions = Object.fromEntries(
          Object.entries(value.fields ?? {})
            .filter(([k, v]) => {
              if (!k.startsWith("param:") || typeof v !== "string" || !v) return false
              const allowed = modelEntry?.params?.[k.slice("param:".length)]
              return !allowed || allowed.includes(v)
            })
            .map(([k, v]) => [k.slice("param:".length), v as string]),
        )
        create.mutate({
          projectId: id,
          body: {
            prompt: value.prompt,
            ...(value.baseBranch ? { baseBranch: value.baseBranch } : {}),
            ...(value.model ? { model: value.model } : {}),
            ...(harness ? { agentAppId: harness } : {}),
            ...(Object.keys(agentOptions).length ? { agentOptions } : {}),
            ...(value.files.length > 0 ? { files: value.files.map(({ name, mediaType, data }) => ({ filename: name, mediaType, data })) } : {}),
          },
        })
      }}
    />
  )
}
