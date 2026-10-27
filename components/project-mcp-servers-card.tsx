"use client"

import Link from "next/link"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "@spunto/design-system"
import { Plug, RotateCcw } from "lucide-react"
import { api, apiFetch } from "@/lib/api"
import type { McpReason, SerializedMcpServer } from "@/services/mcp-servers"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"

type ProjectMcpServer = {
  server: SerializedMcpServer
  enabled: boolean
  reason: McpReason
  modeDefault: boolean
  setting: boolean | null
}

/**
 * Which MCP servers this project's tasks get (docs/serveurs-mcp.md) — Cloud's
 * `project-mcp-servers-section.tsx`.
 *
 * Saved on each switch, outside the project's versions: applied at the next session of a task.
 * Switching back to what the server's mode says removes the project's exception rather than
 * recording a copy of the default, which would stop following the server.
 */
export function ProjectMcpServersCard({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const base = `/api/projects/${projectId}/mcp-servers`
  const queryKey = ["project-mcp-servers", projectId]
  const { data, isLoading } = useQuery({ queryKey, queryFn: () => api.get<ProjectMcpServer[]>(base) })
  const onSuccess = () => qc.invalidateQueries({ queryKey })
  const onError = (e: unknown) => toast.error((e as Error).message)
  const set = useMutation({
    mutationFn: (body: { serverId: string; enabled: boolean }) => apiFetch<void>(base, { method: "PUT", body: JSON.stringify(body) }),
    onSuccess,
    onError,
  })
  const clear = useMutation({ mutationFn: (serverId: string) => api.del(`${base}/${serverId}`), onSuccess, onError })
  const busy = set.isPending || clear.isPending

  return (
    <Card data-testid="project-mcp-servers">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Plug className="size-4" /> MCP servers
        </CardTitle>
        <CardDescription>
          The tools this project&apos;s tasks get, through Lite&apos;s gateway. Saved immediately, outside the
          project&apos;s versions; applied at the next session of a task (a reply counts).
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !data?.length ? (
          <p className="text-sm text-muted-foreground">
            No MCP server yet.{" "}
            <Link href="/settings" className="underline underline-offset-2">
              Add one in Settings
            </Link>{" "}
            to give tasks tools like Notion or Linear.
          </p>
        ) : (
          <div className="divide-y divide-border rounded-md border border-border">
            {data.map(({ server, enabled, reason, modeDefault, setting }) => {
              const notConnected = server.auth === "oauth" && server.connection?.status !== "ok"
              return (
                <div key={server.id} className="flex items-start gap-3 px-3 py-2" data-testid={`project-mcp-${server.name}`}>
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-sm">{server.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{server.url}</p>
                    {enabled && notConnected && (
                      <p className="text-xs text-muted-foreground">
                        Not connected: tasks won&apos;t get it until it is (
                        <Link href="/settings" className="underline underline-offset-2">
                          Connect
                        </Link>
                        ).
                      </p>
                    )}
                  </div>
                  <span className="shrink-0 pt-0.5 text-[11px] text-muted-foreground">
                    {reason === "project"
                      ? `this project (server: ${modeDefault ? "on" : "off"})`
                      : modeDefault
                        ? "on by default"
                        : "optional"}
                  </span>
                  {setting !== null && (
                    <button
                      type="button"
                      aria-label={`Reset ${server.name} to the server's mode`}
                      title="Back to the server's mode"
                      className="pt-0.5 text-muted-foreground hover:text-foreground"
                      disabled={busy}
                      onClick={() => clear.mutate(server.id)}
                    >
                      <RotateCcw className="size-3.5" />
                    </button>
                  )}
                  <Switch
                    checked={enabled}
                    disabled={busy}
                    aria-label={`Give ${server.name} to this project's tasks`}
                    onCheckedChange={(on) => (on === modeDefault ? clear.mutate(server.id) : set.mutate({ serverId: server.id, enabled: on }))}
                  />
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
