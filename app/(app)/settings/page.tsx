"use client"

import { useEffect, useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { KeyRound, User, FileCode2, Trash2, CheckCircle2 } from "lucide-react"
import { api } from "@/lib/api"
import type { Settings, HostKey } from "@/lib/types"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"

// Google "G" mark (inline so we don't pull in an icon dependency).
function GoogleLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden focusable="false">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  )
}

export default function SettingsPage() {
  const qc = useQueryClient()
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: () => api.get<Settings>("/api/settings") })
  const { data: keys = [] } = useQuery({ queryKey: ["ssh-keys"], queryFn: () => api.get<HostKey[]>("/api/settings/ssh-keys") })

  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [keyPath, setKeyPath] = useState("")
  const [dotfilesRepo, setDotfilesRepo] = useState("")
  const [gcpKey, setGcpKey] = useState("")

  useEffect(() => {
    if (settings) {
      setName(settings.gitUserName ?? "")
      setEmail(settings.gitUserEmail ?? "")
      setKeyPath(settings.sshKeyPath ?? "")
      setDotfilesRepo(settings.dotfilesRepo ?? "")
    }
  }, [settings])

  const save = useMutation({
    mutationFn: () =>
      api.patch("/api/settings", {
        gitUserName: name || null,
        gitUserEmail: email || null,
        sshKeyPath: keyPath || null,
        dotfilesRepo: dotfilesRepo.trim() || null,
        // Write-only: only send the key when the user typed a new one, so saving
        // other settings never clears an existing credential.
        ...(gcpKey.trim() ? { gcpRegistryKey: gcpKey.trim() } : {}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] })
      setGcpKey("")
      toast.success("Settings saved")
    },
    onError: (e) => toast.error((e as Error).message),
  })

  const removeGcpKey = useMutation({
    mutationFn: () => api.patch("/api/settings", { gcpRegistryKey: null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] })
      setGcpKey("")
      toast.success("Registry credential removed")
    },
    onError: (e) => toast.error((e as Error).message),
  })

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="font-[family-name:var(--font-syne)] text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Git identity and SSH key injected into every worker, plus private registry access for base images.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <User className="size-4" /> Git identity
          </CardTitle>
          <CardDescription>Used for `git config user.name/email` inside workers.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="gn">Name</Label>
            <Input id="gn" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ge">Email</Label>
            <Input id="ge" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ada@example.com" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <KeyRound className="size-4" /> SSH key
          </CardTitle>
          <CardDescription>
            Discovered from your mounted <code className="font-mono text-xs">~/.ssh</code>. The selected private key is
            injected so `git push` works as you.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {keys.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No keys found. Mount your host <code className="font-mono text-xs">~/.ssh</code> (the compose file does this
              by default).
            </p>
          ) : (
            <div className="space-y-1.5">
              {keys.map((k) => (
                <label
                  key={k.name}
                  className="flex items-center gap-3 rounded-md border border-border px-3 py-2 cursor-pointer hover:bg-accent"
                >
                  <input
                    type="radio"
                    name="sshkey"
                    className="accent-[var(--primary)]"
                    checked={keyPath === k.name}
                    onChange={() => setKeyPath(k.name)}
                  />
                  <span className="font-mono text-sm">{k.name}</span>
                  {!k.hasPublic && <span className="text-xs text-muted-foreground">(no .pub)</span>}
                </label>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <FileCode2 className="size-4" /> Dotfiles
          </CardTitle>
          <CardDescription>
            A personal dotfiles repo (GitHub Codespaces-style). Cloned into{" "}
            <code className="font-mono text-xs">~/dotfiles</code> on each worker&apos;s first boot; its install script (
            <code className="font-mono text-xs">install.sh</code>, <code className="font-mono text-xs">bootstrap.sh</code>,{" "}
            <code className="font-mono text-xs">setup.sh</code> or <code className="font-mono text-xs">script/setup</code>)
            is run, else every dotfile is symlinked into <code className="font-mono text-xs">$HOME</code>. Private repos use
            your SSH key.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label htmlFor="df">Repository</Label>
          <Input
            id="df"
            value={dotfilesRepo}
            onChange={(e) => setDotfilesRepo(e.target.value)}
            placeholder="owner/dotfiles or git@github.com:owner/dotfiles.git"
          />
          <p className="text-xs text-muted-foreground">Leave empty to disable.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <GoogleLogo className="size-4" /> Container registry
          </CardTitle>
          <CardDescription>
            To use a <strong>private</strong> base image from Google Artifact Registry / GCR (e.g.{" "}
            <code className="font-mono text-xs">europe-west1-docker.pkg.dev/…</code>), paste a service-account key with the{" "}
            <code className="font-mono text-xs">roles/artifactregistry.reader</code> role. Stored encrypted; used only to
            pull images, never injected into workers.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {settings?.gcpRegistryConfigured && (
            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
              <Badge variant="secondary" className="gap-1.5">
                <CheckCircle2 className="size-3.5" /> Key configured
              </Badge>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => removeGcpKey.mutate()}
                disabled={removeGcpKey.isPending}
              >
                <Trash2 className="size-4" /> Remove
              </Button>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="gcp">{settings?.gcpRegistryConfigured ? "Replace key" : "Service-account key"}</Label>
            <Textarea
              id="gcp"
              value={gcpKey}
              onChange={(e) => setGcpKey(e.target.value)}
              placeholder={'{\n  "type": "service_account",\n  ...\n}\n\n— or its base64 encoding (base64 -w0 sa-key.json)'}
              className="font-mono text-xs min-h-28"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              Accepts the raw JSON key file or its base64 encoding. Leave empty to keep the current one.
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save settings"}
        </Button>
      </div>
    </div>
  )
}
