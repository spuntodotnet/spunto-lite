import { SUGGESTED_EXTENSIONS } from "@/lib/catalogs"
import { lookupExtension, searchExtensions, withRegistryUrls, RegistryError } from "@/lib/extension-registry"
import { isExtensionId } from "@/lib/extensions"
import { json } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/** The registry is a third party: a hiccup there is a 503 here, never a 500. */
function registryDown(e: unknown) {
  return json({ error: (e as Error).message || "Extension registry unreachable" }, { status: 503 })
}

/**
 * Three read modes, all against the active registry — Open VSX by default, or
 * the gallery in EXTENSIONS_GALLERY, i.e. whichever one the workers' code-server
 * installs from (see lib/extension-registry.ts):
 *   - `?q=<text>`  → search results
 *   - `?id=<pub.name>` → existence verdict for a hand-typed id
 *   - no param     → the curated suggestions, i.e. the picker's default state
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)

  const id = searchParams.get("id")?.trim()
  if (id) {
    if (!isExtensionId(id)) return json({ id, valid: false, found: false, extension: null })
    try {
      const extension = await lookupExtension(id)
      return json({ id, valid: true, found: !!extension, extension })
    } catch (e) {
      if (e instanceof RegistryError) return registryDown(e)
      throw e
    }
  }

  const q = searchParams.get("q")?.trim()
  if (!q) return json(withRegistryUrls(SUGGESTED_EXTENSIONS))
  try {
    return json(await searchExtensions(q))
  } catch (e) {
    if (e instanceof RegistryError) return registryDown(e)
    throw e
  }
}
