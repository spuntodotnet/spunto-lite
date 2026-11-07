"use client"

import { useQuery } from "@tanstack/react-query"
import type { TaskMachinePort } from "@spunto/design-system/tasks"
import { api } from "@/lib/api"
import { withPath, type PortView } from "@/lib/ports"
import { workerBaseUrl } from "@/lib/worker-url"

/** The query key of a worker's labelled ports — invalidated by Park and Wake (task-machine-controls). */
export const machinePortsKey = (workerId: string | null | undefined) => ["worker-machine-ports", workerId]

/**
 * A worker's ports as `TaskMachine` takes them (Cloud c429724d): the project's declared ones with
 * their label — green while something listens, greyed while nothing does, parked included — and
 * whatever else listens. Plus the link each one opens, its landing path appended.
 *
 * Read while the machine is up *or* parked (`enabled`): the declared ports are worth showing on a
 * stopped container, and the route answers them without asking the worker then.
 */
export function useMachinePorts(workerId: string | null | undefined, { enabled, running }: { enabled: boolean; running: boolean }) {
  const { data } = useQuery({
    queryKey: machinePortsKey(workerId),
    queryFn: () => api.get<{ ports: PortView[] }>(`/api/workers/${workerId}/machine-ports`),
    enabled: !!workerId && enabled,
    refetchInterval: running ? 10_000 : 30_000,
  })
  const views = enabled ? (data?.ports ?? []) : []
  const ports: TaskMachinePort[] = views.map((p) => ({
    port: p.port,
    label: p.label,
    listening: running && p.listening,
    declared: p.declared,
  }))
  const portHref = workerId
    ? (port: number) => withPath(workerBaseUrl(workerId, port), views.find((p) => p.port === port)?.path)
    : undefined
  return { ports, portHref }
}
