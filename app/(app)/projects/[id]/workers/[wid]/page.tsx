"use client"

import { use, useEffect, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts"
import {
  ArrowLeft,
  Code2,
  ExternalLink,
  Square,
  Play,
  AlignLeft,
  Terminal as TerminalIcon,
  RefreshCw,
  GitBranch,
  Cpu,
  MemoryStick,
  Check,
  Loader,
  RotateCw,
  Trash2,
  X,
  Plus,
  AlertTriangle,
} from "lucide-react"
import { chartColors } from "@spunto/design-system/colors"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import type { Worker, Project, ProjectImageBuild, SetupStatus } from "@/lib/types"
import { Button, buttonVariants } from "@/components/ui/button"
import { LogsPanel } from "@/components/logs-panel"
import { TerminalSessions } from "@/components/terminal-sessions"
import {
  ResourceBars,
  StepIndicator,
  setupProgress,
  phaseLabel,
  cfgFor,
  isSettingUp,
  tagColor,
  formatRelativeTime,
  type Stats,
} from "@/components/worker-card"
import { workerBaseUrl } from "@/lib/worker-url"

type GitStatus = { path: string; branch: string; modified: number; ahead: number; behind: number }
type Tab = "logs" | "terminal"

function SH({ children }: { children: React.ReactNode }) {
  return <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50 mb-2">{children}</p>
}

export default function WorkerCockpit({ params }: { params: Promise<{ id: string; wid: string }> }) {
  const { id, wid } = use(params)
  const router = useRouter()
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>("logs")
  const [reconnect, setReconnect] = useState(0)
  const [statPoints, setStatPoints] = useState<{ t: string; cpuPercent: number; memUsageMb: number }[]>([])

  const { data: worker } = useQuery({
    queryKey: ["worker", wid],
    queryFn: () => api.get<Worker>(`/api/workers/${wid}`),
    refetchInterval: 2500,
  })
  const { data: project } = useQuery({ queryKey: ["project", id], queryFn: () => api.get<Project>(`/api/projects/${id}`) })

  const running = worker?.state === "ready"
  const settingUp = worker ? isSettingUp(worker.state) : false
  const building = worker?.state === "building"

  const { data: builds = [] } = useQuery({
    queryKey: ["builds", id],
    queryFn: () => api.get<ProjectImageBuild[]>(`/api/projects/${id}/builds`),
    refetchInterval: building ? 2000 : false,
    enabled: !worker?.containerId,
  })
  const { data: gitStatus = [] } = useQuery({
    queryKey: ["git-status", wid],
    queryFn: () => api.get<GitStatus[]>(`/api/workers/${wid}/git-status`),
    refetchInterval: running ? 5000 : false,
    enabled: running,
  })
  const { data: stats } = useQuery({
    queryKey: ["stats", wid],
    queryFn: () => api.get<Stats | null>(`/api/workers/${wid}/stats`),
    refetchInterval: running ? 3000 : false,
    enabled: running,
  })
  const { data: ports = [] } = useQuery({
    queryKey: ["ports", wid],
    queryFn: () => api.get<number[]>(`/api/workers/${wid}/ports`),
    refetchInterval: running ? 5000 : false,
    enabled: running,
  })

  useEffect(() => {
    if (stats) {
      setStatPoints((prev) => [...prev, { t: new Date().toLocaleTimeString(), cpuPercent: stats.cpuPercent, memUsageMb: stats.memUsageMb }].slice(-60))
    }
  }, [stats])

  const invalidate = () => qc.invalidateQueries({ queryKey: ["worker", wid] })
  const act = (path: string, msg: string) =>
    api.post(`/api/workers/${wid}/${path}`).then(() => { invalidate(); toast.success(msg) }).catch((e) => toast.error((e as Error).message))
  const del = () => api.del(`/api/workers/${wid}`).then(() => { toast.success("Workspace deleted"); router.push(`/projects/${id}`) })

  async function setTags(tags: string[]) {
    await api.post(`/api/workers/${wid}/tags`, { tags }).catch((e) => toast.error((e as Error).message))
    invalidate()
  }

  if (!worker) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>

  const cfg = cfgFor(worker.state)
  const status = worker.setupStatus
  const activeBuild = builds[0]
  const codeUrl = workerBaseUrl(worker.id)

  const controlPanel = (
    <div className="p-4 space-y-5">
      {worker.state === "error" && status?.error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-500">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="font-mono truncate">{status.error}</span>
        </div>
      )}

      {(settingUp || status) && (
        <div>
          <SH>Setup</SH>
          <SetupTimeline status={status} state={worker.state} />
        </div>
      )}

      {running && (
        <div>
          <SH>Resources</SH>
          {stats ? (
            <div className="rounded-lg border border-border/40 bg-muted/20 px-3 py-3 space-y-3">
              <ResourceBars stats={stats} compact />
              <div className="pt-1">
                <StatsChart statPoints={statPoints} memLimitMb={stats.memLimitMb} last={stats} />
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono py-2">
              <Loader className="h-3 w-3 animate-spin" /> Loading stats…
            </div>
          )}
        </div>
      )}

      {gitStatus.length > 0 && (
        <div>
          <SH>Repositories</SH>
          <div className="space-y-1.5">
            {gitStatus.map((repo) => (
              <div key={repo.path} className="rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <GitBranch className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="text-xs font-mono font-medium truncate">{repo.path.replace("/workspace/", "")}</span>
                  </div>
                  {running && (
                    <a href={workerBaseUrl(worker.id, { folder: repo.path })} target="_blank" rel="noreferrer" className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "h-6 px-2 text-[11px] gap-1 text-muted-foreground shrink-0")}>
                      <Code2 className="h-3 w-3" /> Open
                    </a>
                  )}
                </div>
                <div className="mt-1.5 flex items-center gap-2 pl-[18px] text-[11px] text-muted-foreground">
                  <span className="font-mono">{repo.branch || "—"}</span>
                  {repo.modified > 0 && <span className="rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 px-1.5 py-0.5 text-[10px] font-semibold">{repo.modified} modified</span>}
                  {repo.ahead > 0 && <span className="text-primary">↑{repo.ahead}</span>}
                  {repo.behind > 0 && <span className="text-orange-400">↓{repo.behind}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {running && ports.length > 0 && (
        <div>
          <SH>Open ports</SH>
          <div className="space-y-1.5">
            {ports.map((p) => (
              <div key={p} className="flex items-center justify-between rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
                <span className="text-xs font-mono text-foreground">:{p}</span>
                <a href={workerBaseUrl(worker.id, p)} target="_blank" rel="noreferrer" className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "h-6 px-2 text-[11px] gap-1 text-muted-foreground shrink-0")}>
                  <ExternalLink className="h-3 w-3" /> Open
                </a>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <SH>Tags</SH>
        <TagsEditor tags={worker.tags} onChange={setTags} />
      </div>

      <div>
        <SH>Actions</SH>
        <div className="space-y-1.5">
          <button onClick={() => act("rebuild", "Rebuilding…")} className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg border border-border/50 bg-muted/20 hover:bg-muted/40 transition-colors text-xs text-foreground">
            <RotateCw className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="font-medium">Rebuild container</span>
            <span className="ml-auto text-[10px] text-muted-foreground/50">keeps workspace</span>
          </button>
          <button onClick={() => confirm("Delete this workspace?") && del()} className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg border border-red-500/20 bg-red-500/5 hover:bg-red-500/10 transition-colors text-xs text-red-600 dark:text-red-400">
            <Trash2 className="h-3.5 w-3.5" />
            <span className="font-medium">Delete workspace</span>
            <span className="ml-auto text-[10px] opacity-60">permanent</span>
          </button>
        </div>
      </div>

      <div>
        <SH>Info</SH>
        <div className="rounded-lg border border-border/50 bg-muted/20 divide-y divide-border/40">
          <InfoRow label="Config version" value={`v${worker.projectVersion}`} mono />
          <InfoRow label="Created" value={formatRelativeTime(worker.createdAt)} />
          {worker.containerId && <InfoRow label="Container" value={worker.containerId.slice(0, 12)} mono muted />}
          <InfoRow label="Node" value="local · Docker" mono />
        </div>
      </div>
    </div>
  )

  return (
    <div className="flex flex-col overflow-hidden" style={{ height: "calc(100vh - 3.5rem)" }}>
      {/* Top bar */}
      <div className="flex items-center justify-between gap-3 px-5 md:px-6 py-3 border-b border-border bg-card/60 backdrop-blur-sm shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Link href={`/projects/${id}`} className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "h-8 w-8 shrink-0")}>
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div className="h-4 w-px bg-border" />
          {project && (
            <>
              <span className="text-sm text-muted-foreground truncate hidden sm:block">{project.name}</span>
              <span className="text-muted-foreground/40 hidden sm:block">/</span>
            </>
          )}
          <div className="flex items-center gap-2 min-w-0">
            <div className="relative shrink-0">
              <div className={cn("h-2 w-2 rounded-full", settingUp ? "bg-yellow-400" : cfg.dotClass)} />
              {running && <div className="absolute inset-0 h-2 w-2 rounded-full bg-green-500 animate-ping opacity-50" />}
            </div>
            <span className="font-semibold text-sm truncate">{worker.name}</span>
            <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium leading-none shrink-0", cfg.pillClass)}>{cfg.label}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {running && (
            <a href={codeUrl} target="_blank" rel="noreferrer" className={cn(buttonVariants({ variant: "default", size: "sm" }), "h-8 px-3 text-xs gap-1.5")}>
              <Code2 className="h-3.5 w-3.5" /> Open VS Code <ExternalLink className="h-2.5 w-2.5 opacity-70" />
            </a>
          )}
          {running && (
            <Button variant="ghost" size="sm" className="h-8 px-3 text-xs gap-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10" onClick={() => act("stop", "Stopped")}>
              <Square className="h-3.5 w-3.5" /> Stop
            </Button>
          )}
          {(worker.state === "stopped" || worker.state === "error") && (
            <Button variant="outline" size="sm" className="h-8 px-3 text-xs gap-1.5" onClick={() => act("start", "Starting…")}>
              <Play className="h-3.5 w-3.5" /> Start
            </Button>
          )}
        </div>
      </div>

      {/* Main split */}
      <div className="flex flex-col lg:flex-row flex-1 min-h-0 overflow-hidden">
        {/* Left: tabbed logs/terminal */}
        <div className="flex flex-col flex-1 min-h-0 lg:border-r border-border" style={{ minHeight: 320 }}>
          <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-border bg-card shrink-0">
            <div className="flex items-center gap-0.5 overflow-x-auto">
              {([{ id: "logs", label: "Logs", icon: AlignLeft }, { id: "terminal", label: "Terminal", icon: TerminalIcon }] as const).map(({ id: t, label, icon: Icon }) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={cn("flex shrink-0 items-center gap-1.5 px-3 py-1.5 text-xs rounded-md transition-colors font-medium", tab === t ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-accent/50")}
                >
                  <Icon className="h-3.5 w-3.5" /> {label}
                </button>
              ))}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <span className="hidden sm:inline text-[10px] text-muted-foreground/50 font-mono">{worker.name}</span>
              <button onClick={() => setReconnect((k) => k + 1)} className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground/50 hover:text-muted-foreground hover:bg-accent transition-colors" title="Reconnect">
                <RefreshCw className="h-3 w-3" />
              </button>
            </div>
          </div>

          <div className="flex-1 min-h-0 bg-[#09090b]">
            {tab === "logs" && (
              <div className="h-full p-2">
                {worker.containerId ? (
                  <LogsPanel url={`/api/workers/${wid}/logs`} />
                ) : activeBuild ? (
                  <div className="flex flex-col h-full">
                    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-white/5 shrink-0">
                      <span className="text-[10px] font-mono text-yellow-400/70">Build image</span>
                      <span className={cn("h-1.5 w-1.5 rounded-full", activeBuild.state === "building" ? "bg-yellow-400 animate-pulse" : activeBuild.state === "ready" ? "bg-green-500" : "bg-red-500")} />
                    </div>
                    <div className="flex-1 min-h-0 p-2">
                      <BuildLogs projectId={id} building={building} />
                    </div>
                  </div>
                ) : (
                  <div className="flex h-full items-center justify-center">
                    <p className="text-xs text-muted-foreground font-mono">No container yet</p>
                  </div>
                )}
              </div>
            )}
            {tab === "terminal" && running && <TerminalSessions workerId={wid} enabled reconnectKey={reconnect} />}
            {tab === "terminal" && !running && (
              <div className="flex h-full items-center justify-center p-2">
                <p className="text-xs text-muted-foreground font-mono">Worker must be running to use the terminal</p>
              </div>
            )}
          </div>
        </div>

        {/* Right: control panel */}
        <div className="lg:w-80 xl:w-96 shrink-0 overflow-y-auto bg-card border-t lg:border-t-0 border-border">
          {controlPanel}
        </div>
      </div>
    </div>
  )
}

// ─── SetupTimeline ───────────────────────────────────────────────────────────

function SetupTimeline({ status, state }: { status: SetupStatus | null; state: string }) {
  const settingUp = isSettingUp(state)
  const isError = state === "error"
  const isDone = state === "ready"
  const pct = setupProgress(status)

  const steps: { key: string; state: "pending" | "running" | "done" | "error"; icon: React.ReactNode; label: string }[] = []
  for (const r of status?.repos ?? []) {
    steps.push({ key: `repo-${r.name}`, state: r.state === "cloning" ? "running" : (r.state as "pending" | "done" | "error"), icon: <GitBranch className="h-3 w-3" />, label: r.name })
  }
  if (status?.postCreate) steps.push({ key: "postCreate", state: status.postCreate, icon: <TerminalIcon className="h-3 w-3" />, label: "postCreate" })
  if (status?.postStart) steps.push({ key: "postStart", state: status.postStart, icon: <TerminalIcon className="h-3 w-3" />, label: "postStart" })

  return (
    <div className={cn("rounded-lg border text-xs", settingUp && !isError ? "bg-yellow-500/5 border-yellow-500/20" : isError ? "bg-red-500/5 border-red-500/20" : "bg-muted/20 border-border/40")}>
      <div className="flex items-center justify-between px-3 py-2 border-b border-inherit">
        <span className={cn("font-mono text-[11px] font-medium", settingUp && !isError ? "text-yellow-500 dark:text-yellow-400" : isError ? "text-red-400" : isDone ? "text-green-600 dark:text-green-400" : "text-muted-foreground")}>
          {settingUp ? phaseLabel(status) : isDone ? "Setup complete" : isError ? "Setup failed" : "Setup"}
        </span>
        {settingUp && <span className="font-mono text-[11px] text-muted-foreground tabular-nums">{pct}%</span>}
        {isDone && <Check className="h-3 w-3 text-green-500" />}
      </div>
      {settingUp && (
        <div className="px-3 pt-2.5 pb-1">
          <div className="h-1 rounded-full bg-muted overflow-hidden">
            <div className={cn("h-full rounded-full transition-all duration-700", isError ? "bg-red-500" : "bg-yellow-400")} style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}
      {(steps.length > 0 || settingUp || isError) && (
        <div className="px-3 py-2.5 space-y-2">
          {steps.map((step) => (
            <div key={step.key} className="flex items-center gap-2">
              <StepIndicator state={step.state} />
              <span className={cn("shrink-0", step.state === "done" ? "text-muted-foreground/50" : step.state === "running" ? "text-foreground/80" : step.state === "error" ? "text-red-400/70" : "text-muted-foreground/30")}>{step.icon}</span>
              <span className={cn("font-mono leading-none", step.state === "done" ? "text-muted-foreground/70" : step.state === "running" ? "text-foreground font-medium" : step.state === "error" ? "text-red-400" : "text-muted-foreground/40")}>{step.label}</span>
            </div>
          ))}
          {steps.length === 0 && settingUp && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader className="h-3 w-3 animate-spin shrink-0" />
              <span className="font-mono">Waiting for container…</span>
            </div>
          )}
          {isError && status?.error && <div className="mt-1 text-red-400 font-mono text-[11px] bg-red-500/10 rounded px-2 py-1.5 break-all leading-4">{status.error}</div>}
        </div>
      )}
    </div>
  )
}

// ─── StatsChart ──────────────────────────────────────────────────────────────

const TS = { background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 6, fontSize: 11 }

function StatsChart({ statPoints, memLimitMb, last }: { statPoints: { t: string; cpuPercent: number; memUsageMb: number }[]; memLimitMb: number; last: Stats }) {
  if (statPoints.length === 0) {
    return (
      <div className="flex items-center gap-2 py-6 text-muted-foreground text-xs font-mono justify-center">
        <Loader className="h-3 w-3 animate-spin" /> Collecting metrics…
      </div>
    )
  }
  return (
    <div className="grid grid-cols-2 gap-4">
      <div>
        <div className="flex items-center gap-1.5 mb-2">
          <Cpu className="h-3 w-3 text-primary" />
          <span className="text-xs text-muted-foreground font-mono">CPU %</span>
          <span className="ml-auto text-xs font-mono text-foreground/80 tabular-nums">{(last.cpuPercent ?? 0).toFixed(1)}%</span>
        </div>
        <ResponsiveContainer width="100%" height={90}>
          <LineChart data={statPoints} margin={{ top: 2, right: 4, bottom: 0, left: -20 }}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" opacity={0.5} />
            <XAxis dataKey="t" hide />
            <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={false} />
            <Tooltip contentStyle={TS} itemStyle={{ color: chartColors.cpu }} formatter={(v) => [`${Number(v).toFixed(2)}%`, "CPU"]} />
            <Line type="monotone" dataKey="cpuPercent" stroke={chartColors.cpu} strokeWidth={1.5} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div>
        <div className="flex items-center gap-1.5 mb-2">
          <MemoryStick className="h-3 w-3 text-build" />
          <span className="text-xs text-muted-foreground font-mono">Memory MB</span>
          <span className="ml-auto text-xs font-mono text-foreground/80 tabular-nums">{(last.memUsageMb ?? 0).toFixed(0)} MB</span>
        </div>
        <ResponsiveContainer width="100%" height={90}>
          <LineChart data={statPoints} margin={{ top: 2, right: 4, bottom: 0, left: -20 }}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" opacity={0.5} />
            <XAxis dataKey="t" hide />
            <YAxis domain={[0, Math.max(memLimitMb, 1)]} tick={{ fontSize: 9, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={false} />
            <Tooltip contentStyle={TS} itemStyle={{ color: chartColors.memory }} formatter={(v) => [`${Number(v).toFixed(1)} MB`, "Memory"]} />
            <Line type="monotone" dataKey="memUsageMb" stroke={chartColors.memory} strokeWidth={1.5} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

// ─── Tags editor ─────────────────────────────────────────────────────────────

function TagsEditor({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const [showInput, setShowInput] = useState(false)
  const [value, setValue] = useState("")
  const commit = () => {
    const v = value.trim()
    if (v && !tags.includes(v)) onChange([...tags, v])
    setValue("")
    setShowInput(false)
  }
  return (
    <div className="flex flex-wrap gap-1.5 items-center">
      {tags.map((tag) => {
        const c = tagColor(tag)
        return (
          <span key={tag} className={cn("inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium", c.bg, c.text, c.border)}>
            {tag}
            <button onClick={() => onChange(tags.filter((t) => t !== tag))} className="ml-0.5 opacity-50 hover:opacity-100 transition-opacity" aria-label={`Remove ${tag}`}>
              <X className="h-3 w-3" />
            </button>
          </span>
        )
      })}
      {showInput ? (
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setValue(""); setShowInput(false) } }}
          onBlur={commit}
          placeholder="tag…"
          className="h-7 w-24 rounded-full border border-primary/40 bg-primary/5 px-3 text-xs text-primary outline-none focus:border-primary/60"
        />
      ) : (
        <button onClick={() => setShowInput(true)} className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2.5 py-1 text-xs text-muted-foreground/60 hover:text-muted-foreground hover:border-border/80 transition-colors">
          <Plus className="h-3 w-3" /> Add tag
        </button>
      )}
    </div>
  )
}

function InfoRow({ label, value, mono, muted }: { label: string; value: string; mono?: boolean; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between px-3 py-2">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className={cn("text-[11px] font-medium", mono && "font-mono", muted && "text-muted-foreground")}>{value}</span>
    </div>
  )
}

function BuildLogs({ projectId, building }: { projectId: string; building: boolean }) {
  const { data: builds = [] } = useQuery({
    queryKey: ["builds", projectId],
    queryFn: () => api.get<ProjectImageBuild[]>(`/api/projects/${projectId}/builds`),
    refetchInterval: building ? 1500 : false,
  })
  return (
    <pre className="h-full overflow-auto text-zinc-300 text-[11px] font-mono whitespace-pre-wrap break-words">
      {builds[0]?.logs || "Building…"}
    </pre>
  )
}
