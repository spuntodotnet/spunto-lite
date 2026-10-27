"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "@spunto/design-system"
import { Loader2, Plug, Trash2 } from "lucide-react"
import { api } from "@/lib/api"
import type { SerializedMcpServer } from "@/services/mcp-servers"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"

export const MCP_SERVERS_QUERY_KEY = ["mcp-servers"]

/**
 * **MCP servers** (docs/serveurs-mcp.md): declared by URL, connected in OAuth from here, and given
 * to task sessions through Lite's gateway — the worker never holds the vendor's token. Cloud's
 * `org-mcp-servers-card.tsx`, for one user: no roles, one connection per server.
 */
export function McpServersCard() {
  const qc = useQueryClient()
  const router = useRouter()
  const { data: servers } = useQuery({
    queryKey: MCP_SERVERS_QUERY_KEY,
    queryFn: () => api.get<SerializedMcpServer[]>("/api/mcp-servers"),
  })
  const invalidate = () => qc.invalidateQueries({ queryKey: MCP_SERVERS_QUERY_KEY })
  const [adding, setAdding] = useState(false)

  // What the OAuth callback came back with (`/api/mcp/oauth/callback`). Read once from the
  // location rather than `useSearchParams`, which would need a Suspense boundary around the page.
  useEffect(() => {
    const search = new URLSearchParams(window.location.search)
    const connected = search.get("mcpConnected")
    const failed = search.get("mcpError")
    if (!connected && !failed) return
    if (connected) toast.success(`Connected to ${connected}. Tasks started from now on have it.`)
    if (failed) toast.error(failed)
    router.replace("/settings", { scroll: false })
  }, [router])

  return (
    <Card data-testid="mcp-servers-card">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Plug className="size-4" /> MCP servers
        </CardTitle>
        <CardDescription>
          Tools your task sessions can call, under Claude Code as under Codex. Declared once by URL; Lite holds the
          credentials and relays the calls — the worker never sees them. Each project picks its own on its edit page.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {servers?.length === 0 && !adding && (
          <p className="text-sm text-muted-foreground">
            No MCP server yet. Sessions only get the servers of their repository&apos;s{" "}
            <code className="font-mono text-xs">.mcp.json</code> and of your dotfiles.
          </p>
        )}
        {servers && servers.length > 0 && (
          <div className="divide-y divide-border rounded-md border border-border">
            {servers.map((s) => (
              <ServerRow key={s.id} server={s} onChanged={invalidate} />
            ))}
          </div>
        )}
        {adding ? (
          <AddServerForm
            onDone={() => {
              setAdding(false)
              invalidate()
            }}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            Add an MCP server
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

function ServerRow({ server, onChanged }: { server: SerializedMcpServer; onChanged: () => void }) {
  const base = `/api/mcp-servers/${server.id}`
  const onError = (e: unknown) => toast.error((e as Error).message)
  const remove = useMutation({ mutationFn: () => api.del(base), onSuccess: onChanged, onError })
  const update = useMutation({
    mutationFn: (mode: "default" | "optional") => api.patch(base, { mode }),
    onSuccess: onChanged,
    onError,
  })
  const disconnect = useMutation({ mutationFn: () => api.post(`${base}/disconnect`), onSuccess: onChanged, onError })
  const connect = useMutation({
    mutationFn: () => api.post<{ url: string }>(`${base}/connect`),
    onSuccess: (data) => {
      window.location.href = data.url
    },
    onError,
  })
  const conn = server.connection

  return (
    <div className="space-y-1 px-3 py-2.5" data-testid={`mcp-server-${server.name}`}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 font-mono text-sm">
            {server.name}
            <AuthBadge server={server} />
          </p>
          <p className="truncate text-xs text-muted-foreground">{server.url}</p>
          <p className="text-xs text-muted-foreground">
            {server.auth === "oauth"
              ? `OAuth${server.issuer ? ` through ${server.issuer}` : ""}${server.scope ? ` (${server.scope})` : ""}.`
              : server.auth === "header"
                ? `Reached with the ${server.headerName} header given when it was added.`
                : "Open: no credential needed."}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {server.auth === "oauth" && conn && (
            <Button size="sm" variant="ghost" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>
              Disconnect
            </Button>
          )}
          {server.auth === "oauth" && (!conn || conn.status === "needs_reauth") && (
            <Button size="sm" disabled={connect.isPending} onClick={() => connect.mutate()}>
              {connect.isPending && <Loader2 className="size-3.5 animate-spin" />}
              {conn ? "Reconnect" : "Connect"}
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label={`Remove ${server.name}`}
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Switch
          checked={server.mode === "default"}
          disabled={update.isPending}
          onCheckedChange={(on) => update.mutate(on ? "default" : "optional")}
          aria-label={`Give ${server.name} to every project`}
        />
        {server.mode === "default" ? "On in every project, unless a project turns it off" : "Off unless a project turns it on"}
      </label>
    </div>
  )
}

function AuthBadge({ server }: { server: SerializedMcpServer }) {
  if (server.auth !== "oauth") return <Badge variant="outline">{server.auth === "header" ? "header" : "open"}</Badge>
  const conn = server.connection
  if (!conn) return <Badge variant="muted">not connected</Badge>
  if (conn.status === "needs_reauth") return <Badge variant="destructive">needs reconnecting</Badge>
  return <Badge variant="secondary">connected</Badge>
}

function AddServerForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState("")
  const [url, setUrl] = useState("")
  const [optional, setOptional] = useState(false)
  const [credentials, setCredentials] = useState<"auto" | "header" | "client">("auto")
  const [headerName, setHeaderName] = useState("Authorization")
  const [headerValue, setHeaderValue] = useState("")
  const [clientId, setClientId] = useState("")
  const [clientSecret, setClientSecret] = useState("")
  const create = useMutation({
    mutationFn: () =>
      api.post("/api/mcp-servers", {
        name,
        url,
        mode: optional ? "optional" : "default",
        ...(credentials === "header" ? { headerName, headerValue } : {}),
        ...(credentials === "client" ? { clientId, ...(clientSecret ? { clientSecret } : {}) } : {}),
      }),
    onSuccess: () => {
      toast.success(`${name} added`)
      onDone()
    },
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        create.mutate()
      }}
      className="space-y-3 rounded-md border border-border p-3"
      data-testid="add-mcp-server"
    >
      <div className="grid gap-2 sm:grid-cols-[10rem_1fr]">
        <Input
          className="h-8 font-mono text-xs"
          placeholder="notion"
          value={name}
          onChange={(e) => setName(e.target.value.toLowerCase())}
          aria-label="Name"
          required
        />
        <Input
          className="h-8 font-mono text-xs"
          placeholder="https://mcp.notion.com/mcp"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          aria-label="URL"
          required
        />
      </div>
      <div className="space-y-1.5 text-xs text-muted-foreground">
        {(
          [
            ["auto", "Discover how it authenticates (open, or OAuth from the URL alone)"],
            ["header", "It takes a static header instead (an API key)"],
            ["client", "OAuth without dynamic registration: I registered a client myself"],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="flex items-center gap-2">
            <input
              type="radio"
              name="mcp-credentials"
              className="accent-[var(--primary)]"
              checked={credentials === value}
              onChange={() => setCredentials(value)}
            />
            {label}
          </label>
        ))}
      </div>
      {credentials === "header" && (
        <div className="grid gap-2 sm:grid-cols-[10rem_1fr]">
          <Input className="h-8 font-mono text-xs" value={headerName} onChange={(e) => setHeaderName(e.target.value)} aria-label="Header name" />
          <Input
            className="h-8 font-mono text-xs"
            type="password"
            placeholder="Bearer …"
            value={headerValue}
            onChange={(e) => setHeaderValue(e.target.value)}
            aria-label="Header value"
          />
        </div>
      )}
      {credentials === "client" && (
        <div className="space-y-1.5">
          <div className="grid gap-2 sm:grid-cols-2">
            <Input className="h-8 font-mono text-xs" placeholder="client id" value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label="Client id" />
            <Input
              className="h-8 font-mono text-xs"
              type="password"
              placeholder="client secret (optional)"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              aria-label="Client secret"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Its redirect URI must be{" "}
            <code className="font-mono">{typeof window === "undefined" ? "" : window.location.origin}/api/mcp/oauth/callback</code>.
          </p>
        </div>
      )}
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Switch checked={!optional} onCheckedChange={(on) => setOptional(!on)} aria-label="On in every project" />
        {optional ? "Off unless a project turns it on" : "On in every project, unless a project turns it off"}
      </label>
      {create.isError && <p className="text-xs text-destructive">{(create.error as Error).message}</p>}
      <div className="flex gap-2">
        <Button
          size="sm"
          type="submit"
          disabled={
            create.isPending ||
            !name ||
            !url ||
            (credentials === "header" && (!headerName || !headerValue)) ||
            (credentials === "client" && !clientId)
          }
        >
          {create.isPending && <Loader2 className="size-3.5 animate-spin" />}
          Add
        </Button>
        <Button size="sm" variant="ghost" type="button" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
