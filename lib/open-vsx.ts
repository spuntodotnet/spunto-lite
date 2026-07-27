// Open VSX registry client — the *same* registry code-server resolves
// `--install-extension <id>` against (see buildImageScript in lib/setup-script.ts).
//
// Keeping search and install on one registry is the point: an extension the
// picker can find is an extension the build can install. The Microsoft
// Marketplace is deliberately NOT queried — its catalog is larger but code-server
// can't install from it without an explicit EXTENSIONS_GALLERY configuration, so
// searching it would hand back ids that silently fail at build time.

import { OPEN_VSX_API } from "./env"
import { parseExtensionId } from "./extensions"

export type ExtensionSuggestion = {
  /** publisher.extension-id, as passed to `code-server --install-extension`. */
  id: string
  /** Human-readable name, e.g. "Prettier - Code formatter". */
  label: string
  publisher: string
  description?: string
  downloads?: number
  /** Open VSX "verified publisher" flag. */
  verified?: boolean
  /** Latest published version, e.g. "11.0.0". */
  version?: string
  /** The extension's own icon on Open VSX — what `ExtensionCard` draws. */
  iconUrl?: string
  /** Registry page, for a "view on Open VSX" link. */
  url?: string
}

/** Registry call that couldn't be completed (network, timeout, 5xx). */
export class RegistryError extends Error {}

const TIMEOUT_MS = 8000

type OpenVsxExtension = {
  name?: string
  namespace?: string
  displayName?: string
  description?: string
  downloadCount?: number
  verified?: boolean
  deprecated?: boolean
  version?: string
  /** `/-/search` flattens the icon here; `/{namespace}/{name}` nests it under `files`. */
  files?: { icon?: string | null } | null
}

function toSuggestion(e: OpenVsxExtension): ExtensionSuggestion | null {
  if (!e.namespace || !e.name) return null
  return {
    id: `${e.namespace}.${e.name}`,
    label: e.displayName || e.name,
    publisher: e.namespace,
    description: e.description || undefined,
    downloads: e.downloadCount,
    verified: e.verified,
    version: e.version,
    // Passed through rather than dropped: the picker's cards draw the real icon,
    // and it's already in the payload the registry answered with.
    iconUrl: e.files?.icon ?? undefined,
    url: `https://open-vsx.org/extension/${e.namespace}/${e.name}`,
  }
}

async function registryFetch(path: string): Promise<Response> {
  try {
    return await fetch(`${OPEN_VSX_API}${path}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    throw new RegistryError(`Open VSX unreachable: ${(e as Error).message}`)
  }
}

/** Full-text search, most downloaded first. Throws `RegistryError` if the registry is down. */
export async function searchExtensions(query: string, size = 20): Promise<ExtensionSuggestion[]> {
  const params = new URLSearchParams({
    query,
    size: String(Math.min(Math.max(size, 1), 50)),
    sortBy: "downloadCount",
    sortOrder: "desc",
    includeAllVersions: "false",
  })
  const res = await registryFetch(`/-/search?${params}`)
  if (!res.ok) throw new RegistryError(`Open VSX search failed (${res.status})`)
  const body = (await res.json()) as { extensions?: OpenVsxExtension[] }
  return (body.extensions ?? [])
    .filter((e) => !e.deprecated)
    .map(toSuggestion)
    .filter((e): e is ExtensionSuggestion => e !== null)
}

/**
 * Exact lookup of `publisher.extension-id`.
 * Returns null when the registry answers "no such extension" — that's a real
 * verdict, unlike a `RegistryError`, which means we simply couldn't ask.
 */
export async function lookupExtension(id: string): Promise<ExtensionSuggestion | null> {
  const parts = parseExtensionId(id)
  if (!parts) return null
  const res = await registryFetch(`/${encodeURIComponent(parts.namespace)}/${encodeURIComponent(parts.name)}`)
  if (res.status === 404) return null
  if (!res.ok) throw new RegistryError(`Open VSX lookup failed (${res.status})`)
  const body = (await res.json()) as OpenVsxExtension & { error?: string }
  // Open VSX answers 200 with an `error` payload for unknown namespaces.
  if (body.error || !body.namespace || !body.name) return null
  return toSuggestion(body)
}
