"use client"

import { use, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "@spunto/design-system"
import {
  ArrowLeft,
  SquarePen,
  Container as ContainerIcon,
  GitBranch,
  KeyRound,
  Box,
  Puzzle,
  Network,
  Terminal as TerminalIcon,
  History,
  ChevronDown,
  RotateCcw,
  Calendar,
  Zap,
  Loader2,
  CheckCircle2,
  Clipboard,
  Check,
  Cpu,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import type { Project, Worker, ProjectVersion, ProjectImageBuild, SecretMeta } from "@/lib/types"
import { buttonVariants } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { WorkersPanel } from "@/components/workers-panel"
import { SpawnWorkerButton } from "@/components/spawn-worker-button"

function Eyebrow({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <p className={cn("text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-2", icon && "flex items-center gap-1.5")}>
      {icon}
      {children}
    </p>
  )
}

export default function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const qc = useQueryClient()
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  const { data: project, isError } = useQuery({ queryKey: ["project", id], queryFn: () => api.get<Project>(`/api/projects/${id}`) })
  const { data: workers = [] } = useQuery({ queryKey: ["workers", id], queryFn: () => api.get<Worker[]>(`/api/projects/${id}/workers`), refetchInterval: 2500 })
  const { data: versions = [] } = useQuery({ queryKey: ["versions", id], queryFn: () => api.get<ProjectVersion[]>(`/api/projects/${id}/versions`) })
  const { data: secrets = [] } = useQuery({ queryKey: ["secrets", id], queryFn: () => api.get<SecretMeta[]>(`/api/projects/${id}/secrets`) })
  const { data: builds = [] } = useQuery({
    queryKey: ["builds", id],
    queryFn: () => api.get<ProjectImageBuild[]>(`/api/projects/${id}/builds`),
    refetchInterval: 3000,
  })

  const restore = useMutation({
    mutationFn: (version: number) => api.post(`/api/projects/${id}/versions/${version}/restore`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project", id] })
      qc.invalidateQueries({ queryKey: ["versions", id] })
      toast.success("Version restored")
    },
    onError: (e) => toast.error((e as Error).message),
  })
  const prebuild = useMutation({
    mutationFn: () => api.post(`/api/projects/${id}/build`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["builds", id] }); toast.success("Pre-building image…") },
    onError: (e) => toast.error((e as Error).message),
  })

  if (isError) {
    router.push("/projects")
    return null
  }
  if (!project) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>

  const runningCount = workers.filter((w) => w.state === "ready").length
  const imageShort = project.image.split("/").pop() ?? project.image
  const currentBuild = builds.find((b) => b.version === project.currentVersion)
  const isBuilding = currentBuild?.state === "building"

  return (
    <div className="flex flex-col gap-4 h-full p-5 md:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Link href="/projects" className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "shrink-0 h-8 w-8")}>
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <h1 className="text-lg font-semibold truncate">{project.name}</h1>
          {project.dind && <Badge variant="outline" className="text-[11px] h-5 px-2 shrink-0 bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30">DinD</Badge>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <SpawnWorkerButton projectId={id} />
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-col gap-4 lg:flex-row lg:gap-5 lg:items-start min-h-0">
        <aside className="w-full lg:w-72 lg:shrink-0 lg:sticky lg:top-0">
          <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
            {/* Header */}
            <div className="px-4 pt-4 pb-3 border-b border-border/60">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-sm leading-tight truncate">{project.name}</p>
                  {project.description && <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{project.description}</p>}
                </div>
                <Link href={`/projects/${id}/edit`} className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "h-7 px-2 gap-1.5 text-xs text-muted-foreground hover:text-foreground shrink-0")}>
                  <SquarePen className="h-3 w-3" /> Edit
                </Link>
              </div>
              <div className="flex items-center gap-3 mt-3">
                <div className="flex items-center gap-1.5">
                  <div className={cn("h-2 w-2 rounded-full", runningCount > 0 ? "bg-green-500" : "bg-zinc-400")} />
                  <span className="text-xs text-muted-foreground"><span className="font-medium text-foreground">{runningCount}</span> running</span>
                </div>
                <span className="text-border">·</span>
                <span className="text-xs text-muted-foreground"><span className="font-medium text-foreground">{workers.length}</span> total</span>
                <span className="text-border">·</span>
                <span className="text-xs text-muted-foreground font-mono">v{project.currentVersion}</span>
              </div>
            </div>

            {/* Image */}
            <div className="px-4 py-3 border-b border-border/60">
              <Eyebrow>Image</Eyebrow>
              <div className="flex items-center gap-2 bg-muted/50 rounded-lg px-3 py-2" title={project.image}>
                <ContainerIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="text-xs font-mono text-foreground/80 truncate">{imageShort}</span>
              </div>
            </div>

            {/* Repositories */}
            {project.repositories.length > 0 && (
              <div className="px-4 py-3 border-b border-border/60">
                <Eyebrow>Repositories</Eyebrow>
                <div className="space-y-1.5">
                  {project.repositories.map((repo) => (
                    <div key={repo.id} className="rounded-lg bg-muted/50 px-3 py-2">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <GitBranch className="h-3 w-3 text-primary shrink-0" />
                        <span className="text-xs font-mono font-medium text-foreground/90 truncate">{(repo.cloneUrl || repo.project).split(/[/:]/).pop()?.replace(/\.git$/, "")}</span>
                      </div>
                      <p className="text-[11px] font-mono text-muted-foreground/70 truncate pl-[18px]">{repo.cloneUrl || repo.project}</p>
                      <p className="text-[11px] font-mono text-muted-foreground/50 truncate pl-[18px]">→ /workspace/{repo.workspacePath}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Deploy key */}
            {project.deployPublicKey && (
              <div className="px-4 py-3 border-b border-border/60">
                <Eyebrow icon={<KeyRound className="h-3 w-3" />}>Deploy key</Eyebrow>
                <div className="space-y-2">
                  <div className="flex items-start gap-2 rounded-lg bg-muted/50 p-3">
                    <code className="flex-1 text-[11px] font-mono break-all leading-relaxed text-foreground/80">{project.deployPublicKey}</code>
                    <button
                      onClick={() => { navigator.clipboard.writeText(project.deployPublicKey!); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
                      className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Clipboard className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">Register this as a read-only deploy key on your git host to clone private repos.</p>
                </div>
              </div>
            )}

            {/* Features */}
            {project.features.length > 0 && (
              <div className="px-4 py-3 border-b border-border/60">
                <Eyebrow>Features</Eyebrow>
                <div className="flex flex-wrap gap-1.5">
                  {project.features.map((f) => (
                    <div key={f.id} title={f.id} className="flex items-center gap-1 bg-build/10 text-build rounded-md px-2 py-1 text-[11px] font-mono">
                      <Box className="h-3 w-3 shrink-0" />
                      {f.id.split("/").pop()}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Extensions */}
            {project.vscodeExtensions.length > 0 && (
              <div className="px-4 py-3 border-b border-border/60">
                <Eyebrow>VS Code extensions</Eyebrow>
                <div className="flex flex-wrap gap-1.5">
                  {project.vscodeExtensions.map((ext) => (
                    <div key={ext} title={ext} className="flex items-center gap-1 bg-primary/10 text-primary rounded-md px-2 py-1 text-[11px] font-mono">
                      <Puzzle className="h-3 w-3 shrink-0" />
                      {ext.split(".").pop()}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Build cache */}
            <div className="px-4 py-3 border-b border-border/60">
              <div className="flex items-center justify-between mb-2">
                <Eyebrow icon={<Zap className="h-3 w-3" />}>Build cache</Eyebrow>
                <button
                  onClick={() => prebuild.mutate()}
                  disabled={prebuild.isPending || isBuilding}
                  className="flex items-center gap-1 text-[10px] text-primary hover:text-primary/80 disabled:opacity-50 transition-colors"
                >
                  {prebuild.isPending || isBuilding ? <Loader2 className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3" />}
                  Pre-build
                </button>
              </div>
              <div className="flex items-center justify-between hover:bg-muted/50 rounded px-1 -mx-1">
                <span className="text-[11px] text-muted-foreground">local · Docker</span>
                {!currentBuild && <span className="text-[10px] text-muted-foreground/40">not built</span>}
                {currentBuild?.state === "building" && <span className="flex items-center gap-1 text-[10px] text-yellow-600"><Loader2 className="h-2.5 w-2.5 animate-spin" /> building</span>}
                {currentBuild?.state === "ready" && <span className="flex items-center gap-1 text-[10px] text-green-600"><CheckCircle2 className="h-2.5 w-2.5" /> ready</span>}
                {currentBuild?.state === "error" && <span className="flex items-center gap-1 text-[10px] text-red-500">✕ error</span>}
              </div>
            </div>

            {/* Forwarded ports */}
            {project.forwardPorts.length > 0 && (
              <div className="px-4 py-3 border-b border-border/60">
                <Eyebrow>Forwarded ports</Eyebrow>
                <div className="flex flex-wrap gap-1.5">
                  {project.forwardPorts.map((p) => (
                    <div key={p} className="flex items-center gap-1 bg-muted rounded-md px-2 py-1 text-[11px] font-mono text-muted-foreground">
                      <Network className="h-3 w-3 shrink-0" />:{p}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Lifecycle */}
            {(project.postCreateCommand || project.postStartCommand) && (
              <div className="px-4 py-3 border-b border-border/60">
                <Eyebrow>Lifecycle</Eyebrow>
                <div className="space-y-1.5">
                  {project.postCreateCommand && <LifecycleRow label="postCreate" cmd={project.postCreateCommand} />}
                  {project.postStartCommand && <LifecycleRow label="postStart" cmd={project.postStartCommand} />}
                </div>
              </div>
            )}

            {/* Secrets */}
            <div className="px-4 py-3 border-b border-border/60">
              <div className="flex items-center justify-between mb-2">
                <Eyebrow icon={<KeyRound className="h-3 w-3" />}>Secrets</Eyebrow>
                <Link href={`/projects/${id}/edit`} className="text-[10px] text-primary hover:text-primary/80 transition-colors">Manage</Link>
              </div>
              {secrets.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {secrets.map((s) => (
                    <div key={s.id} title={s.name} className="flex items-center gap-1 bg-flame/10 text-flame rounded-md px-2 py-1 text-[11px] font-mono">
                      <KeyRound className="h-3 w-3 shrink-0" />
                      {s.name}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground/60">No secrets configured</p>
              )}
            </div>

            {/* Version history */}
            {versions.length > 0 && (
              <div className="px-4 py-3 border-b border-border/60">
                <button onClick={() => setVersionsOpen((v) => !v)} className="flex items-center justify-between w-full text-left">
                  <Eyebrow icon={<History className="h-3 w-3" />}>Version history</Eyebrow>
                  <ChevronDown className={cn("h-3 w-3 text-muted-foreground/50 transition-transform", versionsOpen && "rotate-180")} />
                </button>
                {versionsOpen && (
                  <div className="mt-2 space-y-1">
                    {versions.map((v) => {
                      const isCurrent = v.version === project.currentVersion
                      return (
                        <div key={v.id} className={cn("flex items-center justify-between rounded-lg px-2.5 py-2", isCurrent ? "bg-primary/5 border border-primary/20" : "bg-muted/40")}>
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="text-xs font-mono font-semibold">v{v.version}</span>
                              {isCurrent && <Badge variant="outline" className="text-[9px] h-4 px-1 bg-primary/10 text-primary border-primary/30">current</Badge>}
                            </div>
                            <p className="text-[10px] text-muted-foreground/60 mt-0.5 truncate">{new Date(v.createdAt).toLocaleDateString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</p>
                            <p className="text-[10px] text-muted-foreground/50 truncate font-mono">{v.config.image.split("/").pop()}</p>
                          </div>
                          {!isCurrent && (
                            <button onClick={() => restore.mutate(v.version)} disabled={restore.isPending} title="Restore this version" className="ml-2 shrink-0 flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50 transition-colors">
                              <RotateCcw className={cn("h-3 w-3", restore.isPending && "animate-spin")} /> Restore
                            </button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Footer */}
            <div className="px-4 py-3 space-y-1.5">
              <div className="flex items-center justify-between text-[11px]">
                <span className="flex items-center gap-1.5 text-muted-foreground/60"><Calendar className="h-3 w-3" /> Created</span>
                <span className="text-muted-foreground">{new Date(project.createdAt).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" })}</span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="flex items-center gap-1.5 text-muted-foreground/60"><Cpu className="h-3 w-3" /> Runtime</span>
                <span className="font-medium font-mono">Docker · local</span>
              </div>
            </div>
          </div>
        </aside>

        {/* Right: workers */}
        <div className="flex-1 min-w-0 space-y-3">
          <WorkersPanel projectId={id} projectVersion={project.currentVersion} />
        </div>
      </div>
    </div>
  )
}

function LifecycleRow({ label, cmd }: { label: string; cmd: string }) {
  return (
    <div className="rounded-lg bg-muted/50 px-3 py-2">
      <p className="text-[10px] text-muted-foreground/50 mb-0.5">{label}</p>
      <div className="flex items-center gap-1.5">
        <TerminalIcon className="h-3 w-3 text-muted-foreground shrink-0" />
        <span className="text-xs font-mono text-foreground/80 truncate" title={cmd}>{cmd}</span>
      </div>
    </div>
  )
}
