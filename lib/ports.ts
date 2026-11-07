// What a project's ports *are*, beyond their number — devcontainer `portsAttributes`, keyed by port:
// a `label` the cockpits show instead of the bare `:5173`, and our `path`, where a click on it lands
// (`/admin`, `/docs`). Ported from Spunto Cloud (`lib/ports.ts`, aae05edf / c429724d).
//
// In a Lite worker every port that listens is reachable through the reverse proxy whether it is
// declared or not, so a declaration forwards nothing: it *names*. And a declared port is shown even
// while nothing listens on it — greyed, without a link — so a reader sees what the app will serve,
// and that it does not right now (the task's Machine panel, `MachinePorts` of the design system).
//
// Pure, no Node and no React: the API validates with it, the form cleans with it, the cockpit
// builds its links with it.

import { z } from "zod"

export type PortAttributes = { label?: string; path?: string }
export type PortsAttributes = Record<string, PortAttributes>

export const PORT_LABEL_MAX = 40
export const PORT_PATH_MAX = 200

/**
 * The API's check: keys are port numbers, a label is short, a path is absolute. Shape only, like
 * the rest of the project payload — which ports are *declared* is `forwardPorts`' business, and
 * the form already drops the attributes of a port it removes (`cleanPortsAttributes`).
 */
export const PortsAttributesSchema = z
  .record(
    z.string().regex(/^\d{1,5}$/, "Port keys are port numbers").refine((k) => Number(k) >= 1 && Number(k) <= 65535, "Port out of range"),
    z.object({
      label: z.string().trim().max(PORT_LABEL_MAX).optional(),
      path: z.string().trim().max(PORT_PATH_MAX).startsWith("/", "A port's path starts with /").or(z.literal("")).optional(),
    }),
  )
  .refine((m) => Object.keys(m).length <= 100, "At most 100 port attributes")

/**
 * What a save carries: only the declared ports, without empty fields — and nothing for a port
 * that has neither label nor path. A path that does not start with `/` is dropped rather than
 * refused: the form greys it while it is being typed, and saving half of it would be a lie.
 */
export function cleanPortsAttributes(ports: number[], value: PortsAttributes | undefined): PortsAttributes {
  const out: PortsAttributes = {}
  for (const port of ports) {
    const a = value?.[String(port)]
    if (!a) continue
    const label = a.label?.trim()
    const path = a.path?.trim()
    const entry: PortAttributes = { ...(label ? { label } : {}), ...(path && path.startsWith("/") ? { path } : {}) }
    if (Object.keys(entry).length) out[String(port)] = entry
  }
  return out
}

/** The path a click on this port opens — `/` unless the project says otherwise. */
export function portPath(attrs: PortsAttributes | undefined, port: number): string {
  const p = attrs?.[String(port)]?.path?.trim()
  return p && p.startsWith("/") ? p : "/"
}

/** `http://worker-x-5173.localhost` + `/admin?x=1` → `http://worker-x-5173.localhost/admin?x=1`. */
export function withPath(url: string, path: string | null | undefined): string {
  if (!path || path === "/") return url
  try {
    const u = new URL(url)
    const target = new URL(path, u.origin)
    u.pathname = target.pathname
    for (const [k, v] of target.searchParams) u.searchParams.set(k, v)
    u.hash = target.hash
    return u.toString()
  } catch {
    return url
  }
}

/**
 * One port of a worker, as `GET /api/workers/:id/machine-ports` serves it — Cloud's `PortView`
 * minus the URL (Lite's worker URLs are derived from the browser's own host, `workerBaseUrl`).
 */
export type PortView = {
  port: number
  /** The project's name for it, or null. */
  label: string | null
  /** Where a click lands: the project's path, `/` by default. */
  path: string
  /** Something listens on it inside the worker right now. Always false for a worker that is not up. */
  listening: boolean
  /** Declared by the project (`forwardPorts`): shown even while nothing listens. */
  declared: boolean
}

/**
 * Declared ports and listening ones, merged and sorted. SSH (22) and the IDE (8080) are left to
 * the design system, which filters both out of every port list it draws.
 */
export function mergePortViews(forwardPorts: number[], attrs: PortsAttributes, listening: number[]): PortView[] {
  const declared = new Set(forwardPorts)
  const live = new Set(listening)
  return [...new Set([...declared, ...live])]
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65536)
    .sort((a, b) => a - b)
    .map((port) => ({
      port,
      label: attrs[String(port)]?.label?.trim() || null,
      path: portPath(attrs, port),
      listening: live.has(port),
      declared: declared.has(port),
    }))
}
