"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "@spunto/design-system"
import { AlertTriangle, CircleDot, Loader2, Smartphone, Unplug } from "lucide-react"
import { api } from "@/lib/api"
import type { LiteCapability } from "@/lib/lite-relay"
import type { LiteConnectView, LiteDisconnectResult } from "@/services/lite-connect"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export const LITE_CONNECT_QUERY_KEY = ["lite-connect"]

const CAPABILITIES: { id: LiteCapability; label: string; detail: string }[] = [
  { id: "read", label: "Read", detail: "Projects, tasks, their conversations, diffs and attachments." },
  { id: "reply", label: "Reply", detail: "Answer a task, interrupt it, Accept or Drop it." },
  { id: "create", label: "Create tasks", detail: "Delegate a new task to a project." },
]

/**
 * **Connect to Spunto** (docs/lite-connect.md): pairs this Lite with a Spunto account in OAuth, then
 * keeps a tunnel open so the member's devices — the « Spunto Lite » iPhone app — reach its tasks
 * through Spunto, within the capabilities ticked here. Off until Connect is clicked.
 */
export function LiteConnectCard() {
  const qc = useQueryClient()
  const router = useRouter()
  const { data } = useQuery({
    queryKey: LITE_CONNECT_QUERY_KEY,
    queryFn: () => api.get<LiteConnectView>("/api/lite-connect"),
    // The tunnel's state moves on its own (welcome, a cut, a retry): follow it while connected.
    refetchInterval: (q) => (q.state.data?.connected ? 3_000 : false),
  })
  const [spuntoUrl, setSpuntoUrl] = useState<string | null>(null)
  const [machineName, setMachineName] = useState<string | null>(null)
  const set = (view: LiteConnectView) => qc.setQueryData(LITE_CONNECT_QUERY_KEY, view)

  // What the callback came back with (`/api/lite-connect/callback`).
  useEffect(() => {
    const search = new URLSearchParams(window.location.search)
    const connected = search.get("liteConnected")
    const failed = search.get("liteError")
    if (!connected && !failed) return
    if (connected) toast.success("Connected to Spunto. Your devices can reach this Lite.")
    if (failed) toast.error(failed)
    router.replace("/settings#connect-to-spunto", { scroll: false })
  }, [router])

  // The card draws once its data is in, after the browser looked for `#connect-to-spunto`: back
  // from the consent page, bring it into view ourselves.
  const loaded = !!data
  useEffect(() => {
    if (loaded && window.location.hash === "#connect-to-spunto") document.getElementById("connect-to-spunto")?.scrollIntoView({ block: "start" })
  }, [loaded])

  const save = useMutation({
    mutationFn: (patch: { spuntoUrl?: string; machineName?: string | null; capabilities?: LiteCapability[] }) =>
      api.patch<LiteConnectView>("/api/lite-connect", patch),
    onSuccess: (view) => {
      set(view)
      setSpuntoUrl(null)
      setMachineName(null)
    },
    onError: (e) => toast.error((e as Error).message),
  })

  const connect = useMutation({
    mutationFn: async () => {
      // What is typed and not saved yet is what the pairing should use.
      if (spuntoUrl !== null || machineName !== null) {
        set(await api.patch<LiteConnectView>("/api/lite-connect", { ...(spuntoUrl !== null ? { spuntoUrl } : {}), ...(machineName !== null ? { machineName } : {}) }))
      }
      return api.post<{ url: string }>("/api/lite-connect/connect")
    },
    onSuccess: ({ url }) => {
      window.location.href = url
    },
    onError: (e) => toast.error((e as Error).message),
  })

  const disconnect = useMutation({
    mutationFn: () => api.post<LiteDisconnectResult>("/api/lite-connect/disconnect"),
    onSuccess: ({ revoked, ...view }) => {
      set(view)
      if (revoked) toast.success("Disconnected from Spunto")
      // The why, and where to finish the job, stay under « Disconnected » (lastError).
      else toast.warning("Disconnected here, but Spunto could not be told: this machine may still be listed in Spunto.")
    },
    onError: (e) => toast.error((e as Error).message),
  })

  if (!data) return null
  const caps = new Set(data.capabilities)
  const toggle = (id: LiteCapability, on: boolean) => {
    const next = CAPABILITIES.map((c) => c.id).filter((c) => (c === id ? on : caps.has(c)))
    save.mutate({ capabilities: next })
  }
  const urlValue = spuntoUrl ?? data.spuntoUrl
  const nameValue = machineName ?? data.machineName ?? ""

  return (
    <Card id="connect-to-spunto" data-testid="lite-connect-card">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Smartphone className="size-4" /> Connect to Spunto
        </CardTitle>
        <CardDescription>
          Reach this Lite&apos;s tasks from your devices signed in to Spunto — the Spunto Lite iPhone app first. Lite opens a
          tunnel to Spunto, which relays only the task routes ticked below and keeps nothing of what passes. Nothing connects
          until you click Connect.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Status view={data} />

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="lc-url">Spunto URL</Label>
            <Input
              id="lc-url"
              className="font-mono text-xs"
              value={urlValue}
              onChange={(e) => setSpuntoUrl(e.target.value)}
              disabled={data.connected}
              placeholder="https://spunto.net"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="lc-name">Machine name</Label>
            <Input
              id="lc-name"
              value={nameValue}
              onChange={(e) => setMachineName(e.target.value)}
              disabled={data.connected}
              placeholder={data.defaultMachineName}
            />
          </div>
        </div>
        {data.connected ? (
          <p className="text-xs text-muted-foreground">Rename this machine in Spunto. Disconnect to point Lite at another Spunto.</p>
        ) : (
          (spuntoUrl !== null || machineName !== null) && (
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="outline"
                disabled={save.isPending}
                onClick={() => save.mutate({ ...(spuntoUrl !== null ? { spuntoUrl } : {}), ...(machineName !== null ? { machineName } : {}) })}
              >
                Save
              </Button>
            </div>
          )
        )}

        <fieldset className="space-y-1.5">
          <legend className="mb-1.5 text-sm font-medium">What your devices may do</legend>
          {CAPABILITIES.map((c) => (
            <label key={c.id} className="flex cursor-pointer items-start gap-3 rounded-md border border-border px-3 py-2 hover:bg-accent">
              <input
                type="checkbox"
                className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]"
                checked={caps.has(c.id)}
                disabled={save.isPending}
                onChange={(e) => toggle(c.id, e.target.checked)}
                data-testid={`lite-capability-${c.id}`}
              />
              <span className="space-y-0.5">
                <span className="block text-sm">{c.label}</span>
                <span className="block text-xs text-muted-foreground">{c.detail}</span>
                {c.id === "create" && (
                  <span className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="mt-px size-3.5 shrink-0" />
                    An agent then starts on this machine, from your phone, with your SSH key and your secrets.
                  </span>
                )}
              </span>
            </label>
          ))}
          <p className="text-xs text-muted-foreground">
            Never relayed, whatever is ticked: secrets, settings, workers, terminals, services. A change applies at once{data.connected ? " (the tunnel reconnects)" : ""}.
          </p>
        </fieldset>

        <div className="flex flex-wrap items-center gap-2">
          {data.connected ? (
            <Button size="sm" variant="outline" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>
              {disconnect.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Unplug className="size-3.5" />} Disconnect
            </Button>
          ) : (
            <Button size="sm" disabled={connect.isPending} onClick={() => connect.mutate()}>
              {connect.isPending && <Loader2 className="size-3.5 animate-spin" />}
              Connect to Spunto
            </Button>
          )}
          {!data.connected && (
            <p className="text-xs text-muted-foreground">You&apos;ll sign in to Spunto and allow this Lite, then come back here.</p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function Status({ view }: { view: LiteConnectView }) {
  if (!view.connected) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-border px-3 py-2 text-sm" data-testid="lite-connect-status">
        <Badge variant="muted">Disconnected</Badge>
        {view.lastError && <span className="text-xs text-destructive">{view.lastError}</span>}
      </div>
    )
  }
  const { state, error } = view.tunnel
  const label = state === "online" ? "Online" : state === "connecting" ? "Connecting…" : state === "retrying" ? "Reconnecting…" : "Offline"
  return (
    <div className="space-y-1 rounded-md border border-border px-3 py-2 text-sm" data-testid="lite-connect-status">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={state === "online" ? "secondary" : "warning"} className="gap-1.5">
          <CircleDot className="size-3" /> {label}
        </Badge>
        <span className="text-xs text-muted-foreground">
          Connected to <span className="font-mono">{new URL(view.spuntoUrl).host}</span> as{" "}
          <strong className="font-medium text-foreground">{view.machineName || view.defaultMachineName}</strong>
          {view.connectionId && <span className="font-mono"> · {view.connectionId}</span>}
        </span>
      </div>
      {state !== "online" && error && <p className="text-xs text-muted-foreground">{error}</p>}
    </div>
  )
}
