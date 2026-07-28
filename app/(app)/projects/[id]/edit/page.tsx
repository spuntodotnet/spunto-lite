"use client"

import { use, useState } from "react"
import { useRouter } from "next/navigation"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Trash2 } from "lucide-react"
import { api } from "@/lib/api"
import type { Project, Worker } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ProjectForm } from "@/components/project-form"
import { SecretsCard } from "@/components/secrets-card"
import { DeleteProjectDialog } from "@/components/delete-project-dialog"

export default function EditProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const qc = useQueryClient()
  const [deleteOpen, setDeleteOpen] = useState(false)

  const { data: project, isLoading } = useQuery({
    queryKey: ["project", id],
    queryFn: () => api.get<Project>(`/api/projects/${id}`),
  })
  // Only used to tell the user how many workspaces the deletion takes with it.
  const { data: workers = [] } = useQuery({
    queryKey: ["workers", id],
    queryFn: () => api.get<Worker[]>(`/api/projects/${id}/workers`),
  })

  if (isLoading) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (!project) return <p className="p-6 text-sm text-muted-foreground">Project not found.</p>

  return (
    <>
      <ProjectForm initial={project} />
      {/* Same width as the form above it, which the design system lays out as
          two columns (sections + build manifest) as soon as it has the room. */}
      <div className="mx-auto -mt-2 max-w-6xl space-y-4 px-6 pb-10">
        <SecretsCard
          title="Project secrets"
          description="Injected as env vars into every worker of this project."
          basePath={`/api/projects/${id}/secrets`}
          queryKey={["secrets", id]}
        />

        <Card className="border-destructive/30">
          <CardHeader>
            <CardTitle className="text-base text-destructive">Danger zone</CardTitle>
            <CardDescription>
              Deleting this project erases its spec, version history and secrets, and destroys every workspace it
              spawned — containers, volumes and built images. This cannot be undone.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
              <Trash2 /> Delete project
            </Button>
          </CardContent>
        </Card>
      </div>

      <DeleteProjectDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        projectId={id}
        projectName={project.name}
        workerCount={workers.length}
        onDeleted={() => {
          // Drop the dead id's cached queries so the redirect doesn't refetch it.
          qc.removeQueries({ queryKey: ["project", id] })
          qc.removeQueries({ queryKey: ["workers", id] })
          router.push("/projects")
        }}
      />
    </>
  )
}
