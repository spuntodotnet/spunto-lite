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
      {/* Everything else — delegated work, MCP servers, secrets — is a page of the
          form. This stays out of it: it is not something you save. Under the form's
          pages, not under its rail: same width and padding as the form, so this
          container measures what the form's does, and the same breakpoint (48rem)
          puts it past the rail (15rem + the 1.5rem gap). */}
      <div className="@container/edit mx-auto -mt-2 max-w-6xl px-6 pb-10">
        <div className="@min-[48rem]/edit:pl-[16.5rem]">
          <Card className="border-destructive/30">
            <CardHeader>
              <CardTitle className="text-base text-destructive">Danger zone</CardTitle>
              <CardDescription>
                Deleting this project erases its spec, version history and secrets, and destroys every workspace it
                spawned — containers, volumes and built images
                {project.sharedVolumes.length > 0 ? ", plus its shared volumes and their data" : ""}. This cannot be
                undone.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
                <Trash2 /> Delete project
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>

      <DeleteProjectDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        projectId={id}
        projectName={project.name}
        workerCount={workers.length}
        sharedVolumes={project.sharedVolumes}
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
