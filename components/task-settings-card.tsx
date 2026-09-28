"use client"

import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "@spunto/design-system"
import { CatalogCard, CatalogChip, CatalogMark } from "@spunto/design-system/devcontainer"
import { Bot, SlidersHorizontal } from "lucide-react"
import { api } from "@/lib/api"
import { DEFAULT_AGENT_COMMAND, DEFAULT_FOLLOW_UP_COMMAND, packMatches, type HarnessPack } from "@/lib/harness-packs"
import type { Project } from "@/lib/types"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"

/**
 * How this project's tasks run (docs/tasks.md § "Ce que le projet décide") — Spunto Cloud's
 * "Delegated work" settings, as a card beside the project form rather than inside it.
 *
 * Beside, because none of it goes into the image: the form's Save mints a version and marks every
 * worker out of date, and changing the harness must not. This card PATCHes the task fields alone,
 * which the API applies without a version (`updateProject`).
 *
 * The harness is picked from the catalogue's cards (`GET /api/harness-packs`). A pack is a
 * suggestion, never a remembered choice: the active one is re-derived from the fields each render
 * (`packMatches`), and "Custom" shows the three fields a card otherwise explains.
 */

type Protocol = "none" | "claude-json" | "claude-stream" | "jsonl"

type Value = {
  taskAgentCommand: string
  taskAgentProtocol: Protocol
  taskFollowUpCommand: string
  taskResetCommand: string
  taskValidateCommand: string
  taskCancelCommand: string
  taskReviewMode: "keep" | "stop"
  taskAgentModel: string
  taskAgentInstructions: string
}

const PROTOCOLS: { value: Protocol; label: string; hint: string }[] = [
  { value: "claude-stream", label: "Claude Code, interactive", hint: "The session stays alive between turns: read it live, answer it while it works, interrupt it." },
  { value: "claude-json", label: "Claude Code", hint: "Read live, but the session runs once and hands back; a reply resumes it." },
  { value: "jsonl", label: "Spunto events (JSONL)", hint: "Your harness prints one JSON event per line in Spunto's own vocabulary." },
  { value: "none", label: "Don't capture", hint: "Only a tail of stdout, readable once it's over. No live timeline, no replies." },
]

const PROTOCOL_CHIP: Record<Protocol, string> = {
  none: "stdout tail",
  "claude-json": "live stream",
  "claude-stream": "live · answer · interrupt",
  jsonl: "your own JSONL",
}

const REVIEW_MODES = [
  { value: "keep" as const, label: "Keep it running", hint: "Instant to pick back up, at the cost of a live container while review lasts." },
  { value: "stop" as const, label: "Stop it", hint: "Park the container, state kept on disk; Accept, Drop or a reply starts it again." },
]

function fromProject(p: Project): Value {
  return {
    taskAgentCommand: p.taskAgentCommand ?? "",
    taskAgentProtocol: (p.taskAgentProtocol as Protocol) ?? "claude-stream",
    taskFollowUpCommand: p.taskFollowUpCommand ?? "",
    taskResetCommand: p.taskResetCommand ?? "",
    taskValidateCommand: p.taskValidateCommand ?? "",
    taskCancelCommand: p.taskCancelCommand ?? "",
    taskReviewMode: p.taskReviewMode === "stop" ? "stop" : "keep",
    taskAgentModel: p.taskAgentModel ?? "",
    taskAgentInstructions: p.taskAgentInstructions ?? "",
  }
}

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

export function TaskSettingsCard({ project }: { project: Project }) {
  const qc = useQueryClient()
  const [value, setValue] = useState<Value>(() => fromProject(project))
  const [explicitMode, setExplicitMode] = useState<"preset" | "custom" | null>(null)
  const { data: packs = [] } = useQuery({
    queryKey: ["harness-packs"],
    queryFn: () => api.get<HarnessPack[]>("/api/harness-packs"),
    staleTime: Infinity,
  })
  const activePack = packs.find((p) => packMatches(p, value))
  const mode = explicitMode ?? (packs.length === 0 ? "custom" : activePack ? "preset" : "custom")
  const set = (patch: Partial<Value>) => setValue((v) => ({ ...v, ...patch }))
  const dirty = JSON.stringify(value) !== JSON.stringify(fromProject(project))

  const save = useMutation({
    // Blank = back to the default, which the API stores as null.
    mutationFn: () => api.patch<Project>(`/api/projects/${project.id}`, value),
    onSuccess: (updated) => {
      qc.setQueryData(["project", project.id], updated)
      setValue(fromProject(updated))
      toast.success("Delegated work settings saved")
    },
    onError: (e) => toast.error((e as Error).message),
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Bot className="h-4 w-4" /> Delegated work
        </CardTitle>
        <CardDescription>
          How this project&apos;s tasks run — the agents you delegate to from the project page or from Agents. Leave it
          as it is and you get Claude Code, read live as it works: add the <span className="font-mono">claude-code</span>{" "}
          feature to the project and an <span className="font-mono">ANTHROPIC_API_KEY</span> (or{" "}
          <span className="font-mono">CLAUDE_CODE_OAUTH_TOKEN</span>) secret. Saved on its own, without a new version:
          nothing here goes into the image.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {packs.length > 0 && (
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Harness</label>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {packs.map((pack) => (
                <CatalogCard
                  key={pack.id}
                  tone="build"
                  mark={<CatalogMark mark="claude" label={pack.label} tone="build" />}
                  watermark="claude"
                  title={pack.label}
                  description={pack.description}
                  selected={mode === "preset" && activePack?.id === pack.id}
                  onSelect={() => {
                    set({ taskAgentCommand: pack.agentCommand, taskFollowUpCommand: pack.followUpCommand, taskAgentProtocol: pack.protocol as Protocol })
                    setExplicitMode("preset")
                  }}
                >
                  <div className="flex flex-wrap items-center gap-1">
                    <CatalogChip title={pack.agentCommand}>{pack.agentCommand}</CatalogChip>
                    <CatalogChip>{PROTOCOL_CHIP[pack.protocol as Protocol]}</CatalogChip>
                  </div>
                </CatalogCard>
              ))}
              <CatalogCard
                custom
                tone="build"
                mark={
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <SlidersHorizontal className="h-4 w-4" />
                  </span>
                }
                title="Custom"
                description="Your own CLI — anything that reads its prompt on stdin."
                selected={mode === "custom"}
                onSelect={() => setExplicitMode("custom")}
              />
            </div>
          </div>
        )}

        {mode === "custom" && (
          <>
            <Field label="Agent command" hint={<>Runs a task&apos;s session in the worker. The prompt arrives on <span className="font-mono">stdin</span> — the only contract.</>}>
              <Input value={value.taskAgentCommand} onChange={(e) => set({ taskAgentCommand: e.target.value })} placeholder={DEFAULT_AGENT_COMMAND} className="font-mono" />
            </Field>
            <Field
              label="Session stream"
              hint={<>The only thing Spunto adds to your command, and only if it doesn&apos;t already set <span className="font-mono">--output-format</span>.</>}
            >
              <Choice name="taskAgentProtocol" options={PROTOCOLS} value={value.taskAgentProtocol} onChange={(v) => set({ taskAgentProtocol: v })} />
            </Field>
            <Field
              label="Follow-up command"
              hint={<>Runs when you answer a session that has handed back. The reply arrives on <span className="font-mono">stdin</span>, <span className="font-mono">SPUNTO_TASK_SESSION_ID</span> is in the environment.</>}
            >
              <Input value={value.taskFollowUpCommand} onChange={(e) => set({ taskFollowUpCommand: e.target.value })} placeholder={DEFAULT_FOLLOW_UP_COMMAND} className="font-mono" />
            </Field>
          </>
        )}

        <Field
          label="Default model"
          hint={<>Added as <span className="font-mono">--model</span> unless the command names one, and set as <span className="font-mono">SPUNTO_TASK_MODEL</span>. A task can override it. Empty = the harness&apos;s default.</>}
        >
          <Input
            list="task-model-options"
            value={value.taskAgentModel}
            onChange={(e) => set({ taskAgentModel: e.target.value })}
            placeholder="Harness default"
            className="font-mono"
          />
          <datalist id="task-model-options">
            {packs.flatMap((p) => p.models).map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </datalist>
        </Field>

        <Field label="Agent instructions" hint="Told to every task of this project, after the standing instruction to commit and push its work. What only this repository needs said: which tests to run, what not to touch.">
          <Textarea
            value={value.taskAgentInstructions}
            onChange={(e) => set({ taskAgentInstructions: e.target.value })}
            placeholder="Run `npm test` before pushing."
            rows={3}
            className="font-mono text-sm"
          />
        </Field>

        <Field
          label="Reset command"
          hint={<>Run when a task lands on a <em>reused</em> machine, after its branch is checked out: reseed, reinstall, restart. The git tree is reset and cleaned either way.</>}
        >
          <Input value={value.taskResetCommand} onChange={(e) => set({ taskResetCommand: e.target.value })} placeholder="npm ci && npm run db:reset" className="font-mono" />
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

        <div className="flex justify-end">
          <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
