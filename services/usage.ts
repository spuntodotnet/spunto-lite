import { and, asc, eq, gte, inArray, sql } from "drizzle-orm"
import { db } from "../db/index"
import { projects, taskEvents, tasks } from "../db/schema"
import { getAgentApp } from "../lib/agent-apps"
import type { UsageGroup, UsageReport, UsageTask, UsageTokens } from "../lib/types"

/**
 * What the agents consumed, over a period — the `/usage` page. Spunto's own dashboard (obs,
 * `lib/agent-usage`) polls the platform's API and folds the events into tables of its own; Lite
 * already holds every session's stream in `task_events`, so the report is read straight from it,
 * on each request. No table, no cursor, nothing to keep in sync.
 *
 * What the events say (`@spunto/build/agent-contract`, `usage`):
 *  - **tokens** — `scope: "call"` is one model call; Claude Code and Codex write them, and summed
 *    they are what the task spent. Mistral Vibe writes none: its `scope: "session"` line, one per
 *    turn, carries the turn's tokens instead. So a task's tokens come from its calls when it has
 *    any, else from its session lines — never both, Claude restates its calls in the latter.
 *  - **cost** — only the `session` line has one (`costUsd`), and it is **cumulative per
 *    `sessionId`** (a `--resume` carries it on): a turn's cost is the step from the previous one.
 *    Codex reports none — its tasks count tokens and no money (`unpricedTasks`), rather than a
 *    price we would have to guess.
 *  - **turns** — `session.ended`, whatever the harness. **Tools** — `tool.call` and its
 *    `tool.result` (same `callId`).
 *
 * The cost is what the harness computes at API prices: an equivalent, not a bill — a Claude
 * subscription pays none of it.
 */

export const USAGE_PERIODS = [1, 7, 30, 90, 0] as const
export type UsagePeriod = (typeof USAGE_PERIODS)[number]

const DAY_MS = 86_400_000

// $ per million tokens — input, output, cache write, cache read. Only to choose between the two
// readings of a cumulative cost that went *down* (`costStep`); the cost shown is the harness's.
const PRICES: [RegExp, number[]][] = [
  [/haiku/, [1, 5, 1.25, 0.1]],
  [/sonnet/, [3, 15, 3.75, 0.3]],
  [/./, [5, 25, 6.25, 0.5]],
]

type Tokens = { input: number; output: number; cacheRead: number; cacheCreation: number }
const zero = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 })
function addTokens(to: Tokens, t: Tokens) {
  to.input += t.input
  to.output += t.output
  to.cacheRead += t.cacheRead
  to.cacheCreation += t.cacheCreation
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0)

function estimate(model: string | null, t: Tokens): number {
  const [i, o, cw, cr] = PRICES.find(([re]) => re.test(model ?? ""))![1]
  return (t.input * i + t.output * o + t.cacheCreation * cw + t.cacheRead * cr) / 1e6
}

/**
 * One turn's cost, from its session's running total. A total that went down is a process that was
 * restarted: either from zero, or restored to a total seen before (its last clean exit) — the
 * reading closest to the price of the turn's own tokens wins (obs, `costDelta`).
 */
function costStep(seen: number[], cost: number, model: string | null, t: Tokens): number {
  const prev = seen.at(-1) ?? 0
  if (seen.length < 500) seen.push(cost)
  if (cost >= prev) return cost - prev
  const guess = estimate(model, t)
  let best = cost
  for (const v of seen.slice(0, -1)) if (v <= cost && Math.abs(cost - v - guess) < Math.abs(best - guess)) best = cost - v
  return best
}

/** `YYYY-MM-DD` of an instant, in the reader's time zone. */
function dayFormatter(timeZone: string) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
  return (ms: number) => f.format(ms)
}

/** A time zone the runtime knows, else UTC — the browser sends its own. */
export function safeTimeZone(tz: string | null | undefined): string {
  if (!tz) return "UTC"
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz })
    return tz
  } catch {
    return "UTC"
  }
}

type Acc = UsageTask
type GroupAcc = Omit<UsageGroup, "tasks"> & { taskIds: Set<string> }

export function usageReport(days: UsagePeriod, timeZone: string): UsageReport {
  const dayOf = dayFormatter(timeZone)
  const now = Date.now()
  const from = days === 0 ? null : dayOf(now - (days - 1) * DAY_MS)
  // A day of margin either side of a time zone: the exact cut is `day >= from`, below.
  const since = days === 0 ? 0 : now - (days + 1) * DAY_MS
  const inPeriod = (day: string) => from === null || day >= from

  const field = (path: string) => sql.raw(`json_extract(payload, '$.${path}')`)
  const ts = sql<number>`${taskEvents.ts}`

  // Every session line and every start, for all time: a turn's cost is a step from the one before,
  // which may be older than the period. A few rows per turn — cheap.
  const sessionRows = db
    .select({
      taskId: taskEvents.taskId,
      ts,
      type: taskEvents.type,
      sessionId: sql<string | null>`${field("sessionId")}`,
      model: sql<string | null>`${field("model")}`,
      contextWindow: sql<number | null>`${field("contextWindow")}`,
      costUsd: sql<number | null>`${field("costUsd")}`,
      input: sql<number | null>`${field("inputTokens")}`,
      output: sql<number | null>`${field("outputTokens")}`,
      cacheRead: sql<number | null>`${field("cacheReadTokens")}`,
      cacheCreation: sql<number | null>`${field("cacheCreationTokens")}`,
      context: sql<number | null>`${field("contextTokens")}`,
    })
    .from(taskEvents)
    .where(sql`${taskEvents.type} = 'session.started' OR (${taskEvents.type} = 'usage' AND ${field("scope")} = 'session')`)
    .orderBy(asc(taskEvents.taskId), asc(taskEvents.seq))
    .all()

  const callRows = db
    .select({
      taskId: taskEvents.taskId,
      ts,
      model: sql<string | null>`${field("model")}`,
      input: sql<number | null>`${field("inputTokens")}`,
      output: sql<number | null>`${field("outputTokens")}`,
      cacheRead: sql<number | null>`${field("cacheReadTokens")}`,
      cacheCreation: sql<number | null>`${field("cacheCreationTokens")}`,
      context: sql<number | null>`${field("contextTokens")}`,
      contextWindow: sql<number | null>`${field("contextWindow")}`,
    })
    .from(taskEvents)
    .where(and(eq(taskEvents.type, "usage"), sql`${field("scope")} = 'call'`, gte(taskEvents.ts, new Date(since))))
    .all()

  // Which tasks measure their calls — of all time, not of the period: a task whose last call is
  // older than the period must not have its session lines counted instead.
  const measured = new Set(
    db
      .selectDistinct({ taskId: taskEvents.taskId })
      .from(taskEvents)
      .where(and(eq(taskEvents.type, "usage"), sql`${field("scope")} = 'call'`))
      .all()
      .map((r) => r.taskId),
  )

  const eventRows = db
    .select({
      taskId: taskEvents.taskId,
      ts,
      type: taskEvents.type,
      callId: sql<string | null>`${field("callId")}`,
      name: sql<string | null>`${field("name")}`,
      isError: sql<number | null>`${field("isError")}`,
    })
    .from(taskEvents)
    .where(and(inArray(taskEvents.type, ["session.ended", "tool.call", "tool.result"]), gte(taskEvents.ts, new Date(since))))
    .orderBy(asc(taskEvents.taskId), asc(taskEvents.seq))
    .all()

  const taskRows = db
    .select({
      id: tasks.id,
      projectId: tasks.projectId,
      projectName: projects.name,
      title: tasks.title,
      state: tasks.state,
      agentAppId: tasks.agentAppId,
      model: tasks.model,
      lastActivityAt: tasks.lastActivityAt,
    })
    .from(tasks)
    .leftJoin(projects, eq(projects.id, tasks.projectId))
    .all()
  const known = new Map(taskRows.map((t) => [t.id, t]))

  const acc = new Map<string, Acc>()
  /** The days each task did something on, in the period — a task with none is not listed. */
  const active = new Map<string, Set<string>>()
  const task = (id: string): Acc | null => {
    const t = known.get(id)
    if (!t) return null
    let a = acc.get(id)
    if (!a) {
      a = {
        id,
        projectId: t.projectId,
        projectName: t.projectName,
        title: t.title,
        state: t.state,
        // A task from before agent apps ran Claude Code's CLI (`LEGACY_CLI`).
        agentAppId: t.agentAppId ?? "claude",
        agentAppName: getAgentApp(t.agentAppId ?? "claude")?.name ?? t.agentAppId ?? "claude",
        model: t.model,
        lastActivityAt: t.lastActivityAt.toISOString(),
        cost: null,
        turns: 0,
        apiCalls: 0,
        toolCalls: 0,
        toolErrors: 0,
        peakContext: 0,
        contextWindow: null,
        ...zero(),
      }
      acc.set(id, a)
      active.set(id, new Set())
    }
    return a
  }

  const daily = new Map<string, UsageReport["daily"][number] & { taskIds: Set<string> }>()
  const dayRow = (day: string) => {
    let d = daily.get(day)
    if (!d) daily.set(day, (d = { day, cost: 0, turns: 0, tasks: 0, ...zero(), taskIds: new Set() }))
    return d
  }
  const models = new Map<string, GroupAcc>()
  const model = (name: string | null) => {
    const key = name ?? "unknown"
    let m = models.get(key)
    if (!m) models.set(key, (m = { id: key, name: name ?? "Unknown", cost: null, turns: 0, taskIds: new Set(), ...zero() }))
    return m
  }
  const spend = (a: Acc, day: string, t: Tokens, modelName: string | null) => {
    addTokens(a, t)
    active.get(a.id)!.add(day)
    const d = dayRow(day)
    addTokens(d, t)
    d.taskIds.add(a.id)
    const m = model(modelName)
    addTokens(m, t)
    m.taskIds.add(a.id)
  }

  // Sessions: the cost of each turn, its model, and the tokens of the tasks with no calls.
  let current = ""
  let sid = ""
  let sessionModel: string | null = null
  let totals: Record<string, number[]> = {}
  for (const r of sessionRows) {
    if (r.taskId !== current) {
      current = r.taskId
      sid = ""
      sessionModel = null
      totals = {}
    }
    const a = task(r.taskId)
    if (r.type === "session.started") {
      sid = r.sessionId ?? sid
      sessionModel = r.model ?? sessionModel
      if (a && num(r.contextWindow)) a.contextWindow = r.contextWindow
      continue
    }
    const t: Tokens = { input: num(r.input), output: num(r.output), cacheRead: num(r.cacheRead), cacheCreation: num(r.cacheCreation) }
    const turnModel = r.model ?? sessionModel ?? a?.model ?? null
    const step = typeof r.costUsd === "number" && Number.isFinite(r.costUsd) ? costStep((totals[sid] ??= []), r.costUsd, turnModel, t) : null
    const day = dayOf(r.ts)
    if (!a || !inPeriod(day)) continue
    // The model that ran says more than the one asked for (an alias, or none: the app's default).
    a.model = turnModel ?? a.model
    if (!measured.has(r.taskId)) {
      spend(a, day, t, turnModel)
      a.peakContext = Math.max(a.peakContext, num(r.context))
      if (num(r.contextWindow)) a.contextWindow = r.contextWindow
    }
    if (step !== null) {
      a.cost = (a.cost ?? 0) + step
      dayRow(day).cost += step
      const m = model(turnModel)
      m.cost = (m.cost ?? 0) + step
    }
  }

  for (const r of callRows) {
    const a = task(r.taskId)
    const day = dayOf(r.ts)
    if (!a || !inPeriod(day)) continue
    a.model = r.model ?? a.model
    spend(a, day, { input: num(r.input), output: num(r.output), cacheRead: num(r.cacheRead), cacheCreation: num(r.cacheCreation) }, a.model)
    a.apiCalls++
    a.peakContext = Math.max(a.peakContext, num(r.context))
    if (num(r.contextWindow)) a.contextWindow = r.contextWindow
  }

  // Turns and tools. A call's time runs to its result — the result may land the next day, the
  // call is counted on its own.
  const tools = new Map<string, UsageReport["tools"][number]>()
  const open = new Map<string, { tool: UsageReport["tools"][number]; ts: number }>()
  for (const r of eventRows) {
    const a = task(r.taskId)
    const day = dayOf(r.ts)
    if (!a) continue
    if (r.type === "tool.result") {
      const key = `${r.taskId}:${r.callId}`
      const call = r.callId ? open.get(key) : undefined
      if (!call) continue
      open.delete(key)
      call.tool.ms += Math.max(0, r.ts - call.ts)
      if (r.isError) {
        call.tool.errors++
        a.toolErrors++
      }
      continue
    }
    if (!inPeriod(day)) continue
    active.get(a.id)!.add(day)
    dayRow(day).taskIds.add(a.id)
    if (r.type === "session.ended") {
      a.turns++
      dayRow(day).turns++
      model(a.model).turns++
      continue
    }
    const name = (r.name ?? "unknown").slice(0, 120)
    let tool = tools.get(name)
    if (!tool) tools.set(name, (tool = { name, n: 0, errors: 0, ms: 0 }))
    tool.n++
    a.toolCalls++
    if (r.callId) open.set(`${r.taskId}:${r.callId}`, { tool, ts: r.ts })
  }

  const list = [...acc.values()].filter((a) => active.get(a.id)!.size > 0)
  const group = (key: (a: Acc) => [string, string]) => {
    const out = new Map<string, GroupAcc>()
    for (const a of list) {
      const [id, name] = key(a)
      let g = out.get(id)
      if (!g) out.set(id, (g = { id, name, cost: null, turns: 0, taskIds: new Set(), ...zero() }))
      addTokens(g, a)
      g.turns += a.turns
      g.taskIds.add(a.id)
      if (a.cost !== null) g.cost = (g.cost ?? 0) + a.cost
    }
    return finish([...out.values()])
  }
  const finish = (gs: GroupAcc[]): UsageGroup[] =>
    gs
      .filter((g) => g.taskIds.size > 0)
      .map(({ taskIds, ...g }) => ({ ...g, tasks: taskIds.size }))
      .sort((x, y) => (y.cost ?? 0) - (x.cost ?? 0) || y.output - x.output)

  const totalTokens = zero()
  for (const a of list) addTokens(totalTokens, a)
  const spent = (a: UsageTokens) => a.input + a.output + a.cacheRead + a.cacheCreation > 0

  return {
    days,
    from,
    timeZone,
    totals: {
      ...totalTokens,
      cost: list.reduce((s, a) => s + (a.cost ?? 0), 0),
      unpricedTasks: list.filter((a) => a.cost === null && spent(a)).length,
      tasks: list.length,
      turns: list.reduce((s, a) => s + a.turns, 0),
      apiCalls: list.reduce((s, a) => s + a.apiCalls, 0),
      toolCalls: list.reduce((s, a) => s + a.toolCalls, 0),
      toolErrors: list.reduce((s, a) => s + a.toolErrors, 0),
    },
    daily: fillDays([...daily.values()].map(({ taskIds, ...d }) => ({ ...d, tasks: taskIds.size })), from, dayOf(now)),
    tasks: list.sort((x, y) => (y.cost ?? 0) - (x.cost ?? 0) || y.output - x.output),
    projects: group((a) => [a.projectId, a.projectName ?? "(deleted project)"]),
    apps: group((a) => [a.agentAppId, a.agentAppName]),
    models: finish([...models.values()]),
    tools: [...tools.values()].sort((x, y) => y.n - x.n),
  }
}

/** Every day of the period, the quiet ones too — a gap in the chart is a day at zero, not a jump. */
function fillDays(rows: UsageReport["daily"], from: string | null, today: string): UsageReport["daily"] {
  const byDay = new Map(rows.map((r) => [r.day, r]))
  const first = from ?? [...byDay.keys()].sort()[0]
  if (!first) return []
  const out: UsageReport["daily"] = []
  for (let d = first; d <= today; d = nextDay(d)) out.push(byDay.get(d) ?? { day: d, cost: 0, turns: 0, tasks: 0, ...zero() })
  return out
}

function nextDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}
