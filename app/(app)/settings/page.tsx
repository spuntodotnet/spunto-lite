"use client"

import { useEffect, useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { KeyRound, User, FileCode2 } from "lucide-react"
import { api } from "@/lib/api"
import type { Settings, HostKey } from "@/lib/types"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"

export default function SettingsPage() {
  const qc = useQueryClient()
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: () => api.get<Settings>("/api/settings") })
  const { data: keys = [] } = useQuery({ queryKey: ["ssh-keys"], queryFn: () => api.get<HostKey[]>("/api/settings/ssh-keys") })

  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [keyPath, setKeyPath] = useState("")
  const [dotfilesRepo, setDotfilesRepo] = useState("")

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
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] })
      toast.success("Settings saved")
    },
    onError: (e) => toast.error((e as Error).message),
  })

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="font-[family-name:var(--font-syne)] text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">Git identity and SSH key injected into every worker.</p>
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

      <div className="flex justify-end">
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save settings"}
        </Button>
      </div>
    </div>
  )
}
