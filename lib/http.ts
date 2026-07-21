import { ZodError, type ZodType } from "zod"

export function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, init)
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
