"use client"

import { useMemo, useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import type { TerminalSession } from "@spunto/build/terminal"
import { api } from "@/lib/api"

export type { TerminalSession }

/**
 * Lists / creates / kills the persistent terminal sessions of a worker. There is always at least
 * one tab ("main") — connecting to it creates it, since the attach script is `dtach -A`.
 */
export function useTerminalSessions(workerId: string, enabled: boolean) {
  const qc = useQueryClient()
  const [active, setActive] = useState("main")
  const key = ["terminal-sessions", workerId]

  const { data: serverTabs = [] } = useQuery({
    queryKey: key,
    queryFn: () => api.get<TerminalSession[]>(`/api/workers/${workerId}/sessions`),
    enabled,
    refetchInterval: enabled ? 5000 : false,
  })

  const tabs = useMemo<TerminalSession[]>(() => {
    if (serverTabs.length > 0) return serverTabs
    // Nothing listed yet: the session the terminal below is about to create, drawn ahead of the
    // first poll so the strip doesn't flash empty. `createdAt: 0` rather than `Date.now()` —
    // reading a clock during render is impure, and nothing shows a placeholder tab's age.
    return [{ name: "main", windows: 1, attached: true, createdAt: 0, command: "", title: "" }]
  }, [serverTabs])

  const create = useMutation({
    mutationFn: () => api.post<{ name: string }>(`/api/workers/${workerId}/sessions`),
    onSuccess: (res) => {
      setActive(res.name)
      qc.invalidateQueries({ queryKey: key })
    },
  })

  const kill = useMutation({
    mutationFn: (name: string) => api.del(`/api/workers/${workerId}/sessions/${name}`),
    onSuccess: (_r, name) => {
      if (active === name) {
        const next = tabs.find((t) => t.name !== name)
        setActive(next?.name ?? "main")
      }
      qc.invalidateQueries({ queryKey: key })
    },
  })

  return {
    tabs,
    active,
    setActive,
    createSession: () => create.mutate(),
    killSession: (name: string) => kill.mutate(name),
    busy: create.isPending || kill.isPending,
  }
}
