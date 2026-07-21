"use client"

import { useMemo, useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"

export type TmuxSession = { name: string; windows: number; attached: boolean; command: string }

/**
 * Lists / creates / kills tmux sessions inside a worker. There is always at least
 * one tab ("main") — connecting to it auto-creates it via `tmux new-session -A`.
 */
export function useTmuxSessions(workerId: string, enabled: boolean) {
  const qc = useQueryClient()
  const [active, setActive] = useState("main")
  const key = ["tmux", workerId]

  const { data: serverTabs = [] } = useQuery({
    queryKey: key,
    queryFn: () => api.get<TmuxSession[]>(`/api/workers/${workerId}/tmux`),
    enabled,
    refetchInterval: enabled ? 5000 : false,
  })

  const tabs = useMemo<TmuxSession[]>(() => {
    if (serverTabs.length > 0) return serverTabs
    return [{ name: "main", windows: 1, attached: true, command: "" }]
  }, [serverTabs])

  const create = useMutation({
    mutationFn: () => api.post<{ name: string }>(`/api/workers/${workerId}/tmux`),
    onSuccess: (res) => {
      setActive(res.name)
      qc.invalidateQueries({ queryKey: key })
    },
  })

  const kill = useMutation({
    mutationFn: (name: string) => api.del(`/api/workers/${workerId}/tmux/${name}`),
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
