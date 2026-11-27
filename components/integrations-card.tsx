"use client"

import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "@spunto/design-system"
import { StackMark } from "@spunto/design-system/devcontainer"
import { ExternalLink, GitMerge, Loader2, Trash2, Waypoints } from "lucide-react"
import { api } from "@/lib/api"
import { definitionOf, normalizeOrigin, type IntegrationKind } from "@/lib/integrations"
import type { IntegrationConnectionView, IntegrationOffer } from "@/services/integrations"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export const INTEGRATIONS_QUERY_KEY = ["integrations"]

type IntegrationsData = { offers: IntegrationOffer[]; connections: IntegrationConnectionView[] }

/** The forge's glyph: the design system has GitHub's mark, not GitLab's. */
export function ForgeMark({ kind }: { kind: IntegrationKind }) {
  return kind === "github" ? <StackMark name="github" className="size-4" /> : <GitMerge className="size-4" />
}

/**
 * **Integrations** (docs/integrations.md): a forge account per instance, by token, so a task's pull
 * requests say where they stand — open or merged, checks, review. Clone and push stay on the SSH
 * key; the token never reaches a worker.
 */
export function IntegrationsCard() {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: INTEGRATIONS_QUERY_KEY, queryFn: () => api.get<IntegrationsData>("/api/integrations") })
  const invalidate = () => qc.invalidateQueries({ queryKey: INTEGRATIONS_QUERY_KEY })
  const [adding, setAdding] = useState<IntegrationKind | null>(null)
  const offers = data?.offers ?? []
  const connections = data?.connections ?? []

  return (
    <Card data-testid="integrations-card">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Waypoints className="size-4" /> Integrations
        </CardTitle>
        <CardDescription>
          Connect a forge with a token: the project form lists your repositories, and the pull requests a task talks about
          say where they stand — open or merged, their checks, their review. Clone and push still go through your SSH key; the token stays here, never in a worker.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {connections.length > 0 && (
          <div className="divide-y divide-border rounded-md border border-border">
            {connections.map((c) => (
              <ConnectionRow key={c.id} connection={c} onChanged={invalidate} />
            ))}
          </div>
        )}
        {adding ? (
          <ConnectForm
            offer={offers.find((o) => o.kind === adding)!}
            onDone={() => {
              setAdding(null)
              invalidate()
            }}
            onCancel={() => setAdding(null)}
          />
        ) : (
          <div className="flex flex-wrap gap-2">
            {offers.map((o) => (
              <Button key={o.kind} size="sm" variant="outline" onClick={() => setAdding(o.kind)}>
                <ForgeMark kind={o.kind} /> Connect {o.label}
              </Button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function ConnectionRow({ connection: c, onChanged }: { connection: IntegrationConnectionView; onChanged: () => void }) {
  const remove = useMutation({
    mutationFn: () => api.del(`/api/integrations/${c.id}`),
    onSuccess: onChanged,
    onError: (e) => toast.error((e as Error).message),
  })
  const def = definitionOf(c.kind)
  return (
    <div className="flex items-center gap-3 px-3 py-2.5" data-testid={`integration-${new URL(c.origin).host}`}>
      <span className="text-muted-foreground">
        <ForgeMark kind={c.kind} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm">
          {def.label}
          <span className="truncate font-mono text-xs text-muted-foreground">{new URL(c.origin).host}</span>
        </p>
        <p className="text-xs text-muted-foreground">
          {c.source === "env" ? (
            <>
              From <code className="font-mono">{c.envVar}</code> in Lite&apos;s environment — remove it there.
            </>
          ) : (
            <>Connected as {c.account ? <strong className="font-medium text-foreground">{c.account}</strong> : "an unknown account"}.</>
          )}
        </p>
      </div>
      {c.source === "env" ? (
        <Badge variant="outline">env</Badge>
      ) : (
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label={`Disconnect ${def.label} at ${new URL(c.origin).host}`}
          disabled={remove.isPending}
          onClick={() => remove.mutate()}
        >
          <Trash2 className="size-3.5" />
        </Button>
      )}
    </div>
  )
}

function ConnectForm({ offer, onDone, onCancel }: { offer: IntegrationOffer; onDone: () => void; onCancel: () => void }) {
  const [host, setHost] = useState("")
  const [token, setToken] = useState("")
  const origin = normalizeOrigin(host || offer.defaultHost)
  const tokenUrl = origin ? definitionOf(offer.kind).newTokenUrl?.(origin) : null
  const connect = useMutation({
    mutationFn: () =>
      api.post<IntegrationConnectionView>("/api/integrations", { kind: offer.kind, ...(host.trim() ? { host } : {}), token }),
    onSuccess: (c) => {
      toast.success(`${offer.label} connected as ${c.account}`)
      onDone()
    },
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        connect.mutate()
      }}
      className="space-y-3 rounded-md border border-border p-3"
      data-testid={`connect-${offer.kind}`}
    >
      <p className="flex items-center gap-2 text-sm font-medium">
        <ForgeMark kind={offer.kind} /> Connect {offer.label}
      </p>
      <div className="grid gap-2 sm:grid-cols-[14rem_1fr]">
        <Input
          className="h-8 font-mono text-xs"
          placeholder={offer.defaultHost}
          value={host}
          onChange={(e) => setHost(e.target.value)}
          aria-label="Host"
        />
        <Input
          className="h-8 font-mono text-xs"
          type="password"
          placeholder="token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          aria-label="Token"
          autoComplete="off"
          required
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Leave the host empty for {offer.defaultHost}; give yours for a self-hosted instance
        {offer.kind === "github" ? " (GitHub Enterprise)" : ""}. The token needs{" "}
        <span className="text-foreground">{offer.tokenScopes}</span>.{" "}
        {tokenUrl && (
          <a href={tokenUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline">
            Create one <ExternalLink className="size-3" />
          </a>
        )}
      </p>
      {connect.isError && <p className="text-xs text-destructive">{(connect.error as Error).message}</p>}
      <div className="flex gap-2">
        <Button size="sm" type="submit" disabled={connect.isPending || !token.trim() || !origin}>
          {connect.isPending && <Loader2 className="size-3.5 animate-spin" />}
          Connect
        </Button>
        <Button size="sm" variant="ghost" type="button" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
