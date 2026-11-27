import { finishLiteConnect, LiteConnectError } from "@/services/lite-connect"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * Where Spunto's consent page sends the browser back (the client's redirect URI). Exchanges the
 * code, opens the tunnel, then returns to Settings with `?liteConnected=1` or `?liteError=<why>`.
 */
export async function GET(req: Request) {
  const q = Object.fromEntries(new URL(req.url).searchParams)
  const back = (params: Record<string, string>) =>
    // Relative: the browser resolves it against the origin it came back to.
    new Response(null, { status: 302, headers: { Location: `/settings?${new URLSearchParams(params)}#connect-to-spunto` } })
  try {
    await finishLiteConnect({ state: q.state, code: q.code, error: q.error, errorDescription: q.error_description })
    return back({ liteConnected: "1" })
  } catch (err) {
    if (err instanceof LiteConnectError) return back({ liteError: err.message })
    throw err
  }
}
