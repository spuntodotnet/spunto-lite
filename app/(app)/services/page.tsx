"use client"

import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "@spunto/design-system"
import { Plus, RefreshCw, Server } from "lucide-react"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import type { Service } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { ServiceCard } from "@/components/service-card"
import {
  EMPTY_SERVICE_FORM,
  ServiceForm,
  fromService,
  toServicePayload,
  type ServiceFormValue,
} from "@/components/service-form"

// The local counterpart of Spunto's "Ship" pillar: long-lived dependencies declared
// once and shared by *every* dev environment. One page, because a service is a small
// object — spec, state, logs — and there's nothing a detail route would add.

type Editing = { mode: "create" } | { mode: "edit"; id: string } | null

export default function ServicesPage() {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<Editing>(null)
  const [form, setForm] = useState<ServiceFormValue>(EMPTY_SERVICE_FORM)

  const { data: servicesList = [], isLoading, isFetching } = useQuery({
    queryKey: ["services"],
    queryFn: () => api.get<Service[]>("/api/services"),
    refetchInterval: 4000,
  })

  const close = () => {
    setEditing(null)
    setForm(EMPTY_SERVICE_FORM)
  }
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["services"] })
    qc.invalidateQueries({ queryKey: ["resources"] })
    qc.invalidateQueries({ queryKey: ["search-index"] })
  }

  const save = useMutation({
    mutationFn: () => {
      const payload = toServicePayload(form)
      return editing?.mode === "edit"
        ? api.patch<Service>(`/api/services/${editing.id}`, payload)
        : api.post<Service>("/api/services", payload)
    },
    onSuccess: () => {
      toast.success(editing?.mode === "edit" ? "Service updated" : `Service ${form.slug} created`)
      close()
      invalidate()
    },
    onError: (e) => toast.error((e as Error).message),
  })

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Services</h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Long-lived dependencies — Postgres, Elasticsearch, MinIO — running once on your Docker and shared by{" "}
            <strong className="font-medium text-foreground">every worker of every project</strong>. Each one is reachable
            by DNS at its slug, and its address is injected into every worker as{" "}
            <span className="font-mono text-xs">SPUNTO_SVC_&lt;SLUG&gt;</span>.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div
            className={cn(
              "flex items-center gap-1.5 text-xs text-muted-foreground transition-opacity",
              isFetching ? "opacity-100" : "opacity-0",
            )}
          >
            <RefreshCw className="size-3.5 animate-spin" />
          </div>
          {!editing && (
            <Button
              size="sm"
              className="h-8 text-xs gap-1.5"
              onClick={() => {
                setForm(EMPTY_SERVICE_FORM)
                setEditing({ mode: "create" })
              }}
            >
              <Plus className="size-3.5" /> New service
            </Button>
          )}
        </div>
      </div>

      {editing && (
        <ServiceForm
          mode={editing.mode}
          value={form}
          onChange={setForm}
          onSubmit={() => save.mutate()}
          onCancel={close}
          submitting={save.isPending}
        />
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : servicesList.length === 0 ? (
        !editing && (
          <div className="rounded-xl border border-dashed border-border py-12 text-center">
            <Server className="size-6 mx-auto text-muted-foreground mb-2" />
            <p className="text-sm text-muted-foreground">No shared service yet.</p>
            <p className="text-xs text-muted-foreground/70 mt-1 max-w-sm mx-auto">
              Declare one here instead of booting it in each project — a single Elasticsearch for all your workers.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-4 h-8 text-xs gap-1.5"
              onClick={() => {
                setForm(EMPTY_SERVICE_FORM)
                setEditing({ mode: "create" })
              }}
            >
              <Plus className="size-3.5" /> New service
            </Button>
          </div>
        )
      ) : (
        <div className="space-y-3">
          {servicesList.map((s) => (
            <ServiceCard
              key={s.id}
              service={s}
              onEdit={() => {
                setForm(fromService(s))
                setEditing({ mode: "edit", id: s.id })
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}
