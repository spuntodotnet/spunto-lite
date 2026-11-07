/**
 * The Claude Code block of a task's details: what only Claude Code knows about the session, read
 * from its own lines. Spunto Cloud's `claude-tile.ts` (RFC 0053 § 5), where the `claude` app draws
 * it through the integrations' `embed` capability; Lite has no integrations, so it draws it itself,
 * from the same lines, in the same shape (`TaskAppTile` of the design system).
 *
 * The platform's **Session** block already says context, tokens, cost, turns and model — in our
 * vocabulary, the same for every harness. This one says the rest, in Claude Code's: how much of the
 * plan's windows is used, which MCP servers answered, which skills and agents the session had, the
 * cost per model when there was more than one, what was refused. Nothing it shows is repeated from
 * Session.
 *
 * Lines read (`task_events.source`, the harness line each event was parsed from; shapes as Claude
 * Code 2.1 writes them):
 *  - `system/init` (`session.started`): version, permission mode, `mcp_servers[{name,status}]`,
 *    `skills`, `agents`, `tools`, `session_id`;
 *  - `result` (`session.ended`): `modelUsage{model:{costUSD,…}}`, `subagent_stats`,
 *    `permission_denials`, `usage.server_tool_use`, `is_error`/`terminal_reason`;
 *  - `rate_limit_event` (a `raw` event of ours): `rate_limit_info.unifiedWindows`.
 * A field that is missing is a row that is missing — never a guess. Pure.
 */

import type { TaskAppTile, TaskAppTileFact, TaskAppTileItem, TaskAppTileList, TaskAppTileMeter, TaskAppTileTone } from "@spunto/design-system/tasks"

/** The session's own lines, verbatim: the latest of each kind this block reads. */
export type SessionLines = {
  started: string | null
  ended: string | null
  rateLimit: string | null
}

type Json = Record<string, unknown>

function parse(line: string | null | undefined): Json | null {
  if (!line) return null
  try {
    const value = JSON.parse(line)
    return value && typeof value === "object" ? (value as Json) : null
  } catch {
    // Capped at 64 KB by the ingester: an init line past that is cut, and is not JSON any more.
    return null
  }
}

const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null)
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : [])

/** `five_hour` → « 5-hour limit », `seven_day_opus` → « Weekly limit · Opus ». */
export function windowLabel(key: string): string {
  const known: Record<string, string> = { five_hour: "5-hour limit", seven_day: "Weekly limit" }
  if (known[key]) return known[key]
  const m = key.match(/^seven_day_(.+)$/)
  if (m) return `Weekly limit · ${m[1].charAt(0).toUpperCase()}${m[1].slice(1)}`
  return key.replace(/_/g, " ")
}

/** The plan's windows, from the latest `rate_limit_event` — a window already reset is not shown. */
export function quotaMeters(rate: Json | null, now = Date.now()): { meters: TaskAppTileMeter[]; facts: TaskAppTileFact[] } {
  const info = obj(rate?.rate_limit_info)
  if (!info) return { meters: [], facts: [] }
  const meters: TaskAppTileMeter[] = []
  for (const [key, raw] of Object.entries(obj(info.unifiedWindows) ?? {})) {
    const w = obj(raw)
    const utilization = num(w?.utilization)
    const resetsAt = num(w?.resetsAt)
    if (utilization === null) continue
    // Seconds since the epoch. A window whose reset has passed says nothing about now.
    if (resetsAt !== null && resetsAt * 1000 <= now) continue
    const blocked = str(w?.status) !== null && w?.status !== "allowed"
    const tone: TaskAppTileTone = blocked ? "danger" : utilization >= 0.9 ? "danger" : utilization >= 0.75 ? "warning" : "neutral"
    meters.push({
      label: windowLabel(key),
      value: utilization,
      tone,
      ...(blocked ? { detail: "Limit reached" } : {}),
      ...(resetsAt !== null ? { resetsAt: new Date(resetsAt * 1000).toISOString() } : {}),
    })
  }

  const facts: TaskAppTileFact[] = []
  if (info.isUsingOverage === true) {
    facts.push({ label: "Extra usage", value: "In use", tone: "warning" })
  } else if (str(info.overageStatus)) {
    const reason = str(info.overageDisabledReason)?.replace(/_/g, " ")
    const allowed = info.overageStatus === "allowed"
    facts.push({ label: "Extra usage", value: allowed ? "Available" : reason ? `Off — ${reason}` : "Off", tone: allowed ? "neutral" : "muted" })
  }
  return { meters, facts }
}

const MCP_STATUS: Record<string, { label: string; tone: TaskAppTileTone }> = {
  connected: { label: "Connected", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  "needs-auth": { label: "Needs auth", tone: "warning" },
  pending: { label: "Pending", tone: "muted" },
  disabled: { label: "Disabled", tone: "muted" },
}

/** The MCP servers the session started with, failing ones first. */
export function mcpServers(init: Json | null): TaskAppTileItem[] {
  const servers = Array.isArray(init?.mcp_servers) ? (init.mcp_servers as unknown[]) : []
  const items = servers
    .map(obj)
    .filter((s): s is Json => !!s && !!str(s.name))
    .map((s): TaskAppTileItem => {
      const status = str(s.status) ?? "pending"
      return { title: str(s.name)!, status: MCP_STATUS[status] ?? { label: status, tone: "neutral" } }
    })
  const rank = (i: TaskAppTileItem) => (i.status?.tone === "danger" ? 0 : i.status?.tone === "warning" ? 1 : 2)
  return items.sort((a, b) => rank(a) - rank(b))
}

const PERMISSION_MODES: Record<string, string> = {
  bypassPermissions: "Bypass — no prompts",
  acceptEdits: "Accept edits",
  default: "Ask",
  plan: "Plan only",
}

function usd(v: number): string {
  return v >= 1 ? `$${v.toFixed(2)}` : v >= 0.01 ? `$${v.toFixed(3)}` : `<$0.01`
}

function compact(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n)
}

/** Version, permissions, tools, and what the latest turn's `result` adds — never what Session shows. */
export function sessionFacts(init: Json | null, result: Json | null): TaskAppTileFact[] {
  const facts: TaskAppTileFact[] = []

  if (result?.is_error === true) {
    const why = str(result.terminal_reason) ?? str(result.subtype) ?? "error"
    const status = num(result.api_error_status)
    facts.push({ label: "Last turn", value: `Ended in error — ${why.replace(/_/g, " ")}${status ? ` (API ${status})` : ""}`, tone: "danger" })
  }

  // Per model only when there is more than one: with a single model, its cost *is* Session's cost.
  const models = Object.entries(obj(result?.modelUsage) ?? {})
    .map(([model, raw]) => ({ model, u: obj(raw) }))
    .filter((m): m is { model: string; u: Json } => !!m.u)
  if (models.length > 1) {
    for (const { model, u } of models.sort((a, b) => (num(b.u.costUSD) ?? 0) - (num(a.u.costUSD) ?? 0))) {
      const cost = num(u.costUSD)
      const out = num(u.outputTokens)
      facts.push({
        label: model.replace(/^claude-/, ""),
        value: [cost !== null ? usd(cost) : null, out !== null ? `${compact(out)} out` : null].filter(Boolean).join(" · ") || "—",
      })
    }
  }
  const thinking = models.reduce((sum, m) => sum + (num(m.u.thinkingTokens) ?? 0), 0)
  if (thinking > 0) facts.push({ label: "Thinking", value: `${compact(thinking)} tokens` })

  const sub = obj(result?.subagent_stats)
  const spawned = num(sub?.spawned) ?? 0
  if (spawned > 0) {
    const failed = num(sub?.failed) ?? 0
    facts.push({ label: "Subagents", value: `${spawned} spawned${failed ? ` · ${failed} failed` : ""}`, ...(failed ? { tone: "warning" as const } : {}) })
  }
  const denials = Array.isArray(result?.permission_denials) ? (result.permission_denials as unknown[]).length : 0
  if (denials > 0) facts.push({ label: "Permission denials", value: String(denials), tone: "warning" })
  const searches = num(obj(obj(result?.usage)?.server_tool_use)?.web_search_requests) ?? 0
  if (searches > 0) facts.push({ label: "Web searches", value: String(searches) })

  const tools = strings(init?.tools)
  if (tools.length) {
    const mcp = tools.filter((t) => t.startsWith("mcp__")).length
    facts.push({ label: "Tools", value: mcp ? `${tools.length} · ${mcp} from MCP` : String(tools.length) })
  }
  const mode = str(init?.permissionMode)
  if (mode) facts.push({ label: "Permissions", value: PERMISSION_MODES[mode] ?? mode })
  const version = str(init?.claude_code_version)
  if (version) facts.push({ label: "Claude Code", value: version })
  const sessionId = str(init?.session_id) ?? str(result?.session_id)
  if (sessionId) facts.push({ label: "Session id", value: sessionId, copy: true })
  return facts
}

/** The whole block, from the session's lines. Null when they say nothing this block would show. */
export function claudeTile(session: SessionLines | null | undefined, now = Date.now()): TaskAppTile | null {
  if (!session) return null
  const init = parse(session.started)
  const result = parse(session.ended)
  const quota = quotaMeters(parse(session.rateLimit), now)

  const lists: TaskAppTileList[] = []
  const skills = strings(init?.skills)
  if (skills.length) lists.push({ label: "Skills", values: skills })
  const agents = strings(init?.agents)
  if (agents.length) lists.push({ label: "Agents", values: agents })

  const tile: TaskAppTile = {
    appId: "claude",
    appName: "Claude Code",
    title: "Claude Code",
    // Drawn right under Session: it is the harness talking about the same session.
    session: true,
    meters: quota.meters,
    facts: [...quota.facts, ...sessionFacts(init, result)],
    items: mcpServers(init),
    lists,
  }
  return tile.meters!.length || tile.facts!.length || tile.items!.length || lists.length ? tile : null
}
