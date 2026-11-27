/**
 * Where a relayed request is served: this Lite's own listener, at the path that passed the list and
 * nowhere else. The query is the only thing added, and it may not move the request — no fragment,
 * no path of its own. Null when the result would not be exactly `<base><path>?<query>`.
 */
export function localRequestUrl(base: string, path: string, query: string): string | null {
  const q = query.startsWith("?") ? query.slice(1) : query
  if (q.includes("#") || q.startsWith("/")) return null
  let url: URL
  try {
    url = new URL(path, base)
  } catch {
    return null
  }
  if (url.origin !== new URL(base).origin || url.pathname !== path) return null
  url.search = q
  return url.toString()
}
