"use client"

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@spunto/design-system"
import { CatalogCard, CatalogChip, CatalogMark, resolveStackMark } from "@spunto/design-system/devcontainer"
import { TerminalSquare } from "lucide-react"
import type { TaskSettings } from "@/lib/project-form-value"
import type { AgentAppInfo } from "@/lib/types"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"

/**
 * How this project's tasks run (docs/taches.md § "Réglages du projet") — Spunto Cloud's
 * "Delegated work" section, on the Agents page of the project form, saved with the rest of it.
 *
 * The harness is a list of **agent apps** (RFC 0048): each one switched on puts its official SDK
 * in the project's image, and each task picks which one it runs under — the first when nobody
 * does. That list is part of the image, so changing it rebuilds; everything else here is read at
 * the next task.
 */

const REVIEW_MODES = [
  { value: "keep" as const, label: "Keep it running", hint: "Instant to pick back up, at the cost of a live container while review lasts." },
  { value: "stop" as const, label: "Stop it", hint: "Park the container, state kept on disk; Accept, Drop or a reply starts it again." },
]

function Field({ label, hint, children }: { label: string; hint: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      {children}
      <p className="text-[11px] leading-relaxed text-muted-foreground">{hint}</p>
    </div>
  )
}

function Choice<T extends string>({ name, options, value, onChange }: { name: string; options: { value: T; label: string; hint: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex flex-col gap-1">
      {options.map((o) => (
        <label
          key={o.value}
          className="flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 text-sm hover:bg-muted/50 has-[:checked]:border-primary has-[:checked]:bg-primary/5"
        >
          <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} className="mt-0.5 accent-primary" />
          <span className="min-w-0">
            <span className="font-medium">{o.label}</span>
            <span className="block text-[11px] text-muted-foreground">{o.hint}</span>
          </span>
        </label>
      ))}
    </div>
  )
}

/** A few words for the form's rail: the harnesses, and what departs from the defaults. */
export function taskSettingsSummary(v: TaskSettings, apps: AgentAppInfo[]): string {
  const parts = [
    v.agentAppIds.length ? v.agentAppIds.map((id) => apps.find((a) => a.id === id)?.name ?? id).join(" + ") : "no harness",
    ...v.agentAppIds.map((id) => v.taskAgentModels[id]).filter(Boolean),
    v.taskAgentInstructions.trim() && "instructions",
    v.taskValidateCommand.trim() && "accept",
    v.taskCancelCommand.trim() && "drop",
    v.taskReviewMode === "stop" && "parked in review",
  ].filter(Boolean)
  return parts.join(", ")
}

export function ProjectTaskFields({
  value,
  onChange,
  apps,
}: {
  value: TaskSettings
  onChange: (patch: Partial<TaskSettings>) => void
  apps: AgentAppInfo[]
}) {
  const set = onChange
  const allowed = value.agentAppIds
  const allowedApps = allowed.map((id) => apps.find((a) => a.id === id)).filter((a): a is AgentAppInfo => !!a)
  const defaultApp = allowedApps[0]
  // An app card is a switch: on, the project's tasks may run under it. Switched off, it takes its
  // default model with it — no task can run under it any more.
  const toggleApp = (id: string) => {
    if (!allowed.includes(id)) return set({ agentAppIds: [...allowed, id] })
    const models = Object.fromEntries(Object.entries(value.taskAgentModels).filter(([k]) => k !== id))
    set({ agentAppIds: allowed.filter((a) => a !== id), taskAgentModels: models })
  }
  const makeDefault = (id: string) => set({ agentAppIds: [id, ...allowed.filter((a) => a !== id)] })
  const setModel = (appId: string, model: string | null) => {
    const rest = Object.fromEntries(Object.entries(value.taskAgentModels).filter(([k]) => k !== appId))
    set({ taskAgentModels: model ? { ...rest, [appId]: model } : rest })
  }

  return (
    <div className="space-y-5">
      <p className="text-xs text-muted-foreground">
        The agents you delegate to from the project page or from Agents. A task&apos;s state always comes from its
        session, and only <span className="font-medium">Accept</span> or <span className="font-medium">Drop</span>{" "}
        takes it further.
      </p>
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Harness</label>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {apps.map((app) => {
            const mark = resolveStackMark(app.id, app.name)
            return (
              <CatalogCard
                key={app.id}
                tone="build"
                mark={
                  mark ? (
                    <CatalogMark mark={mark} label={app.name} tone="build" />
                  ) : (
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                      <TerminalSquare className="h-4 w-4" />
                    </span>
                  )
                }
                watermark={mark}
                title={app.name}
                titleMeta={
                  <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/70">
                    {allowed[0] === app.id && allowed.length > 1 ? "app · default" : "app"}
                  </span>
                }
                description={app.description}
                selected={allowed.includes(app.id)}
                onSelect={() => toggleApp(app.id)}
                action={
                  allowed.includes(app.id) && allowed[0] !== app.id ? (
                    <button type="button" onClick={() => makeDefault(app.id)} className="text-[11px] text-primary hover:underline">
                      Make default
                    </button>
                  ) : undefined
                }
              >
                <div className="flex flex-wrap items-center gap-1">
                  <CatalogChip>official SDK</CatalogChip>
                  <CatalogChip title={`The runner reads ${app.credentials.join(" or ")} from the project's secrets`}>{app.credentials[0]}</CatalogChip>
                </div>
              </CatalogCard>
            )
          })}
        </div>
        {allowed.length > 0 ? (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Each app switched on puts its official SDK in this project&apos;s image (changing the list makes a new
            version and rebuilds it), and <span className="font-medium">each task picks which one it runs under</span> —{" "}
            {defaultApp ? <span className="font-medium">{defaultApp.name}</span> : "the first"} when nobody does. Each
            runner reads its own credential from the project&apos;s or the global secrets (
            <span className="font-mono">{allowedApps.map((a) => a.credentials[0]).join(", ")}</span>).
          </p>
        ) : (
          <p className="text-[11px] text-destructive">No harness yet: switch on at least one app, or no task can be delegated in this project.</p>
        )}
      </div>

      {allowedApps.length > 0 && (
        <Field
          label="Default model"
          hint="One per harness, from that app's own list: a task gets the model of the app it runs under. A task can override it when it's delegated."
        >
          <div className="space-y-2">
            {allowedApps.map((app) => {
              const current = value.taskAgentModels[app.id] ?? null
              const label = (v: string | null) => (v ? (app.catalog.models.find((m) => m.value === v)?.label ?? v) : "Harness default")
              return (
                <div key={app.id} className="flex items-center gap-3">
                  <span className="w-28 shrink-0 truncate text-sm">{app.name}</span>
                  <Select value={current} onValueChange={(v) => setModel(app.id, (v as string | null) || null)}>
                    <SelectTrigger className="flex-1" aria-label={`Default model for ${app.name}`}>
                      <SelectValue>{(v: string | null) => label(v)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={null}>Harness default</SelectItem>
                      {app.catalog.models.map((m) => (
                        <SelectItem key={m.value} value={m.value}>
                          <span className="flex-1">{m.label}</span>
                          <span className="ml-3 font-mono text-[10px] text-muted-foreground">{m.value}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )
            })}
          </div>
        </Field>
      )}

      <Field label="Agent instructions" hint="Told to every task of this project, after the standing instruction to commit and push its work. What only this repository needs said: which tests to run, what not to touch.">
        <Textarea
          value={value.taskAgentInstructions}
          onChange={(e) => set({ taskAgentInstructions: e.target.value })}
          placeholder="Run `npm test` before pushing."
          rows={3}
          className="font-mono text-sm"
        />
      </Field>

      <Field label="Accept command" hint={<>Run by <span className="font-medium">Accept</span>, in the task&apos;s worker. Exit 0 marks it done. Empty = Accept just closes the task.</>}>
        <Input value={value.taskValidateCommand} onChange={(e) => set({ taskValidateCommand: e.target.value })} placeholder='git push origin "$SPUNTO_TASK_BRANCH"' className="font-mono" />
      </Field>

      <Field label="Drop command" hint="Cleanup run when a task is dropped, after its session is killed.">
        <Input value={value.taskCancelCommand} onChange={(e) => set({ taskCancelCommand: e.target.value })} placeholder='git push origin --delete "$SPUNTO_TASK_BRANCH"' className="font-mono" />
      </Field>

      <Field label="Worker during review" hint="A task keeps its worker until it is done or failed either way — releasing it mid-review would wipe what you are reviewing.">
        <Choice name="taskReviewMode" options={REVIEW_MODES} value={value.taskReviewMode} onChange={(v) => set({ taskReviewMode: v })} />
      </Field>
    </div>
  )
}
