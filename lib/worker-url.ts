/**
 * Builds the browser URL for a worker's code-server (or a forwarded port),
 * deriving the base host + port from the current location so it works both in
 * dev (app on :3900 → worker-<id>.localhost:3900) and prod (:80 → worker-<id>.localhost).
 *
 * Pass a `folder` (e.g. a repo path like `/workspace/spunto`) to open code-server
 * directly on that directory — the `?folder=` query is forwarded untouched by the
 * worker proxy to code-server.
 */
export function workerBaseUrl(
  workerId: string,
  opts: number | { port?: number; folder?: string } = {},
): string {
  if (typeof window === "undefined") return "#"
  const { port, folder } = typeof opts === "number" ? { port: opts, folder: undefined } : opts
  const { protocol, hostname, port: p } = window.location
  const label = port ? `worker-${workerId}-${port}` : `worker-${workerId}`
  const portSuffix = p ? `:${p}` : ""
  const base = `${protocol}//${label}.${hostname}${portSuffix}`
  return folder ? `${base}/?folder=${encodeURIComponent(folder)}` : base
}
