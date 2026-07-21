"use client"

import Link from "next/link"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { Plus, Star, Box, GitBranch, Container, Rocket } from "lucide-react"
import { api } from "@/lib/api"
import type { Project } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"

export default function ProjectsPage() {
  const qc = useQueryClient()
  const { data: projects = [], isLoading } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.get<Project[]>("/api/projects"),
  })

  const favorite = useMutation({
    mutationFn: ({ id, favorite }: { id: string; favorite: boolean }) =>
      api.post(`/api/projects/${id}/favorite`, { favorite }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  })

  return (
    <div className="max-w-5xl mx-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="font-[family-name:var(--font-syne)] text-2xl font-bold tracking-tight">Projects</h1>
          <p className="text-sm text-muted-foreground mt-1">Devcontainer specs you can spawn workers from.</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/projects/new-from-template">
            <Button variant="outline">
              <Rocket /> From template
            </Button>
          </Link>
          <Link href="/projects/new">
            <Button>
              <Plus /> New project
            </Button>
          </Link>
        </div>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : projects.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-12 text-center">
          <Box className="size-8 mx-auto text-muted-foreground mb-3" />
          <p className="font-medium">No projects yet</p>
          <p className="text-sm text-muted-foreground mt-1 mb-4">Create your first devcontainer spec.</p>
          <Link href="/projects/new">
            <Button>
              <Plus /> New project
            </Button>
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {projects.map((p) => (
            <div key={p.id} className="group rounded-xl border border-border bg-card p-4 hover:border-primary/40 transition-colors">
              <div className="flex items-start justify-between">
                <Link href={`/projects/${p.id}`} className="min-w-0 flex-1">
                  <div className="font-medium truncate">{p.name}</div>
                  <div className="text-xs text-muted-foreground truncate">{p.description || p.image}</div>
                </Link>
                <button
                  onClick={() => favorite.mutate({ id: p.id, favorite: !p.favorite })}
                  className="p-1 text-muted-foreground hover:text-amber-500"
                  aria-label="Favorite"
                >
                  <Star className={p.favorite ? "size-4 fill-amber-400 text-amber-400" : "size-4"} />
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5 mt-3">
                <Badge variant="muted">
                  <Container className="size-3" /> v{p.currentVersion}
                </Badge>
                {p.repositories.length > 0 && (
                  <Badge variant="muted">
                    <GitBranch className="size-3" /> {p.repositories.length} repo{p.repositories.length > 1 ? "s" : ""}
                  </Badge>
                )}
                {p.dind && <Badge variant="warning">DinD</Badge>}
                {p.features.length > 0 && <Badge variant="muted">{p.features.length} features</Badge>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
