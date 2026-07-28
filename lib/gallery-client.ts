// Client for a VS Code *extension gallery* — the `extensionquery` protocol
// code-server switches to when you hand it an `EXTENSIONS_GALLERY` JSON blob.
//
// It is nothing like Open VSX's REST API (lib/open-vsx.ts): a gallery exposes a
// single `POST <serviceUrl>/extensionquery` endpoint taking a filter/flag
// document. That's why OPEN_VSX_API could never double as a gallery setting —
// the two protocols don't share a single route.
//
// Nothing here is specific to any one gallery: the endpoint, the item URLs and
// the product scope all come from the operator's EXTENSIONS_GALLERY. Only the
// subset needed to fill an ExtensionSuggestion is implemented — search by text,
// and exact lookup of `publisher.name`.

import type { ExtensionGallery } from "./extension-registry"
import { RegistryError, parseExtensionId } from "./extensions"
import type { ExtensionSuggestion } from "./types"

const TIMEOUT_MS = 8000

/** `criteria[].filterType` values understood by the query endpoint. */
const FILTER = { ExtensionName: 7, Target: 8, SearchText: 10, ExcludeWithFlags: 12 } as const
/** `sortBy` / `sortOrder`: most installed first. */
const SORT_BY_INSTALL_COUNT = 4
const SORT_ORDER_DESCENDING = 2
/** IncludeVersions (0x1) | IncludeStatistics (0x100) | IncludeLatestVersionOnly (0x200). */
const FLAGS = 0x1 | 0x100 | 0x200
/** ExcludeWithFlags value that drops unpublished entries from the results. */
const UNPUBLISHED_FLAG = "4096"

type GalleryExtension = {
  extensionName?: string
  displayName?: string
  shortDescription?: string
  publisher?: { publisherName?: string; displayName?: string; isDomainVerified?: boolean }
  statistics?: { statisticName?: string; value?: number }[]
  /** Latest first, since the query asks for the latest version only. */
  versions?: { version?: string }[]
}

type QueryResponse = { results?: { extensions?: GalleryExtension[] }[] }

type Criterion = { filterType: number; value: string }

function toSuggestion(gallery: ExtensionGallery, e: GalleryExtension): ExtensionSuggestion | null {
  const publisher = e.publisher?.publisherName
  if (!publisher || !e.extensionName) return null
  const id = `${publisher}.${e.extensionName}`
  return {
    id,
    label: e.displayName || e.extensionName,
    publisher,
    description: e.shortDescription || undefined,
    downloads: e.statistics?.find((s) => s.statisticName === "install")?.value,
    verified: e.publisher?.isDomainVerified === true,
    version: e.versions?.[0]?.version,
    // No `iconUrl`: a gallery only exposes icons behind an asset type whose
    // identifier is vendor-specific, and this client stays gallery-agnostic. The
    // field is optional and the cards fall back to a placeholder.
    url: gallery.itemUrl ? `${gallery.itemUrl}?itemName=${encodeURIComponent(id)}` : undefined,
  }
}

async function extensionQuery(
  gallery: ExtensionGallery,
  criteria: Criterion[],
  pageSize: number,
): Promise<GalleryExtension[]> {
  const body = {
    filters: [
      {
        criteria: [
          // Galleries that host more than one product's catalog need to be told
          // which one we want, or a search for "pipeline" happily returns
          // extensions for IDEs code-server could never load. Operator-supplied
          // and optional: a single-product gallery doesn't need it.
          ...(gallery.productTarget ? [{ filterType: FILTER.Target, value: gallery.productTarget }] : []),
          { filterType: FILTER.ExcludeWithFlags, value: UNPUBLISHED_FLAG },
          ...criteria,
        ],
        pageNumber: 1,
        pageSize,
        sortBy: SORT_BY_INSTALL_COUNT,
        sortOrder: SORT_ORDER_DESCENDING,
      },
    ],
    assetTypes: [],
    flags: FLAGS,
  }

  let res: Response
  try {
    res = await fetch(`${gallery.serviceUrl}/extensionquery`, {
      method: "POST",
      headers: {
        // The api-version is not optional: without it the gallery answers 400.
        accept: "application/json;api-version=3.0-preview.1",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    throw new RegistryError(`Extension gallery unreachable: ${(e as Error).message}`)
  }
  if (!res.ok) throw new RegistryError(`Extension gallery query failed (${res.status})`)

  const payload = (await res.json().catch(() => null)) as QueryResponse | null
  if (!payload) throw new RegistryError("Extension gallery returned a malformed response")
  return payload.results?.[0]?.extensions ?? []
}

/** Full-text search, most installed first. Throws `RegistryError` if the gallery is down. */
export async function searchExtensions(
  gallery: ExtensionGallery,
  query: string,
  size = 20,
): Promise<ExtensionSuggestion[]> {
  const extensions = await extensionQuery(
    gallery,
    [{ filterType: FILTER.SearchText, value: query }],
    Math.min(Math.max(size, 1), 50),
  )
  return extensions.map((e) => toSuggestion(gallery, e)).filter((e): e is ExtensionSuggestion => e !== null)
}

/**
 * Exact lookup of `publisher.extension-id`.
 * Returns null when the gallery has no such extension — a real verdict, unlike a
 * `RegistryError`, which means we simply couldn't ask.
 */
export async function lookupExtension(gallery: ExtensionGallery, id: string): Promise<ExtensionSuggestion | null> {
  if (!parseExtensionId(id)) return null
  // ExtensionName matches the *full* `publisher.name`, but the endpoint is happy
  // to answer with near-misses, so the id still has to be checked on the way out.
  const extensions = await extensionQuery(gallery, [{ filterType: FILTER.ExtensionName, value: id }], 1)
  for (const e of extensions) {
    const suggestion = toSuggestion(gallery, e)
    if (suggestion && suggestion.id.toLowerCase() === id.toLowerCase()) return suggestion
  }
  return null
}
