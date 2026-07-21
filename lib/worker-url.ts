/**
 * Builds the browser URL for a worker's code-server (or a forwarded port),
 * deriving the base host + port from the current location so it works both in
 * dev (app on :3900 → worker-<id>.localhost:3900) and prod (:80 → worker-<id>.localhost).
 */
export function workerBaseUrl(workerId: string, port?: number): string {
  if (typeof window === "undefined") return "#"
  const { protocol, hostname, port: p } = window.location
  const label = port ? `worker-${workerId}-${port}` : `worker-${workerId}`
  const portSuffix = p ? `:${p}` : ""
  return `${protocol}//${label}.${hostname}${portSuffix}`
}
