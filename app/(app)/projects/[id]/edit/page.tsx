"use client"

import { use } from "react"
import { useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import type { Project } from "@/lib/types"
import { ProjectForm } from "@/components/project-form"

export default function EditProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { data: project, isLoading } = useQuery({
    queryKey: ["project", id],
    queryFn: () => api.get<Project>(`/api/projects/${id}`),
  })

  if (isLoading) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (!project) return <p className="p-6 text-sm text-muted-foreground">Project not found.</p>
  return <ProjectForm initial={project} />
}
