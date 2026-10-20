import { ZodError, type ZodType } from "zod"

/**
 * Fields that never leave this process, whatever row a route returns: the hash of a worker's agent
 * token (lib/agent.ts) is what a hello is checked against.
 */
const PRIVATE_FIELDS = new Set(["agentTokenHash"])

export function json(data: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers)
  if (!headers.has("content-type")) headers.set("content-type", "application/json")
  return new Response(JSON.stringify(data, (k, v) => (PRIVATE_FIELDS.has(k) ? undefined : v)), { ...init, headers })
}

export function badRequest(message: string, details?: unknown) {
  return Response.json({ error: message, details }, { status: 400 })
}

export function notFound(message = "Not found") {
  return Response.json({ error: message }, { status: 404 })
}

/** Parses+validates a JSON body against a zod schema, returning either data or a 400 Response. */
export async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<{ data: T } | { response: Response }> {
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return { response: badRequest("Invalid JSON body") }
  }
  const result = schema.safeParse(raw)
  if (!result.success) {
    const err = result.error as ZodError
    return { response: badRequest("Validation failed", err.flatten()) }
  }
  return { data: result.data }
}
