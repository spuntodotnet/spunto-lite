"use client"

import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { SlidersHorizontalIcon, SparklesIcon } from "lucide-react"
import { NewTaskDialog, newTaskChipClassName, type NewTaskCustomField, type NewTaskValue } from "@spunto/design-system/tasks"
// The package's Select, not a local copy: the chips must look like the dialog's own.
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@spunto/design-system"
import { api } from "@/lib/api"
import { ALL_TASKS_KEY, PROJECT_TASKS_KEY, insertTask, type Task } from "@/lib/task-cache"
import type { AgentAppInfo, Project } from "@/lib/types"

/** The agent apps and their catalogs — static per release, so read once. */
export function useAgentApps(enabled = true) {
  return useQuery({
    queryKey: ["agent-apps"],
    queryFn: () => api.get<AgentAppInfo[]>("/api/agent-apps"),
    enabled,
    staleTime: Infinity,
  })
}

/**
 * Delegating work. The form is the design system's `NewTaskDialog`; this feeds it what it offers
 * (projects when none is in scope, the project's branch, and — RFC 0048 — the harnesses the
 * project allows, the models of the one picked, and one chip per parameter its app declares) and
 * sends what it returns.
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
  // The harness picked in the dialog — mirrored here because the models and the parameters follow it.
  const [harnessPick, setHarnessPick] = useState<string | null>(null)
  const target = projectId ?? picked

  const { data: projects = [] } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.get<Project[]>("/api/projects"),
    enabled: open,
    staleTime: 60_000,
  })
  const { data: apps = [] } = useAgentApps(open)
  const project = projects.find((p) => p.id === target)

  // The harnesses this project allows, first because everything after depends on it.
  const allowedIds = project?.agentAppIds ?? []
  const allowedApps = allowedIds.map((id) => apps.find((a) => a.id === id)).filter((a): a is AgentAppInfo => !!a)
  const harness = (harnessPick && allowedIds.includes(harnessPick) ? harnessPick : null) ?? allowedIds[0] ?? null
  const harnessApp = allowedApps.find((a) => a.id === harness)
  const catalog = harnessApp?.catalog
  // What runs when nobody picks a model: the project's default for this harness, else the app's own.
  const catalogDefault = catalog?.models.find((m) => m.default)?.value ?? null
  const defaultModel = (harness ? project?.taskAgentModels?.[harness] : null) || catalogDefault
  // The dialog keeps the model it is given to itself, so the parameters follow the default one.
  const modelEntry = catalog?.models.find((m) => m.value === defaultModel)

  const harnessField: NewTaskCustomField = {
    id: "harness",
    label: "Harness",
    hint: "Which agent runs the task — any the project allows. The models and the parameters are this harness's.",
    defaultValue: harness,
    required: true,
    render: (value, onChange) => (
      <Select
        value={(value as string | undefined) ?? null}
        onValueChange={(v) => {
          onChange(v)
          setHarnessPick(v as string)
        }}
      >
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
      id: `param:${harness}:${param.id}`,
      label: param.label,
      hint: param.description,
      defaultValue: "",
      render: (value: unknown, onChange: (v: unknown) => void) => (
        <Select value={typeof value === "string" && value ? value : "__default"} onValueChange={(v) => onChange(v === "__default" ? "" : v)}>
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
      ),
    }
  })

  const create = useMutation({
    mutationFn: ({ projectId, value }: { projectId: string; value: NewTaskValue }) => {
      const fields = value.fields ?? {}
      const agentAppId = typeof fields.harness === "string" ? fields.harness : harness
      // The parameters of the harness the task runs under, only the ones set — a pick made under
      // another harness before switching is not this one's.
      const prefix = `param:${agentAppId}:`
      const agentOptions = Object.fromEntries(
        Object.entries(fields)
          .filter(([k, v]) => k.startsWith(prefix) && typeof v === "string" && v)
          .map(([k, v]) => [k.slice(prefix.length), v as string]),
      )
      return api.post<Task>(`/api/projects/${projectId}/tasks`, {
        ...(value.title ? { title: value.title } : {}),
        prompt: value.prompt,
        ...(value.baseBranch ? { baseBranch: value.baseBranch } : {}),
        ...(value.model ? { model: value.model } : {}),
        ...(agentAppId ? { agentAppId } : {}),
        ...(Object.keys(agentOptions).length ? { agentOptions } : {}),
        ...(value.files.length > 0 ? { files: value.files.map(({ name, mediaType, data }) => ({ filename: name, mediaType, data })) } : {}),
      })
    },
    onSuccess: (task) => {
      insertTask(queryClient, task)
      queryClient.invalidateQueries({ queryKey: PROJECT_TASKS_KEY })
      queryClient.invalidateQueries({ queryKey: ALL_TASKS_KEY })
      setOpen(false)
      onCreated?.(task)
    },
  })

  const noHarness = !!project && allowedIds.length === 0

  return (
    <NewTaskDialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setPicked("")
          setHarnessPick(null)
          create.reset()
        }
        setOpen(next)
      }}
      label={label}
      variant={variant}
      projects={projectId ? undefined : projects.map((p) => ({ id: p.id, name: p.name }))}
      onProjectChange={(id) => {
        setPicked(id)
        setHarnessPick(null)
      }}
      branches={[]}
      defaultBranch={project?.repositories[0]?.branch || null}
      modelGroups={harnessApp ? [{ id: harnessApp.id, label: harnessApp.name, models: harnessApp.catalog.models.map(({ value, label }) => ({ value, label })) }] : []}
      defaultModel={defaultModel}
      fields={[...(allowedApps.length > 0 ? [harnessField] : []), ...paramFields]}
      submitting={create.isPending}
      error={
        create.isError
          ? (create.error as Error).message
          : noHarness
            ? `${project.name} has no harness yet: switch on an agent app in its settings (Edit → Delegated work) to delegate here.`
            : null
      }
      onSubmit={(value) => {
        const id = projectId ?? value.projectId
        if (id) create.mutate({ projectId: id, value })
      }}
    />
  )
}
