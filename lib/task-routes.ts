import { TaskActionError } from "../services/tasks"
import { json } from "./http"
import { TASK_METADATA_KEY } from "./validation"

/** A service error as the HTTP answer it stands for; anything else is a 500 with its message. */
export function taskError(err: unknown): Response {
  if (err instanceof TaskActionError) return json({ error: err.message }, { status: err.status })
  console.error("[tasks] route error:", err)
  return json({ error: (err as Error)?.message ?? "Internal error" }, { status: 500 })
}

/**
 * `?metadata[key]=value` (repeatable) — the lists' filter on what a caller attached (docs/taches.md
 * § « Liens et métadonnées »). Read off the raw query rather than declared, because its keys are
 * the caller's. A key that could not exist on a task is a 400, not a filter that silently matches
 * nothing.
 */
const METADATA_PARAM = /^metadata\[(.*)\]$/
export function metadataFilter(params: URLSearchParams): { metadata: Record<string, string> } | { response: Response } {
  const metadata: Record<string, string> = {}
  for (const [name, value] of params) {
    const key = METADATA_PARAM.exec(name)?.[1]
    if (key === undefined) continue
    if (!TASK_METADATA_KEY.test(key)) return { response: json({ error: `Invalid metadata key in filter: ${JSON.stringify(key)}` }, { status: 400 }) }
    metadata[key] = value
  }
  return { metadata }
}
