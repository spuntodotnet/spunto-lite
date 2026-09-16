// Which registry do we resolve extension ids against? — Spunto Lite's half of the answer.
//
// The protocols, the two clients and the choice between them live in `@spunto/build/extensions`,
// shared with Spunto Cloud so that the picker's search and the worker's code-server can never end
// up on different registries. What stays here is the one thing the package deliberately refuses to
// do: read the operator's setting out of the environment.
//
// Cloud scopes that setting per organization and passes it down call by call. Lite has exactly one
// operator and one process, so the gallery is parsed once at import and bound into the wrappers
// below — which keeps every caller's signature unchanged (`searchExtensions(query)`), rather than
// threading a value that cannot vary through the whole app.

import {
  codeServerGallery,
  extensionUrl as extensionUrlFor,
  lookupExtension as lookupExtensionIn,
  parseGallery,
  registryInfo as registryInfoFor,
  searchExtensions as searchExtensionsIn,
  withRegistryUrls as withRegistryUrlsFor,
  RegistryError,
  type ExtensionGallery,
  type ExtensionRegistryInfo,
  type ExtensionSuggestion,
} from "@spunto/build/extensions"
import { EXTENSIONS_GALLERY_RAW, OPEN_VSX_API } from "./env"

/** The configured gallery, or null when the app is on Open VSX. */
export const EXTENSION_GALLERY: ExtensionGallery | null = parseGallery(EXTENSIONS_GALLERY_RAW)

/** The `EXTENSIONS_GALLERY` value to give code-server, or null to leave it alone. */
export const CODE_SERVER_EXTENSIONS_GALLERY = codeServerGallery(EXTENSIONS_GALLERY_RAW)

/** What the UI needs to name the active registry instead of hardcoding "Open VSX". */
export function registryInfo(): ExtensionRegistryInfo {
  return registryInfoFor(EXTENSION_GALLERY)
}

/** Registry page for one id, for the "view on <registry>" links. */
export function extensionUrl(id: string): string | undefined {
  return extensionUrlFor(EXTENSION_GALLERY, id)
}

/** Re-points curated suggestions (registry-agnostic ids) at the active registry. */
export function withRegistryUrls(suggestions: ExtensionSuggestion[]): ExtensionSuggestion[] {
  return withRegistryUrlsFor(EXTENSION_GALLERY, suggestions)
}

/**
 * Only applies to the default (Open VSX) branch — a gallery carries its own endpoint in its blob,
 * so `OPEN_VSX_API` has nothing left to configure once one is active. Passed on every call because
 * the package reads no environment of its own.
 */
const REGISTRY_OPTS = { openVsxApiUrl: OPEN_VSX_API }

/** Full-text search against the active registry. Throws `RegistryError` if it's down. */
export function searchExtensions(query: string, size?: number): Promise<ExtensionSuggestion[]> {
  return searchExtensionsIn(EXTENSION_GALLERY, query, size, REGISTRY_OPTS)
}

/** Exact lookup against the active registry. Null = a real "no such extension". */
export function lookupExtension(id: string): Promise<ExtensionSuggestion | null> {
  return lookupExtensionIn(EXTENSION_GALLERY, id, REGISTRY_OPTS)
}

export { RegistryError }
export type { ExtensionGallery, ExtensionRegistryInfo, ExtensionSuggestion }
