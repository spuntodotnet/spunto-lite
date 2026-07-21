"use client"

import { use } from "react"
import { useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import type { Project } from "@/lib/types"
import { ProjectForm } from "@/components/project-form"
import { SecretsCard } from "@/components/secrets-card"

export default function EditProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { data: project, isLoading } = useQuery({
    queryKey: ["project", id],
    queryFn: () => api.get<Project>(`/api/projects/${id}`),
  })

  if (isLoading) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (!project) return <p className="p-6 text-sm text-muted-foreground">Project not found.</p>

  return (
    <>
      <ProjectForm initial={project} />
      <div className="max-w-3xl mx-auto px-6 -mt-4 pb-10">
        <SecretsCard
          title="Project secrets"
          description="Injected as env vars into every worker of this project."
          basePath={`/api/projects/${id}/secrets`}
          queryKey={["secrets", id]}
        />
      </div>
    </>
  )
}
