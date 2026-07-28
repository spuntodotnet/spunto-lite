// Single entry point for "which registry do we resolve extension ids against?".
//
// Two protocols are supported and exactly one is active per process:
//   - Open VSX (lib/open-vsx.ts) — the default, and what code-server uses out of
//     the box;
//   - an `extensionquery` gallery (lib/gallery-client.ts), selected by setting
//     EXTENSIONS_GALLERY on the control plane.
//
// The point of routing everything through here is that the picker's search and
// the worker's code-server can't disagree: EXTENSIONS_GALLERY is what we hand to
// code-server (at build time and at spawn time — see lib/setup-script.ts and
// services/workers.ts) *and* what selects the client below. An extension the UI
// can find stays an extension the worker can install.
//
// No gallery is hardcoded, and none is special-cased: whatever the operator puts
// in EXTENSIONS_GALLERY is the whole configuration.

import { EXTENSIONS_GALLERY_RAW } from "./env"
import * as galleryClient from "./gallery-client"
import { RegistryError } from "./extensions"
import * as openVsx from "./open-vsx"
import type { ExtensionRegistryInfo, ExtensionSuggestion } from "./types"

/** The parts of the operator's EXTENSIONS_GALLERY blob this app reads itself. */
export type ExtensionGallery = {
  /** Base of the gallery API — `<serviceUrl>/extensionquery` is what gets queried. */
  serviceUrl: string
  /** Human-facing item page, used to build "view on <registry>" links. */
  itemUrl?: string
  /** Product scope for galleries hosting several catalogs (see gallery-client). */
  productTarget?: string
  /** The blob to hand to code-server, normalized. */
  forward: string
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined
}

function parseGallery(raw: string | null): ExtensionGallery | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    console.warn("[extensions] EXTENSIONS_GALLERY is not valid JSON — falling back to Open VSX")
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.warn("[extensions] EXTENSIONS_GALLERY is not a JSON object — falling back to Open VSX")
    return null
  }
  const obj = parsed as Record<string, unknown>
  const serviceUrl = str(obj.serviceUrl)?.replace(/\/+$/, "")
  if (!serviceUrl) {
    console.warn('[extensions] EXTENSIONS_GALLERY has no "serviceUrl" — falling back to Open VSX')
    return null
  }
  return {
    serviceUrl,
    itemUrl: str(obj.itemUrl)?.replace(/\/+$/, ""),
    productTarget: str(obj.productTarget),
    // Everything the operator wrote is forwarded, not just the keys above:
    // code-server understands more of them than we do (cacheUrl, controlUrl, …)
    // and ignores the ones it doesn't. Re-serializing rather than passing the
    // raw string through is deliberate — a blob we couldn't parse is a blob we'd
    // be searching Open VSX against, and shipping it to code-server anyway would
    // recreate the exact split-brain this module exists to prevent.
    forward: JSON.stringify({ ...obj, serviceUrl }),
  }
}

/** The configured gallery, or null when the app is on Open VSX. */
export const EXTENSION_GALLERY = parseGallery(EXTENSIONS_GALLERY_RAW)

/** The `EXTENSIONS_GALLERY` value to give code-server, or null to leave it alone. */
export const CODE_SERVER_EXTENSIONS_GALLERY = EXTENSION_GALLERY?.forward ?? null

/** What the UI needs to name the active registry instead of hardcoding "Open VSX". */
export function registryInfo(): ExtensionRegistryInfo {
  if (!EXTENSION_GALLERY) return { name: "Open VSX", homeUrl: "https://open-vsx.org", custom: false }
  let name = "the configured gallery"
  let homeUrl: string | undefined
  try {
    const url = new URL(EXTENSION_GALLERY.serviceUrl)
    name = url.hostname
    homeUrl = EXTENSION_GALLERY.itemUrl || url.origin
  } catch {
    /* a serviceUrl we can't parse still works as a fetch target; just stays unnamed */
  }
  return { name, homeUrl, custom: true }
}

/** Registry page for one id, for the "view on <registry>" links. */
export function extensionUrl(id: string): string | undefined {
  if (!EXTENSION_GALLERY) return `https://open-vsx.org/extension/${id.replace(".", "/")}`
  return EXTENSION_GALLERY.itemUrl ? `${EXTENSION_GALLERY.itemUrl}?itemName=${encodeURIComponent(id)}` : undefined
}

/** Re-points curated suggestions (registry-agnostic ids) at the active registry. */
export function withRegistryUrls(suggestions: ExtensionSuggestion[]): ExtensionSuggestion[] {
  return suggestions.map((s) => ({ ...s, url: extensionUrl(s.id) }))
}

/** Full-text search against the active registry. Throws `RegistryError` if it's down. */
export function searchExtensions(query: string, size?: number): Promise<ExtensionSuggestion[]> {
  return EXTENSION_GALLERY
    ? galleryClient.searchExtensions(EXTENSION_GALLERY, query, size)
    : openVsx.searchExtensions(query, size)
}

/** Exact lookup against the active registry. Null = a real "no such extension". */
export function lookupExtension(id: string): Promise<ExtensionSuggestion | null> {
  return EXTENSION_GALLERY ? galleryClient.lookupExtension(EXTENSION_GALLERY, id) : openVsx.lookupExtension(id)
}

export { RegistryError }
