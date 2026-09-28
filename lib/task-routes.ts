import { TaskActionError } from "../services/tasks"
import { json } from "./http"

/** A service error as the HTTP answer it stands for; anything else is a 500 with its message. */
export function taskError(err: unknown): Response {
  if (err instanceof TaskActionError) return json({ error: err.message }, { status: err.status })
  console.error("[tasks] route error:", err)
  return json({ error: (err as Error)?.message ?? "Internal error" }, { status: 500 })
}
