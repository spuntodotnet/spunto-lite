"use client"

import { useState } from "react"
import Link from "next/link"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "@spunto/design-system"
import { AlertTriangle, CheckCircle2, Lock, LockOpen } from "lucide-react"
import { api } from "@/lib/api"
import type { SshAgentStatus } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export const SSH_AGENT_QUERY_KEY = ["ssh-agent"]

export function useSshAgentStatus() {
  return useQuery({
    queryKey: SSH_AGENT_QUERY_KEY,
    queryFn: () => api.get<SshAgentStatus>("/api/settings/ssh-agent"),
    // A host agent can gain or lose the key behind our back (`ssh-add` on the host).
    refetchInterval: 30_000,
  })
}

const README_AGENT = "https://github.com/spuntodotnet/spunto-lite#ssh-keys-with-a-passphrase"

/**
 * How a passphrase-protected key reaches the workers: through the host's agent, or unlocked here
 * once (the passphrase goes to Spunto Lite's ssh-agent and is dropped — never stored). Renders
 * nothing for a key without passphrase, which is injected as before.
 */
export function SshKeyUnlock() {
  const qc = useQueryClient()
  const { data: status } = useSshAgentStatus()
  const [passphrase, setPassphrase] = useState("")

  const onStatus = (s: SshAgentStatus) => qc.setQueryData(SSH_AGENT_QUERY_KEY, s)
  const unlock = useMutation({
    mutationFn: () => api.post<SshAgentStatus>("/api/settings/ssh-agent", { passphrase }),
    onSuccess: (s) => {
      onStatus(s)
      setPassphrase("")
      toast.success("SSH key unlocked")
    },
    onError: (e) => {
      setPassphrase("")
      toast.error((e as Error).message)
    },
  })
  const lock = useMutation({
    mutationFn: () => api.del("/api/settings/ssh-agent").then(() => qc.invalidateQueries({ queryKey: SSH_AGENT_QUERY_KEY })),
    onSuccess: () => toast.success("SSH key locked"),
    onError: (e) => toast.error((e as Error).message),
  })

  if (!status?.key?.encrypted) return null
  const name = <code className="font-mono text-xs">{status.key.name}</code>

  if (!status.workerSocket) {
    return (
      <Notice tone="error">
        {name} is protected by a passphrase, but no SSH agent socket is shared with workers, so they can&apos;t use it.
        Mount the <code className="font-mono text-xs">spunto-lite-ssh-agent</code> volume (the compose file does) —{" "}
        <a href={README_AGENT} target="_blank" rel="noreferrer" className="underline">
          see the README
        </a>
        .
      </Notice>
    )
  }

  if (status.unlocked) {
    return (
      <Notice tone="ok" action={
        <Button variant="ghost" size="sm" onClick={() => lock.mutate()} disabled={lock.isPending}>
          <Lock className="size-4" /> Lock
        </Button>
      }>
        {name} is unlocked: workers sign with it through Spunto Lite&apos;s SSH agent until Spunto Lite restarts. The
        passphrase was not stored.
      </Notice>
    )
  }

  if (status.hostAgent.hasKey) {
    return (
      <Notice tone="ok">
        Your host&apos;s SSH agent holds {name}: workers sign with it, no passphrase needed here.
      </Notice>
    )
  }

  return (
    <div className="space-y-2">
      <Notice tone="warning">
        {name} is protected by a passphrase and no SSH agent holds it: <strong>git over SSH will fail in workers</strong>{" "}
        (clone, pull, push). Unlock it once below — the passphrase is used to load the key into Spunto Lite&apos;s SSH
        agent, never written to disk nor logged — or{" "}
        <a href={README_AGENT} target="_blank" rel="noreferrer" className="underline">
          forward your host&apos;s agent
        </a>
        {status.hostAgent.reachable ? ` (yours is mounted but doesn't hold this key — run ssh-add on the host)` : ""}.
      </Notice>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (passphrase) unlock.mutate()
        }}
      >
        <Input
          type="password"
          aria-label="SSH key passphrase"
          placeholder="Passphrase"
          autoComplete="off"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
        />
        <Button type="submit" disabled={!passphrase || unlock.isPending}>
          <LockOpen className="size-4" /> {unlock.isPending ? "Unlocking…" : "Unlock"}
        </Button>
      </form>
    </div>
  )
}

function Notice({ tone, children, action }: { tone: "ok" | "warning" | "error"; children: React.ReactNode; action?: React.ReactNode }) {
  const styles = {
    ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    warning: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    error: "border-destructive/30 bg-destructive/10 text-destructive",
  }[tone]
  const Icon = tone === "ok" ? CheckCircle2 : AlertTriangle
  return (
    <div role={tone === "ok" ? "status" : "alert"} className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${styles}`}>
      <Icon className="size-4 mt-0.5 shrink-0" />
      <div className="flex-1">{children}</div>
      {action}
    </div>
  )
}

/** App-wide reminder, under the header: the selected key is encrypted and nothing can use it. */
export function SshKeyLockedBanner() {
  const { data: status } = useSshAgentStatus()
  if (!status?.key?.encrypted || status.usable) return null
  return (
    <div role="alert" className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-700 dark:text-amber-400">
      <AlertTriangle className="size-4 shrink-0" />
      <span>
        Your SSH key <code className="font-mono text-xs">{status.key.name}</code> is protected by a passphrase and locked —
        git over SSH will fail in workers.
      </span>
      <Link href="/settings" className="ml-auto font-medium underline shrink-0">
        Unlock it in Settings
      </Link>
    </div>
  )
}
