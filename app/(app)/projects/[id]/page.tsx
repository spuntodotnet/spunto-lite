"use client"

import { use } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "@spunto/design-system"
import { ProjectPanel, PanelSection, type ProjectVersionEntry } from "@spunto/design-system/projects"
import { ArrowLeft, Cpu, Download, TriangleAlert } from "lucide-react"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import { parseFailedExtensions } from "@/lib/extensions"
import type {
  Project,
  Worker,
  ProjectVersion,
  ProjectImageBuild,
  SecretMeta,
  ExtensionRegistryInfo,
} from "@/lib/types"
import { buttonVariants } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { WorkersPanel } from "@/components/workers-panel"
import { SpawnWorkerButton } from "@/components/spawn-worker-button"

export default function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const qc = useQueryClient()

  const { data: project, isError } = useQuery({ queryKey: ["project", id], queryFn: () => api.get<Project>(`/api/projects/${id}`) })
  const { data: workers = [] } = useQuery({ queryKey: ["workers", id], queryFn: () => api.get<Worker[]>(`/api/projects/${id}/workers`), refetchInterval: 2500 })
  const { data: versions = [] } = useQuery({ queryKey: ["versions", id], queryFn: () => api.get<ProjectVersion[]>(`/api/projects/${id}/versions`) })
  const { data: secrets = [] } = useQuery({ queryKey: ["secrets", id], queryFn: () => api.get<SecretMeta[]>(`/api/projects/${id}/secrets`) })
  const { data: builds = [] } = useQuery({
    queryKey: ["builds", id],
    queryFn: () => api.get<ProjectImageBuild[]>(`/api/projects/${id}/builds`),
    refetchInterval: 3000,
  })
  const { data: registry } = useQuery({
    queryKey: ["extension-registry"],
    queryFn: () => api.get<ExtensionRegistryInfo>("/api/extensions/registry"),
    staleTime: Infinity,
  })
  const registryName = registry?.name ?? "the extension registry"

  // Takes the whole entry, not just the number: `ProjectPanel` hands back the
  // entry it drew, and `restore.variables.id` is then what marks the right row
  // as busy (the panel addresses a row by `id`, the API by `version`).
  const restore = useMutation({
    mutationFn: (entry: ProjectVersionEntry) => api.post(`/api/projects/${id}/versions/${entry.version}/restore`),
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
  const currentBuild = builds.find((b) => b.version === project.currentVersion)
  const isBuilding = currentBuild?.state === "building"
  // An extension that failed to install doesn't fail the build — it would
  // otherwise vanish silently, so read the verdict back out of the build log.
  const failedExts = new Set(currentBuild ? parseFailedExtensions(currentBuild.logs) : [])

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
          {/* Plain link: the route sets Content-Disposition, the browser downloads it. */}
          <a
            href={`/api/projects/${id}/export`}
            download
            title="Download this project's spec as JSON (secret values excluded)"
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5")}
          >
            <Download className="h-3.5 w-3.5" /> Export
          </a>
          <SpawnWorkerButton projectId={id} />
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-col gap-4 lg:flex-row lg:gap-5 lg:items-start min-h-0">
        {/* The card is the design system's; where it sits in the page grid is ours. */}
        <aside className="w-full lg:w-72 lg:shrink-0 lg:sticky lg:top-0">
          <ProjectPanel
            project={project}
            stats={{ running: runningCount, total: workers.length }}
            editHref={`/projects/${id}/edit`}
            secretsHref={`/projects/${id}/edit`}
            render={{ link: ({ href, className, children }) => <Link href={href} className={className}>{children}</Link> }}
            secrets={secrets}
            // Lite has exactly one build target — the local Docker daemon — where
            // the dashboard lists one row per BYOC node.
            buildTargets={[{ id: "local", label: "local · Docker", state: currentBuild?.state }]}
            onPrebuild={() => prebuild.mutate()}
            prebuilding={prebuild.isPending || isBuilding}
            versions={versions.map((v) => ({ id: v.id, version: v.version, createdAt: v.createdAt, image: v.config.image }))}
            onRestoreVersion={(entry) => restore.mutate(entry)}
            restoringVersionId={restore.isPending ? restore.variables.id : null}
            deployKeyHelp="Register this as a read-only deploy key on your git host to clone private repos."
            meta={[
              {
                id: "runtime",
                label: "Runtime",
                icon: <Cpu className="h-3 w-3 shrink-0" />,
                value: <span className="font-mono font-medium">Docker · local</span>,
              },
            ]}
          >
            {/* An extension that failed to install doesn't fail the build, so it
                would otherwise vanish silently. `ExtensionChips` has no notion of
                a failed extension, so the verdict is its own band rather than a
                red chip in the list above. */}
            {failedExts.size > 0 && (
              <PanelSection title="Extensions that failed" icon={<TriangleAlert className="h-3 w-3" />}>
                <div className="flex flex-wrap gap-1.5">
                  {[...failedExts].map((ext) => (
                    <span key={ext} title={ext} className="flex items-center gap-1 rounded-md bg-destructive/10 px-2 py-1 font-mono text-[11px] text-destructive">
                      <TriangleAlert className="h-3 w-3 shrink-0" />
                      {ext.split(".").pop()}
                    </span>
                  ))}
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                  Not installed in the v{project.currentVersion} image — code-server resolves ids against{" "}
                  {registry?.homeUrl ? (
                    <a href={registry.homeUrl} target="_blank" rel="noreferrer" className="underline">
                      {registry.name}
                    </a>
                  ) : (
                    registryName
                  )}
                  , where these ids aren&apos;t published.
                </p>
              </PanelSection>
            )}
          </ProjectPanel>
        </aside>

        {/* Right: workers */}
        <div className="flex-1 min-w-0 space-y-3">
          <WorkersPanel projectId={id} projectVersion={project.currentVersion} />
        </div>
      </div>
    </div>
  )
}
