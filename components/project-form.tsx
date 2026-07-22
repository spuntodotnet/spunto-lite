"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useQuery } from "@tanstack/react-query"
import { toast } from "@spunto/design-system"
import { Plus, Trash2, X } from "lucide-react"
import { api } from "@/lib/api"
import type { Project, Repository, DevImage, DevFeature, ExtensionSuggestion } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"

type RepoDraft = Repository
type FeatureDraft = { id: string; version?: string }
type SecretDraft = { name: string; value: string }

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  )
}

export function ProjectForm({ initial }: { initial?: Project }) {
  const router = useRouter()
  const editing = !!initial

  const { data: images = [] } = useQuery({ queryKey: ["images"], queryFn: () => api.get<DevImage[]>("/api/images") })
  const { data: features = [] } = useQuery({
    queryKey: ["features"],
    queryFn: () => api.get<DevFeature[]>("/api/features"),
  })
  const { data: extensions = [] } = useQuery({
    queryKey: ["extensions"],
    queryFn: () => api.get<ExtensionSuggestion[]>("/api/extensions"),
  })

  const [name, setName] = useState(initial?.name ?? "")
  const [description, setDescription] = useState(initial?.description ?? "")
  const [image, setImage] = useState(initial?.image ?? "mcr.microsoft.com/devcontainers/javascript-node:20")
  const [repos, setRepos] = useState<RepoDraft[]>(initial?.repositories ?? [])
  const [selectedFeatures, setSelectedFeatures] = useState<FeatureDraft[]>(
    initial?.features.map((f) => ({ id: f.id, version: f.options?.version })) ?? [],
  )
  const [exts, setExts] = useState<string[]>(initial?.vscodeExtensions ?? [])
  const [extInput, setExtInput] = useState("")
  const [postCreate, setPostCreate] = useState(initial?.postCreateCommand ?? "")
  const [postStart, setPostStart] = useState(initial?.postStartCommand ?? "")
  const [forwardPorts, setForwardPorts] = useState((initial?.forwardPorts ?? []).join(", "))
  const [prewarm, setPrewarm] = useState((initial?.prewarmImages ?? []).join(", "))
  const [dind, setDind] = useState(initial?.dind ?? false)
  const [secrets, setSecrets] = useState<SecretDraft[]>([])
  const [saving, setSaving] = useState(false)

  const featureOf = (id: string) => features.find((f) => f.id === id)

  function toggleFeature(id: string) {
    setSelectedFeatures((prev) =>
      prev.some((f) => f.id === id) ? prev.filter((f) => f.id !== id) : [...prev, { id }],
    )
  }
  function setFeatureVersion(id: string, version: string) {
    setSelectedFeatures((prev) => prev.map((f) => (f.id === id ? { ...f, version } : f)))
  }

  function addRepo() {
    setRepos((r) => [...r, { id: crypto.randomUUID(), provider: "git", project: "", workspacePath: "", cloneUrl: "" }])
  }
  function updateRepo(id: string, patch: Partial<RepoDraft>) {
    setRepos((r) => r.map((x) => (x.id === id ? { ...x, ...patch } : x)))
  }
  function removeRepo(id: string) {
    setRepos((r) => r.filter((x) => x.id !== id))
  }

  function addExt() {
    const v = extInput.trim()
    if (v && !exts.includes(v)) setExts((e) => [...e, v])
    setExtInput("")
  }

  function buildPayload() {
    return {
      name: name.trim(),
      description: description.trim() || undefined,
      image: image.trim(),
      features: selectedFeatures.map((f) => ({
        id: f.id,
        options: f.version ? { version: f.version } : undefined,
      })),
      vscodeExtensions: exts,
      prewarmImages: prewarm.split(",").map((s) => s.trim()).filter(Boolean),
      dind,
      postCreateCommand: postCreate.trim() || undefined,
      postStartCommand: postStart.trim() || undefined,
      repositories: repos
        .filter((r) => (r.provider === "git" ? r.cloneUrl?.trim() : r.project.trim()))
        .map((r) => ({
          id: r.id,
          provider: r.provider,
          project: r.provider === "git" ? r.project || deriveLabel(r.cloneUrl || "") : r.project.trim(),
          workspacePath: r.workspacePath.trim() || deriveLabel(r.project || r.cloneUrl || "app"),
          cloneUrl: r.provider === "git" ? r.cloneUrl?.trim() : undefined,
        })),
      forwardPorts: forwardPorts
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n > 0 && n < 65536),
      secrets: secrets.filter((s) => s.name && s.value),
    }
  }

  async function submit() {
    if (!name.trim()) return toast.error("Name is required")
    if (!image.trim()) return toast.error("Base image is required")
    setSaving(true)
    try {
      const payload = buildPayload()
      const saved = editing
        ? await api.patch<Project>(`/api/projects/${initial!.id}`, payload)
        : await api.post<Project>("/api/projects", payload)
      toast.success(editing ? "Project updated" : "Project created")
      router.push(`/projects/${saved.id}`)
      router.refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="font-[family-name:var(--font-syne)] text-2xl font-bold tracking-tight">
          {editing ? `Edit ${initial!.name}` : "New project"}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Define a devcontainer-style spec. Workers spawn from it as isolated Docker containers.
        </p>
      </div>

      <Section title="Identity">
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="my-app" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="desc">Description</Label>
          <Input
            id="desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What is this environment for?"
          />
        </div>
      </Section>

      <Section title="Base image" description="A devcontainer/OCI image. Pick one or type your own.">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {images.map((img) => (
            <button
              key={img.id}
              type="button"
              onClick={() => setImage(img.image)}
              className={`text-left rounded-lg border p-3 transition-colors ${
                image === img.image ? "border-primary bg-primary/5" : "border-border hover:bg-accent"
              }`}
            >
              <div className="text-sm font-medium">{img.label}</div>
              <div className="text-xs text-muted-foreground">{img.description}</div>
            </button>
          ))}
        </div>
        <div className="space-y-2">
          <Label htmlFor="image">Image ref</Label>
          <Input id="image" className="font-mono text-xs" value={image} onChange={(e) => setImage(e.target.value)} />
        </div>
      </Section>

      <Section title="Repositories" description="Cloned into /workspace at spawn.">
        <div className="space-y-3">
          {repos.map((r) => (
            <div key={r.id} className="rounded-lg border border-border p-3 space-y-2">
              <div className="flex items-center gap-2">
                <select
                  value={r.provider}
                  onChange={(e) => updateRepo(r.id, { provider: e.target.value as Repository["provider"] })}
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                >
                  <option value="git">Git URL</option>
                  <option value="github">GitHub</option>
                  <option value="gitlab">GitLab</option>
                  <option value="bitbucket">Bitbucket</option>
                </select>
                <span className="text-xs text-muted-foreground">→ /workspace/</span>
                <Input
                  className="h-8 flex-1"
                  placeholder="workspace path (e.g. app)"
                  value={r.workspacePath}
                  onChange={(e) => updateRepo(r.id, { workspacePath: e.target.value })}
                />
                <Button variant="ghost" size="icon" className="size-8" onClick={() => removeRepo(r.id)}>
                  <Trash2 className="size-4" />
                </Button>
              </div>
              {r.provider === "git" ? (
                <Input
                  className="h-8 font-mono text-xs"
                  placeholder="git@gitlab.com:group/repo.git"
                  value={r.cloneUrl ?? ""}
                  onChange={(e) => updateRepo(r.id, { cloneUrl: e.target.value })}
                />
              ) : (
                <Input
                  className="h-8 font-mono text-xs"
                  placeholder="owner/repo"
                  value={r.project}
                  onChange={(e) => updateRepo(r.id, { project: e.target.value })}
                />
              )}
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={addRepo}>
            <Plus /> Add repository
          </Button>
          {repos.some((r) => r.provider === "git") && (
            <p className="text-xs text-muted-foreground">
              Generic git repos are cloned with a per-project deploy key (shown on the project page after saving).
            </p>
          )}
        </div>
      </Section>

      <Section title="Features" description="devcontainer features installed into the image.">
        <div className="space-y-2">
          {features.map((f) => {
            const selected = selectedFeatures.find((s) => s.id === f.id)
            return (
              <div key={f.id} className="rounded-lg border border-border p-3">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-1 accent-[var(--primary)]"
                    checked={!!selected}
                    onChange={() => toggleFeature(f.id)}
                  />
                  <div className="flex-1">
                    <div className="text-sm font-medium">{f.label}</div>
                    <div className="text-xs text-muted-foreground">{f.description}</div>
                    {selected && f.options?.some((o) => o.name === "version") && (
                      <Input
                        className="h-7 mt-2 w-40 text-xs"
                        placeholder={f.options.find((o) => o.name === "version")?.default}
                        value={selected.version ?? ""}
                        onChange={(e) => setFeatureVersion(f.id, e.target.value)}
                      />
                    )}
                  </div>
                </label>
              </div>
            )
          })}
        </div>
      </Section>

      <Section title="VS Code extensions" description="Pre-installed into code-server.">
        <div className="flex flex-wrap gap-2">
          {extensions.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => setExts((cur) => (cur.includes(e.id) ? cur.filter((x) => x !== e.id) : [...cur, e.id]))}
              className={`rounded-md border px-2 py-1 text-xs transition-colors ${
                exts.includes(e.id) ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-accent"
              }`}
            >
              {e.label}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <Input
            className="h-8 font-mono text-xs"
            placeholder="publisher.extension-id"
            value={extInput}
            onChange={(e) => setExtInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addExt())}
          />
          <Button variant="outline" size="sm" onClick={addExt}>
            Add
          </Button>
        </div>
        {exts.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {exts.map((id) => (
              <Badge key={id} variant="secondary" className="font-mono">
                {id}
                <button onClick={() => setExts((c) => c.filter((x) => x !== id))} className="ml-1">
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}
      </Section>

      <Section title="Lifecycle" description="Run inside the container, in the repo dir.">
        <div className="space-y-2">
          <Label htmlFor="pc">postCreateCommand (once, first boot)</Label>
          <Textarea id="pc" value={postCreate} onChange={(e) => setPostCreate(e.target.value)} placeholder="npm install" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="ps">postStartCommand (every boot)</Label>
          <Textarea id="ps" value={postStart} onChange={(e) => setPostStart(e.target.value)} placeholder="npm run dev" />
        </div>
      </Section>

      <Section title="Ports & runtime">
        <div className="space-y-2">
          <Label htmlFor="ports">Forward ports (comma-separated)</Label>
          <Input id="ports" value={forwardPorts} onChange={(e) => setForwardPorts(e.target.value)} placeholder="3000, 8080" />
        </div>
        <div className="flex items-center justify-between rounded-lg border border-border p-3">
          <div>
            <div className="text-sm font-medium">Docker-in-Docker</div>
            <div className="text-xs text-muted-foreground">Run privileged with a dockerd inside the worker.</div>
          </div>
          <Switch checked={dind} onCheckedChange={setDind} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="prewarm">Prewarm images (comma-separated)</Label>
          <Input
            id="prewarm"
            className="font-mono text-xs"
            value={prewarm}
            onChange={(e) => setPrewarm(e.target.value)}
            placeholder="traefik:v3, node:24"
          />
        </div>
      </Section>

      {!editing && (
      <Section
        title="Secrets"
        description="Injected as env vars into every worker. Write-only — values are never shown again."
      >
        <div className="space-y-2">
          {secrets.map((s, i) => (
            <div key={i} className="flex gap-2">
              <Input
                className="h-8 font-mono text-xs"
                placeholder="UPPER_SNAKE_CASE"
                value={s.name}
                onChange={(e) => setSecrets((cur) => cur.map((x, j) => (j === i ? { ...x, name: e.target.value.toUpperCase() } : x)))}
              />
              <Input
                className="h-8 font-mono text-xs"
                type="password"
                placeholder="value"
                value={s.value}
                onChange={(e) => setSecrets((cur) => cur.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
              />
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                onClick={() => setSecrets((cur) => cur.filter((_, j) => j !== i))}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={() => setSecrets((cur) => [...cur, { name: "", value: "" }])}>
            <Plus /> Add secret
          </Button>
        </div>
      </Section>
      )}

      <div className="flex items-center justify-end gap-2 pb-10">
        <Button variant="ghost" onClick={() => router.back()}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={saving}>
          {saving ? "Saving…" : editing ? "Save changes" : "Create project"}
        </Button>
      </div>
    </div>
  )
}

function deriveLabel(urlOrPath: string): string {
  const cleaned = urlOrPath.replace(/\.git$/, "")
  const parts = cleaned.split(/[/:]/).filter(Boolean)
  return parts[parts.length - 1] || "repo"
}
