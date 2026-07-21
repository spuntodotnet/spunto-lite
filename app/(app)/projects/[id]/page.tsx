"use client"

import { use, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Pencil, Trash2, Copy, Check, History, GitBranch, Cpu, Terminal } from "lucide-react"
import { api } from "@/lib/api"
import type { Project, ProjectVersion } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { SecretsCard } from "@/components/secrets-card"
import { WorkersPanel } from "@/components/workers-panel"

export default function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const qc = useQueryClient()

  const { data: project, isLoading } = useQuery({
    queryKey: ["project", id],
    queryFn: () => api.get<Project>(`/api/projects/${id}`),
  })
  const { data: versions = [] } = useQuery({
    queryKey: ["versions", id],
    queryFn: () => api.get<ProjectVersion[]>(`/api/projects/${id}/versions`),
  })

  const del = useMutation({
    mutationFn: () => api.del(`/api/projects/${id}`),
    onSuccess: () => {
      toast.success("Project deleted")
      router.push("/projects")
    },
  })
  const restore = useMutation({
    mutationFn: (version: number) => api.post(`/api/projects/${id}/versions/${version}/restore`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project", id] })
      qc.invalidateQueries({ queryKey: ["versions", id] })
      toast.success("Version restored")
    },
  })

  if (isLoading) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (!project) return <p className="p-6 text-sm text-muted-foreground">Project not found.</p>

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="font-[family-name:var(--font-syne)] text-2xl font-bold tracking-tight truncate">
              {project.name}
            </h1>
            <Badge variant="muted">v{project.currentVersion}</Badge>
            {project.dind && <Badge variant="warning">DinD</Badge>}
          </div>
          <p className="text-sm text-muted-foreground mt-1">{project.description || "No description"}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Link href={`/projects/${id}/edit`}>
            <Button variant="outline" size="sm">
              <Pencil /> Edit
            </Button>
          </Link>
          <Button variant="ghost" size="sm" onClick={() => confirm("Delete this project?") && del.mutate()}>
            <Trash2 /> Delete
          </Button>
        </div>
      </div>

      <WorkersPanel projectId={id} projectVersion={project.currentVersion} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SpecCard project={project} />
        <div className="space-y-4">
          {project.deployPublicKey && <DeployKeyCard publicKey={project.deployPublicKey} />}
          <SecretsCard
            title="Project secrets"
            description="Injected as env vars into every worker of this project."
            basePath={`/api/projects/${id}/secrets`}
            queryKey={["secrets", id]}
          />
          <VersionsCard versions={versions} current={project.currentVersion} onRestore={(v) => restore.mutate(v)} />
        </div>
      </div>
    </div>
  )
}

function SpecCard({ project }: { project: Project }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Cpu className="size-4" /> Spec
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <Row label="Image">
          <span className="font-mono text-xs">{project.image}</span>
        </Row>
        {project.repositories.length > 0 && (
          <Row label="Repos">
            <div className="space-y-1">
              {project.repositories.map((r) => (
                <div key={r.id} className="flex items-center gap-1.5 text-xs">
                  <GitBranch className="size-3 text-muted-foreground" />
                  <span className="font-mono">{r.cloneUrl || r.project}</span>
                  <span className="text-muted-foreground">→ {r.workspacePath}</span>
                </div>
              ))}
            </div>
          </Row>
        )}
        {project.features.length > 0 && (
          <Row label="Features">
            <div className="flex flex-wrap gap-1">
              {project.features.map((f) => (
                <Badge key={f.id} variant="muted">
                  {f.id}
                  {f.options?.version ? `@${f.options.version}` : ""}
                </Badge>
              ))}
            </div>
          </Row>
        )}
        {project.forwardPorts.length > 0 && (
          <Row label="Ports">
            <span className="font-mono text-xs">{project.forwardPorts.join(", ")}</span>
          </Row>
        )}
        {project.postCreateCommand && (
          <Row label="postCreate">
            <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{project.postCreateCommand}</code>
          </Row>
        )}
        {project.postStartCommand && (
          <Row label="postStart">
            <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{project.postStartCommand}</code>
          </Row>
        )}
      </CardContent>
    </Card>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className="w-24 shrink-0 text-muted-foreground text-xs pt-0.5">{label}</div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

function DeployKeyCard({ publicKey }: { publicKey: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Deploy key</CardTitle>
        <CardDescription>Register this as a read-only deploy key on your git host to clone private repos.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-start gap-2">
          <code className="flex-1 text-[10px] font-mono bg-muted rounded p-2 break-all">{publicKey}</code>
          <Button
            variant="outline"
            size="icon"
            className="size-8 shrink-0"
            onClick={() => {
              navigator.clipboard.writeText(publicKey)
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }}
          >
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function VersionsCard({
  versions,
  current,
  onRestore,
}: {
  versions: ProjectVersion[]
  current: number
  onRestore: (v: number) => void
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <History className="size-4" /> Version history
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {versions.map((v) => (
          <div key={v.id} className="flex items-center justify-between rounded-md border border-border px-3 py-1.5">
            <span className="text-sm">
              v{v.version} {v.version === current && <Badge variant="success" className="ml-1">current</Badge>}
            </span>
            {v.version !== current && (
              <Button variant="ghost" size="sm" onClick={() => onRestore(v.version)}>
                Restore
              </Button>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
