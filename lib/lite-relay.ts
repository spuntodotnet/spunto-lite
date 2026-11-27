/**
 * What a member's devices may ask this Lite through Spunto Cloud (Lite Connect, docs/lite-connect.md):
 * a short list of Lite's own routes, each under the capability it needs. Everything else — secrets,
 * settings (the SSH key lives there), workers, terminals, services — is never served to the tunnel.
 *
 * A copy of Cloud's `apps/api/src/modules/lite/lite.relay.ts` (coderhammer/spunto, RFC 0072),
 * kept identical on purpose: Cloud checks it before relaying, Lite checks it again before serving,
 * and Lite has the last word. A route added on one side and not the other is simply refused.
 */

export const LITE_CAPABILITIES = ["read", "reply", "create"] as const
export type LiteCapability = (typeof LITE_CAPABILITIES)[number]

const ID = "[A-Za-z0-9_-]+"

const RULES: { method: "GET" | "POST"; path: RegExp; capability: LiteCapability }[] = [
  // Reading: the projects, the tasks, a conversation and what it changed.
  { method: "GET", path: /^\/api\/projects$/, capability: "read" },
  { method: "GET", path: new RegExp(`^/api/projects/${ID}$`), capability: "read" },
  { method: "GET", path: new RegExp(`^/api/projects/${ID}/tasks$`), capability: "read" },
  { method: "GET", path: /^\/api\/tasks$/, capability: "read" },
  { method: "GET", path: new RegExp(`^/api/tasks/${ID}$`), capability: "read" },
  { method: "GET", path: new RegExp(`^/api/tasks/${ID}/events$`), capability: "read" },
  { method: "GET", path: new RegExp(`^/api/tasks/${ID}/diff$`), capability: "read" },
  { method: "GET", path: new RegExp(`^/api/tasks/${ID}/attachments/${ID}$`), capability: "read" },
  // Answering a conversation, and deciding its fate: Accept (`validate`) and Drop (`cancel`).
  { method: "POST", path: new RegExp(`^/api/tasks/${ID}/messages$`), capability: "reply" },
  { method: "POST", path: new RegExp(`^/api/tasks/${ID}/interrupt$`), capability: "reply" },
  { method: "POST", path: new RegExp(`^/api/tasks/${ID}/answer$`), capability: "reply" },
  { method: "POST", path: new RegExp(`^/api/tasks/${ID}/validate$`), capability: "reply" },
  { method: "POST", path: new RegExp(`^/api/tasks/${ID}/cancel$`), capability: "reply" },
  // Delegating a new task: an agent starts on this machine, with its owner's SSH key.
  { method: "POST", path: new RegExp(`^/api/projects/${ID}/tasks$`), capability: "create" },
]

/** The capability a request to Lite needs, or null when it is never relayed. */
export function relayCapability(method: string, path: string): LiteCapability | null {
  // A path is matched as given: no dot segment, no encoded slash may sneak past a rule.
  if (/(^|\/)\.\.?(\/|$)|%2f|%5c|\\/i.test(path)) return null
  return RULES.find((r) => r.method === method && r.path.test(path))?.capability ?? null
}

/** What a Lite allows, kept to the known capabilities, in their order; `read` when nothing was said. */
export function normalizeCapabilities(value: unknown): LiteCapability[] {
  if (!Array.isArray(value)) return ["read"]
  return LITE_CAPABILITIES.filter((c) => value.includes(c))
}
