import { registryInfo } from "@/lib/extension-registry"
import { json } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * Which registry the extension picker is talking to. Read by the client form so
 * it can name it instead of hardcoding "Open VSX" — EXTENSIONS_GALLERY is set at
 * `docker run` time on a prebuilt image, so a `NEXT_PUBLIC_` variable (inlined
 * at build time) could never see it.
 */
export async function GET() {
  return json(registryInfo())
}
