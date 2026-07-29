"use client"

import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@spunto/design-system"
import { KeyRound, Plus, Trash2, Type } from "lucide-react"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import { SERVICE_PRESETS, type ServicePreset } from "@/lib/service-catalog"
import type { SecretMeta, Service, ServiceRestartPolicy } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

// The one form behind "New service" and "Edit": a single container declared by
// hand (image + command + env + ports + volumes + restart policy). No
// docker-compose import — a multi-container stack (Elasticsearch + Kibana) is two
// services on the same shared network, which is exactly what the two presets show.

/** Every numeric field is held as a string so the input can legitimately be empty. */
type EnvRow = { name: string; value: string; secretName: string; useSecret: boolean }
type PortRow = { container: string; host: string }
type VolumeRow = { name: string; mountPath: string }

export type ServiceFormValue = {
  slug: string
  description: string
  image: string
  command: string
  env: EnvRow[]
  ports: PortRow[]
  volumes: VolumeRow[]
  httpPort: string
  restartPolicy: ServiceRestartPolicy
}

export const EMPTY_SERVICE_FORM: ServiceFormValue = {
  slug: "",
  description: "",
  image: "",
  command: "",
  env: [],
  ports: [],
  volumes: [],
  httpPort: "",
  restartPolicy: "unless-stopped",
}

export function fromService(s: Service): ServiceFormValue {
  return {
    slug: s.slug,
    description: s.description ?? "",
    image: s.image,
    command: s.command ?? "",
    env: s.env.map((e) => ({
      name: e.name,
      value: e.value ?? "",
      secretName: e.secretName ?? "",
      useSecret: e.secretName !== undefined,
    })),
    ports: s.ports.map((p) => ({ container: String(p.container), host: p.host != null ? String(p.host) : "" })),
    volumes: s.volumes.map((v) => ({ ...v })),
    httpPort: s.httpPort != null ? String(s.httpPort) : "",
    restartPolicy: s.restartPolicy,
  }
}

export function fromPreset(p: ServicePreset): ServiceFormValue {
  return {
    ...EMPTY_SERVICE_FORM,
    slug: p.slug,
    description: p.description,
    image: p.image,
    command: p.command ?? "",
    env: (p.env ?? []).map((e) => ({
      name: e.name,
      value: e.value ?? "",
      secretName: e.secretName ?? "",
      useSecret: e.secretName !== undefined,
    })),
    ports: (p.ports ?? []).map((port) => ({ container: String(port.container), host: "" })),
    volumes: (p.volumes ?? []).map((v) => ({ ...v })),
    httpPort: p.httpPort != null ? String(p.httpPort) : "",
  }
}

const num = (s: string): number | null => {
  const n = Number(s.trim())
  return s.trim() !== "" && Number.isInteger(n) && n > 0 ? n : null
}

/** Form value → API payload. Blank rows are dropped rather than rejected. */
export function toServicePayload(v: ServiceFormValue) {
  return {
    slug: v.slug.trim(),
    description: v.description.trim() || undefined,
    image: v.image.trim(),
    command: v.command.trim() || null,
    env: v.env
      .filter((e) => e.name.trim() && (e.useSecret ? e.secretName : true))
      .map((e) =>
        e.useSecret
          ? { name: e.name.trim(), secretName: e.secretName }
          : { name: e.name.trim(), value: e.value },
      ),
    ports: v.ports
      .map((p) => ({ container: num(p.container), host: num(p.host) }))
      .filter((p): p is { container: number; host: number | null } => p.container !== null),
    volumes: v.volumes.filter((vol) => vol.name.trim() && vol.mountPath.trim()),
    httpPort: num(v.httpPort),
    restartPolicy: v.restartPolicy,
  }
}

/** Client-side guard, mirroring lib/validation.ts so the error lands before the round-trip. */
export function validateServiceForm(v: ServiceFormValue): string | null {
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(v.slug.trim()))
    return "Slug must be a DNS label: lowercase letters, digits and inner hyphens"
  if (!v.image.trim()) return "An image is required"
  for (const e of v.env) {
    if (!e.name.trim()) continue
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(e.name.trim())) return `Invalid environment variable name: ${e.name}`
    if (e.useSecret && !e.secretName) return `Pick a secret for ${e.name}, or switch it to a literal value`
  }
  for (const vol of v.volumes) {
    if (!vol.name.trim() && !vol.mountPath.trim()) continue
    if (!/^[a-z0-9][a-z0-9_.-]*$/.test(vol.name.trim())) return `Invalid volume name: ${vol.name}`
    if (!vol.mountPath.trim().startsWith("/")) return `Mount path must be absolute: ${vol.mountPath}`
  }
  const declared = v.ports.map((p) => num(p.container)).filter((p): p is number => p !== null)
  const http = num(v.httpPort)
  if (http !== null && !declared.includes(http))
    return `HTTP port ${http} must also be listed in Ports (that's the port the proxy talks to)`
  return null
}

const RESTART_LABELS: Record<ServiceRestartPolicy, string> = {
  "unless-stopped": "Unless stopped — comes back with Docker",
  always: "Always — even after you stop it",
  "on-failure": "On failure — only if it crashes",
  no: "Never",
}

// ─── Repeatable-row helpers ──────────────────────────────────────────────────

function RowSection({
  label,
  hint,
  onAdd,
  addLabel,
  children,
}: {
  label: string
  hint?: string
  onAdd: () => void
  addLabel: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <Label className="text-xs">{label}</Label>
        {hint && <span className="text-[11px] text-muted-foreground text-right">{hint}</span>}
      </div>
      {children}
      <Button type="button" variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={onAdd}>
        <Plus className="size-3" /> {addLabel}
      </Button>
    </div>
  )
}

function RemoveRow({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0" onClick={onClick} aria-label={label}>
      <Trash2 className="size-3.5" />
    </Button>
  )
}

// ─── Form ────────────────────────────────────────────────────────────────────

export function ServiceForm({
  value,
  onChange,
  onSubmit,
  onCancel,
  submitting,
  mode,
}: {
  value: ServiceFormValue
  onChange: (v: ServiceFormValue) => void
  onSubmit: () => void
  onCancel: () => void
  submitting: boolean
  mode: "create" | "edit"
}) {
  const [error, setError] = useState<string | null>(null)
  const { data: secrets = [] } = useQuery({
    queryKey: ["global-secrets"],
    queryFn: () => api.get<SecretMeta[]>("/api/secrets"),
  })
  const set = (patch: Partial<ServiceFormValue>) => onChange({ ...value, ...patch })

  function submit() {
    const problem = validateServiceForm(value)
    setError(problem)
    if (!problem) onSubmit()
  }

  return (
    <div className="rounded-xl border border-border bg-card p-5 space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-sm">{mode === "create" ? "New shared service" : `Edit ${value.slug}`}</h2>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            One container, shared by every worker of every project. Workers reach it at{" "}
            <span className="font-mono">{value.slug || "<slug>"}</span> on the shared network.
          </p>
        </div>
      </div>

      {mode === "create" && (
        <div className="space-y-2">
          <Label className="text-xs">Start from a preset</Label>
          <div className="flex flex-wrap gap-1.5">
            {SERVICE_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                title={p.description}
                onClick={() => {
                  setError(null)
                  onChange(fromPreset(p))
                }}
                className="rounded-full border border-border bg-muted/30 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-foreground"
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="svc-slug" className="text-xs">
            Slug
          </Label>
          <Input
            id="svc-slug"
            className="h-8 font-mono text-xs"
            placeholder="elasticsearch"
            value={value.slug}
            onChange={(e) => set({ slug: e.target.value.toLowerCase() })}
          />
          <p className="text-[11px] text-muted-foreground">Its DNS name, and its <span className="font-mono">svc-…</span> subdomain.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="svc-image" className="text-xs">
            Image
          </Label>
          <Input
            id="svc-image"
            className="h-8 font-mono text-xs"
            placeholder="docker.elastic.co/elasticsearch/elasticsearch:8.13.4"
            value={value.image}
            onChange={(e) => set({ image: e.target.value })}
          />
          <p className="text-[11px] text-muted-foreground">Pulled on first start. Pin a tag.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="svc-desc" className="text-xs">
            Description <span className="text-muted-foreground/60">(optional)</span>
          </Label>
          <Input
            id="svc-desc"
            className="h-8 text-xs"
            placeholder="Search index shared by all projects"
            value={value.description}
            onChange={(e) => set({ description: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="svc-cmd" className="text-xs">
            Command <span className="text-muted-foreground/60">(optional)</span>
          </Label>
          <Input
            id="svc-cmd"
            className="h-8 font-mono text-xs"
            placeholder="server /data --console-address :9001"
            value={value.command}
            onChange={(e) => set({ command: e.target.value })}
          />
          <p className="text-[11px] text-muted-foreground">Overrides the image&apos;s CMD. Not run through a shell.</p>
        </div>
      </div>

      {/* Env */}
      <RowSection
        label="Environment variables"
        hint="A literal value is stored in clear — reference a global secret instead when it matters."
        addLabel="Add variable"
        onAdd={() => set({ env: [...value.env, { name: "", value: "", secretName: "", useSecret: false }] })}
      >
        {value.env.length > 0 && (
          <div className="space-y-1.5">
            {value.env.map((row, i) => {
              const update = (patch: Partial<EnvRow>) =>
                set({ env: value.env.map((r, j) => (i === j ? { ...r, ...patch } : r)) })
              return (
                <div key={i} className="flex items-center gap-1.5">
                  <Input
                    className="h-8 font-mono text-xs flex-1"
                    placeholder="POSTGRES_PASSWORD"
                    value={row.name}
                    onChange={(e) => update({ name: e.target.value })}
                  />
                  {row.useSecret ? (
                    <div className="flex-1">
                      <Select
                        value={row.secretName}
                        onValueChange={(v: string | null) => update({ secretName: v ?? "" })}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue placeholder={secrets.length ? "Pick a global secret…" : "No global secrets yet"} />
                        </SelectTrigger>
                        <SelectContent>
                          {secrets.map((s) => (
                            <SelectItem key={s.id} value={s.name} className="font-mono text-xs">
                              {s.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : (
                    <Input
                      className="h-8 font-mono text-xs flex-1"
                      placeholder="value"
                      value={row.value}
                      onChange={(e) => update({ value: e.target.value })}
                    />
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={cn("size-8 shrink-0", row.useSecret && "text-primary")}
                    title={row.useSecret ? "Using a global secret — switch to a literal value" : "Use a global secret instead"}
                    aria-label={row.useSecret ? `Use a literal value for ${row.name || "this variable"}` : `Use a global secret for ${row.name || "this variable"}`}
                    onClick={() => update({ useSecret: !row.useSecret })}
                  >
                    {row.useSecret ? <KeyRound className="size-3.5" /> : <Type className="size-3.5" />}
                  </Button>
                  <RemoveRow
                    label={`Remove ${row.name || "variable"}`}
                    onClick={() => set({ env: value.env.filter((_, j) => j !== i) })}
                  />
                </div>
              )
            })}
          </div>
        )}
      </RowSection>

      {/* Ports */}
      <RowSection
        label="Ports"
        hint="Workers reach any container port by DNS. Fill “on host” only to also publish it on your machine."
        addLabel="Add port"
        onAdd={() => set({ ports: [...value.ports, { container: "", host: "" }] })}
      >
        {value.ports.length > 0 && (
          <div className="space-y-1.5">
            {value.ports.map((row, i) => {
              const update = (patch: Partial<PortRow>) =>
                set({ ports: value.ports.map((r, j) => (i === j ? { ...r, ...patch } : r)) })
              return (
                <div key={i} className="flex items-center gap-1.5">
                  <Input
                    className="h-8 font-mono text-xs flex-1"
                    placeholder="in container — 9200"
                    inputMode="numeric"
                    value={row.container}
                    onChange={(e) => update({ container: e.target.value })}
                  />
                  <Input
                    className="h-8 font-mono text-xs flex-1"
                    placeholder="on host — optional"
                    inputMode="numeric"
                    value={row.host}
                    onChange={(e) => update({ host: e.target.value })}
                  />
                  <RemoveRow
                    label={`Remove port ${row.container || i + 1}`}
                    onClick={() => set({ ports: value.ports.filter((_, j) => j !== i) })}
                  />
                </div>
              )
            })}
          </div>
        )}
      </RowSection>

      {/* Volumes */}
      <RowSection
        label="Persistent volumes"
        hint="Named volumes survive edits and restarts — they're only deleted with the service."
        addLabel="Add volume"
        onAdd={() => set({ volumes: [...value.volumes, { name: "", mountPath: "" }] })}
      >
        {value.volumes.length > 0 && (
          <div className="space-y-1.5">
            {value.volumes.map((row, i) => {
              const update = (patch: Partial<VolumeRow>) =>
                set({ volumes: value.volumes.map((r, j) => (i === j ? { ...r, ...patch } : r)) })
              return (
                <div key={i} className="flex items-center gap-1.5">
                  <Input
                    className="h-8 font-mono text-xs w-32"
                    placeholder="data"
                    value={row.name}
                    onChange={(e) => update({ name: e.target.value.toLowerCase() })}
                  />
                  <Input
                    className="h-8 font-mono text-xs flex-1"
                    placeholder="/usr/share/elasticsearch/data"
                    value={row.mountPath}
                    onChange={(e) => update({ mountPath: e.target.value })}
                  />
                  <RemoveRow
                    label={`Remove volume ${row.name || i + 1}`}
                    onClick={() => set({ volumes: value.volumes.filter((_, j) => j !== i) })}
                  />
                </div>
              )
            })}
          </div>
        )}
      </RowSection>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="svc-http" className="text-xs">
            HTTP port <span className="text-muted-foreground/60">(optional)</span>
          </Label>
          <Input
            id="svc-http"
            className="h-8 font-mono text-xs"
            placeholder="9200"
            inputMode="numeric"
            value={value.httpPort}
            onChange={(e) => set({ httpPort: e.target.value })}
          />
          <p className="text-[11px] text-muted-foreground">
            Makes it browsable at <span className="font-mono">svc-{value.slug || "<slug>"}</span> and turns{" "}
            <span className="font-mono">SPUNTO_SVC_*</span> into an <span className="font-mono">http://</span> URL.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Restart policy</Label>
          <Select
            value={value.restartPolicy}
            onValueChange={(v: string | null) => v && set({ restartPolicy: v as ServiceRestartPolicy })}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(RESTART_LABELS) as ServiceRestartPolicy[]).map((p) => (
                <SelectItem key={p} value={p} className="text-xs">
                  {RESTART_LABELS[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {error && (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2 pt-1">
        <Button size="sm" className="h-8 text-xs" onClick={submit} disabled={submitting}>
          {mode === "create" ? "Create & start" : "Save changes"}
        </Button>
        <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        {mode === "edit" && (
          <span className="text-[11px] text-muted-foreground">
            A running service is recreated to apply this — its volumes are kept.
          </span>
        )}
      </div>
    </div>
  )
}
