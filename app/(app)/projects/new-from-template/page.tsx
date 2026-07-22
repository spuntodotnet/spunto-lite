"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useQuery } from "@tanstack/react-query"
import { toast } from "@spunto/design-system"
import { Rocket, Loader2 } from "lucide-react"
import { api } from "@/lib/api"
import type { Template, Project } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"

export default function NewFromTemplatePage() {
  const router = useRouter()
  const { data: templates = [] } = useQuery({ queryKey: ["templates"], queryFn: () => api.get<Template[]>("/api/templates") })
  const [pending, setPending] = useState<string | null>(null)

  async function use(t: Template) {
    setPending(t.id)
    try {
      const project = await api.post<Project>("/api/projects", {
        name: t.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        description: t.description,
        image: t.image,
        features: t.features ?? [],
        postCreateCommand: t.postCreateCommand,
        postStartCommand: t.postStartCommand,
        forwardPorts: t.forwardPorts,
      })
      toast.success(`Created ${project.name}`)
      router.push(`/projects/${project.id}`)
    } catch (e) {
      toast.error((e as Error).message)
      setPending(null)
    }
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      <div className="mb-6">
        <h1 className="font-[family-name:var(--font-syne)] text-2xl font-bold tracking-tight">Start from a template</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Instant-start stacks — the project boots and runs its dev server on its own.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {templates.map((t) => (
          <div key={t.id} className="rounded-xl border border-border bg-card p-4 flex flex-col">
            <div className="flex items-center justify-between">
              <div className="font-medium">{t.name}</div>
              <Badge variant="muted">{t.stack}</Badge>
            </div>
            <p className="text-sm text-muted-foreground mt-1 flex-1">{t.description}</p>
            <div className="flex items-center justify-between mt-3">
              <code className="text-[10px] font-mono text-muted-foreground truncate max-w-[60%]">
                {t.forwardPorts.length > 0 ? `:${t.forwardPorts.join(", :")}` : t.image.split("/").pop()}
              </code>
              <Button size="sm" disabled={pending === t.id} onClick={() => use(t)}>
                {pending === t.id ? <Loader2 className="animate-spin" /> : <Rocket />} Use
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
