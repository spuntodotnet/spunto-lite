import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm"
import {
  applyProtocol,
  interruptLine,
  isInteractive,
  userTurnLine,
  type AgentProtocol,
} from "@spunto/build/agent-stream"
import { db } from "../db/index"
import { projects, tasks, workers, type Project, type Task, type TaskCommand } from "../db/schema"
import { newId } from "../lib/id"
import { shellQuote } from "../lib/shell"
import { DEFAULT_AGENT_COMMAND, DEFAULT_FOLLOW_UP_COMMAND } from "../lib/harness-packs"
import type { CreateTaskInput } from "../lib/validation"
import { getProjectRow } from "./projects"
import { resolveSecretsForSpawn } from "./secrets"
import { getWorkerLive, spawnWorker, startWorker, stopWorker, setWorkerTags } from "./workers"
import * as commands from "./task-commands"
import * as events from "./task-events"
import * as attachments from "./task-attachments"
import type { InlineFile, StoredFile } from "./task-attachments"

/**
 * Delegated work (docs/tasks.md): a prompt handed to an agent, in a worker of the project, on a
 * branch of its own, with something to review at the end.
 *
 * Ported from Spunto Cloud's `tasks.service.ts`, and the same in everything that shows: the five
 * states, how they are derived, the pool, the branch setup, the session and its stream, Accept /
 * Drop / reply / interrupt. What differs is plumbing:
 *
 *  - **no durable job table.** Cloud runs `task.run`, `task.validate`… as jobs that survive a
 *    redeploy. Lite runs them in-process, fire-and-forget like a worker spawn — and writes the
 *    wait (`pendingAction`) on the row, cleared in a `finally`. A restart mid-job is caught at boot
 *    (`recoverInterruptedTasks`) and said on the task rather than left to spin.
 *  - **no members.** The pool is the project's, not a member's; there is one user.
 *  - **one Docker daemon** instead of an RPC per node.
 *
 * What does survive a restart is what matters most: the agent session is a background command
 * **in the worker** (lib/worker-commands.ts), and its stream is read from there by cursor.
 */

export const TASK_STATES = ["queued", "running", "in-review", "done", "failed"] as const
export type TaskState = (typeof TASK_STATES)[number]
export type TaskPendingAction = "accepting" | "dropping" | "replying"

/**
 * The tag that puts a worker in a project's **task pool**. Every worker a task spawns carries it,
 * and a worker a human is using never does — so it is never requisitioned. Tagging one by hand is
 * giving it to the pool.
 */
export const TASK_POOL_TAG = "task"

const WORKER_READY_TIMEOUT_MS = 30 * 60 * 1000
const WORKER_READY_POLL_MS = 3_000
const RESET_TIMEOUT_MS = 15 * 60 * 1000
const SESSION_TIMEOUT_MS = 6 * 60 * 60 * 1000
/** A read path pulls a live interactive stream at most this often per task. */
const LIVE_INGEST_MIN_INTERVAL_MS = 10_000

/**
 * When each task's stream was last pulled by a read — its own clock, not `lastRefreshedAt`.
 * Every read stamps that one, so throttling on it meant a client polling the task faster than the
 * throttle (a project list every 5 s) starved ingestion for good, and an interactive session —
 * whose hand-back is only visible in its stream — stayed `running` for ever. In memory: losing it
 * on a restart costs one extra read.
 */
const lastLiveIngest = new Map<string, number>()

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/** `task/<title-slug>-<short id>` — unique by the suffix, readable by the slug, always a valid ref. */
export function taskBranchName(title: string, taskId: string): string {
  const slug = title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "")
  return `task/${slug || "task"}-${taskId.slice(0, 6)}`
}

const PLACEHOLDER_TITLE_CHARS = 72

/** A name for a task nobody named: the prompt's first line worth reading, cut at a word. */
export function titleFromPrompt(prompt: string): string {
  const line = prompt
    .split("\n")
    .map((l) => l.trim().replace(/^(?:[-*+>]\s+|\d+[.)]\s+|#{1,6}\s+)/, "").trim())
    .find((l) => /[\p{L}\p{N}]/u.test(l))
  if (!line) return "New task"
  if (line.length <= PLACEHOLDER_TITLE_CHARS) return line
  const cut = line.slice(0, PLACEHOLDER_TITLE_CHARS)
  const space = cut.lastIndexOf(" ")
  return `${(space > 24 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?-]+$/, "")}…`
}

/** Not the task's title: a pool machine outlives the task that created it. */
export function taskWorkerName(taskId: string): string {
  return `task-${taskId.slice(0, 6)}`
}

/**
 * Put a repository on the task's branch, from its base (or the remote's default). On a recycled
 * machine, first throw away what the previous task left — printed before it is discarded — with
 * `clean -fd` and never `-x`: ignored files (`node_modules`, caches) are what recycling is for.
 */
export function branchSetupScript(branch: string, baseBranch: string | null, recycled = false): string {
  const base = baseBranch
    ? `base=${shellQuote(baseBranch)}`
    : `base=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||' || true)
if [ -z "$base" ]; then
  base=$(git ls-remote --symref origin HEAD 2>/dev/null | awk '$1=="ref:"{sub("refs/heads/","",$2); print $2; exit}' || true)
fi
base=\${base:-$(git rev-parse --abbrev-ref HEAD)}`
  const clean = recycled
    ? `dirty=$(git status --porcelain 2>/dev/null || true)
if [ -n "$dirty" ]; then
  echo "Recycled worker — discarding leftovers from the previous task:"
  printf '%s\\n' "$dirty"
fi
git reset --hard --quiet
git clean -fd --quiet
`
    : ""
  return `set -euo pipefail
${base}
${clean}git fetch origin "$base" --quiet
git checkout -B ${shellQuote(branch)} "origin/$base"
git rev-parse --abbrev-ref HEAD`
}

/** Why the branch could not be created, in terms of what the reader can do about it. */
export function branchSetupError(branch: string, cwd: string, gitOutput: string): string {
  const tail = gitOutput.slice(-500)
  if (/not a git repository/i.test(gitOutput)) {
    return `No git repository at ${cwd}, so there is nothing to branch. A task works on a branch of the project's repository — add one to the project (Edit → Repositories) and try again. (git said: ${tail})`
  }
  if (/couldn't find remote ref|not found in upstream|no such ref/i.test(gitOutput)) {
    return `The base branch of this task does not exist on the remote, so "${branch}" could not be created from it. Pick an existing base branch. (git said: ${tail})`
  }
  if (/could not read from remote|permission denied|authentication failed/i.test(gitOutput)) {
    return `The repository could not be reached to create "${branch}" — the worker has no credentials for it. Check the SSH key in Settings. (git said: ${tail})`
  }
  return `Could not create branch "${branch}" in ${cwd}: ${tail}`
}

/** `--model <id>`, unless the command already names one. */
export function applyModel(command: string, model?: string | null): string {
  if (!model?.trim() || /--model\b/.test(command)) return command
  return `${command} --model ${shellQuote(model.trim())}`
}

/**
 * The command that runs the session. One-shot: the prompt goes through a heredoc whose delimiter
 * carries the task id. Interactive: nothing is piped — the turn is written into the live stdin.
 */
export function sessionCommand(
  taskId: string,
  prompt: string,
  agentCommand?: string | null,
  protocol: AgentProtocol = "none",
  model?: string | null,
): string {
  const bin = applyModel(applyProtocol(agentCommand?.trim() || DEFAULT_AGENT_COMMAND, protocol), model)
  if (isInteractive(protocol)) return bin
  const delimiter = `SPUNTO_TASK_${taskId.toUpperCase()}`
  return `cat <<'${delimiter}' | ${bin}\n${prompt}\n${delimiter}\n`
}

/** What "done" means, when the project has not said anything more. */
export const DEFAULT_AGENT_INSTRUCTIONS = "When the work is done: commit on this branch and push it."

/**
 * The opening turn: the user's prompt, then the facts the agent cannot deduce from the container
 * (its branch, where it came from), the standing instruction, the project's own, and where the
 * attached files landed. Follow-ups carry none of it — the session already has it.
 */
export function sessionPrompt(input: {
  prompt: string
  branch: string
  baseBranch: string | null
  projectInstructions?: string | null
  attachments?: string[]
}): string {
  return [
    input.prompt,
    "",
    "---",
    `Spunto context: you are running in a disposable worker, on branch \`${input.branch}\`` +
      `${input.baseBranch ? ` (created from \`${input.baseBranch}\`)` : ""}, already checked out.`,
    DEFAULT_AGENT_INSTRUCTIONS,
    ...(input.projectInstructions?.trim() ? [input.projectInstructions.trim()] : []),
    attachments.attachmentPreamble(input.attachments ?? []),
  ]
    .join("\n")
    .trimEnd()
}

/**
 * The state machine, as a pure function of the session's status. There is deliberately no path
 * to `done`: that means "someone decided this is good", and no exit code carries that.
 */
export function deriveState(session: { status: string } | null): TaskState {
  if (!session) return "queued"
  if (session.status === "running") return "running"
  if (session.status !== "succeeded") return "failed"
  return "in-review"
}

export function isLive(state: string): boolean {
  return state === "queued" || state === "running" || state === "in-review"
}

// ─── Serialization ────────────────────────────────────────────────────────────

/** The row minus its bookkeeping (cursors, clocks) — what the API returns. */
export function serializeTask(row: Task) {
  const out: Partial<Task> = { ...row }
  delete out.lastRefreshedAt
  delete out.eventsOffset
  delete out.eventsSeq
  delete out.eventsCommandId
  return out as Omit<Task, "lastRefreshedAt" | "eventsOffset" | "eventsSeq" | "eventsCommandId">
}

/** The detail view adds whether a follow-up can resume the session (a session id was captured). */
export function serializeTaskDetail(row: Task) {
  return { ...serializeTask(row), canResume: events.latestSessionId(row.id) !== null }
}

// ─── Create ───────────────────────────────────────────────────────────────────

export class TaskActionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message)
  }
}

export function createTask(projectId: string, input: CreateTaskInput): Task {
  const project = getProjectRow(projectId)
  if (!project) throw new TaskActionError("Project not found", 404)
  const id = newId()
  const now = new Date()
  const given = input.title?.trim()
  const title = given || titleFromPrompt(input.prompt)
  const row: Task = {
    id,
    projectId,
    title,
    autoTitle: !given,
    prompt: input.prompt,
    baseBranch: input.baseBranch?.trim() || null,
    branch: taskBranchName(title, id),
    // Resolved once, here: a follow-up resumes the same session, and switching models mid-way
    // because the project's default moved would be a surprise, not a setting.
    model: input.model?.trim() || project.taskAgentModel || null,
    workerId: null,
    commandId: null,
    state: "queued",
    error: null,
    pendingAction: null,
    pendingSince: null,
    lastRefreshedAt: null,
    lastActivityAt: now,
    eventsCommandId: null,
    eventsOffset: 0,
    eventsSeq: 0,
    createdAt: now,
    startedAt: null,
    completedAt: null,
  }
  db.insert(tasks).values(row).run()
  // Stored now so they travel with the job: the worker they go into does not exist yet.
  const files = attachments.storeFiles(id, null, "user", input.files ?? [])
  void runJob(id, "run", () => runTask(id, files.map((f) => f.id)), (error) => failTask(id, error))
  return row
}

/**
 * Run one of a task's jobs in the background. Lite's stand-in for Cloud's durable jobs: the
 * request answers straight away, the work goes on in this process, and a failure lands on the
 * task instead of in a log nobody reads.
 */
async function runJob(taskId: string, kind: string, work: () => Promise<void>, onFailure: (error: string) => void): Promise<void> {
  try {
    await work()
  } catch (err) {
    const message = (err as Error)?.message ?? String(err)
    console.error(`[task:${taskId}] ${kind} failed: ${message}`)
    try {
      onFailure(message)
    } catch (e) {
      console.error(`[task:${taskId}] could not record the failure: ${e}`)
    }
  }
}

function getRawTask(id: string): Task | undefined {
  return db.select().from(tasks).where(eq(tasks.id, id)).get()
}

function failTask(taskId: string, error: string): void {
  const now = new Date()
  db.update(tasks)
    .set({ state: "failed", error: error.slice(0, 2000), completedAt: now, lastActivityAt: now })
    .where(eq(tasks.id, taskId))
    .run()
}

function projectOf(task: Task): Project {
  const project = getProjectRow(task.projectId)
  if (!project) throw new Error(`Project ${task.projectId} not found`)
  return project
}

function protocolOf(project: Project | undefined): AgentProtocol {
  return (project?.taskAgentProtocol as AgentProtocol | undefined) ?? "none"
}

function repoPaths(project: Project): string[] {
  const paths = project.repositories.map((r) => `/workspace/${r.workspacePath}`)
  return paths.length > 0 ? paths : ["/workspace"]
}

// ─── The run: allocate, branch, launch ────────────────────────────────────────

async function runTask(taskId: string, fileIds: string[]): Promise<void> {
  const task = getRawTask(taskId)
  if (!task || task.state !== "queued") return
  const project = projectOf(task)

  const { workerId, recycled } = await allocateWorker(task)
  db.update(tasks).set({ workerId }).where(eq(tasks.id, task.id)).run()
  console.log(`[task:${task.id}] worker ${workerId} allocated (${recycled ? "recycled" : "fresh"}) — waiting for ready`)
  await waitForWorkerReady(workerId)
  // Dropped while its machine was being built: nothing more to do, and nothing to start.
  if (getRawTask(taskId)?.state !== "queued") return

  const paths = repoPaths(project)
  for (const cwd of paths) {
    const result = await commands.runTaskCommand(task.id, workerId, {
      command: branchSetupScript(task.branch, task.baseBranch, recycled),
      cwd,
      timeoutMs: 120_000,
      label: paths.length > 1 ? `Branch setup (${cwd})` : "Branch setup",
    })
    if (result.status !== "succeeded") {
      throw new Error(branchSetupError(task.branch, cwd, (result.stderr || result.stdout || "").trim()))
    }
  }

  if (recycled && project.taskResetCommand?.trim()) {
    const result = await commands.runTaskCommand(task.id, workerId, {
      command: project.taskResetCommand,
      cwd: paths[0],
      env: taskCommandEnv(task),
      timeoutMs: RESET_TIMEOUT_MS,
      label: "Reset",
    })
    if (result.status !== "succeeded") {
      const output = (result.stderr || result.stdout || "").trim().slice(-500)
      throw new Error(
        `The project's reset command failed on recycled worker ${workerId}, so the task never started — ` +
          `the machine is not in the state this project needs. (exit ${result.exitCode}: ${output})`,
      )
    }
  }

  const protocol = protocolOf(project)
  const files = attachments.attachmentsByIds(task.id, fileIds)
  const attachmentPaths = await attachments.materialize(workerId, task.id, files)
  const prompt = sessionPrompt({
    prompt: task.prompt,
    branch: task.branch,
    baseBranch: task.baseBranch,
    projectInstructions: project.taskAgentInstructions,
    attachments: attachmentPaths,
  })
  // The timeline records the human's bare request; the harness is fed the prompt + preamble.
  const session = await startAgentSession(
    task.id,
    workerId,
    protocol,
    prompt,
    task.prompt,
    {
      command: sessionCommand(task.id, prompt, project.taskAgentCommand, protocol, task.model),
      cwd: paths[0],
      env: taskCommandEnv(task),
      timeoutMs: SESSION_TIMEOUT_MS,
      label: "Agent session",
    },
    files.map(attachments.serializeFile),
  )

  const startedAt = new Date()
  // Guarded on `queued`: a Drop that landed during the launch wins, and its kill finds the row.
  const { changes } = db
    .update(tasks)
    .set({ commandId: session.id, state: "running", startedAt, lastActivityAt: startedAt })
    .where(and(eq(tasks.id, task.id), eq(tasks.state, "queued")))
    .run()
  if (changes === 0) await commands.cancelTaskCommand(session).catch(() => {})
  else console.log(`[task:${task.id}] agent session ${session.id} started on ${task.branch}`)
}

/**
 * Launch a harness and hand it the human's turn through whichever door its protocol reads: a
 * heredoc already baked into the command (one-shot), or the live stdin written right after.
 * `stdinText` is what the harness reads; `recordedText` is what the timeline shows.
 */
async function startAgentSession(
  taskId: string,
  workerId: string,
  protocol: AgentProtocol,
  stdinText: string,
  recordedText: string,
  input: Omit<commands.RunInput, "stdin">,
  recordedFiles: StoredFile[] = [],
): Promise<TaskCommand> {
  const session = await commands.startTaskCommand(taskId, workerId, { ...input, stdin: isInteractive(protocol) })
  recordUserTurn(taskId, session.id, protocol, recordedText, recordedFiles)
  if (isInteractive(protocol)) await commands.writeTaskStdin(session, userTurnLine(protocol, stdinText))
  return session
}

/** Put what the human said into the timeline — a harness does not echo its stdin. */
function recordUserTurn(taskId: string, commandId: string, protocol: AgentProtocol, text: string, files: StoredFile[] = []): void {
  if (protocol === "none") return
  try {
    events.appendPlatformEvent(taskId, commandId, "message", { role: "user", text, ...(files.length > 0 ? { files } : {}) })
  } catch (err) {
    console.warn(`[task:${taskId}] could not record the user's turn: ${err}`)
  }
}

/**
 * A worker for the task: a free one from the project's pool if there is one (started if it was
 * stopped — seconds, against an image build and a clone), else a fresh one, tagged into the pool.
 */
async function allocateWorker(task: Task): Promise<{ workerId: string; recycled: boolean }> {
  const free = await findFreePoolWorker(task.projectId)
  if (free) return { workerId: free, recycled: true }
  const worker = spawnWorker(task.projectId, taskWorkerName(task.id), task.baseBranch ?? undefined)
  setWorkerTags(worker.id, [TASK_POOL_TAG])
  return { workerId: worker.id, recycled: false }
}

/**
 * "Free" = tagged `task`, and held by no task that is queued, running **or in review**: a task
 * owns its machine until it is terminal, or the next `checkout -B` would wipe what is being
 * reviewed. The holders are refreshed first — allocation needs the truth, not the last read.
 */
export async function findFreePoolWorker(projectId: string): Promise<string | null> {
  const pool = db
    .select()
    .from(workers)
    .where(and(eq(workers.projectId, projectId), inArray(workers.state, ["ready", "stopped"])))
    .all()
    .filter((w) => (w.tags ?? []).includes(TASK_POOL_TAG))
  if (pool.length === 0) return null
  const poolIds = new Set(pool.map((w) => w.id))
  const holders = db
    .select()
    .from(tasks)
    .where(and(inArray(tasks.state, ["queued", "running", "in-review"]), isNotNull(tasks.workerId)))
    .all()
  const refreshed = await Promise.all(holders.map((t) => (poolIds.has(t.workerId!) ? refreshTask(t).catch(() => t) : Promise.resolve(t))))
  const busy = new Set(refreshed.filter((t) => isLive(t.state)).map((t) => t.workerId))
  const free = pool.filter((w) => !busy.has(w.id))

  const ready = free.find((w) => w.state === "ready")
  if (ready) return ready.id
  const stopped = free.find((w) => w.state === "stopped" && w.containerId)
  if (!stopped) return null
  console.log(`[tasks] starting stopped pool worker ${stopped.id} instead of spawning a new one`)
  await startWorker(stopped.id)
  return stopped.id
}

/** Lite derives a worker's state on read, so waiting means reading. */
async function waitForWorkerReady(workerId: string): Promise<void> {
  const deadline = Date.now() + WORKER_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    const worker = await getWorkerLive(workerId)
    if (!worker) throw new Error(`Worker ${workerId} disappeared while starting`)
    if (worker.state === "ready") return
    if (worker.state === "error") {
      throw new Error(`Worker ${workerId} failed to start${worker.setupStatus?.error ? `: ${worker.setupStatus.error}` : worker.error ? `: ${worker.error}` : ""}`)
    }
    await new Promise((r) => setTimeout(r, WORKER_READY_POLL_MS))
  }
  throw new Error(`Worker ${workerId} did not become ready in time`)
}

/** Restart a machine that review mode `stop` parked, and wait for it. */
async function wakeWorker(workerId: string): Promise<void> {
  const worker = await getWorkerLive(workerId)
  if (!worker) throw new Error(`Worker ${workerId} no longer exists`)
  if (worker.state === "stopped") {
    await startWorker(workerId)
  }
  await waitForWorkerReady(workerId)
}

/** `SPUNTO_TASK_*` + the project's secrets as they are *now* — the container's own env dates from its spawn. */
function taskCommandEnv(row: Task, sessionStatus?: string): Record<string, string> {
  let secrets: Record<string, string> = {}
  try {
    secrets = resolveSecretsForSpawn(row.projectId)
  } catch (err) {
    console.warn(`[task:${row.id}] could not resolve secrets: ${err}`)
  }
  return {
    ...secrets,
    // Last: the platform's variables are part of the contract, a same-named secret must not lie.
    SPUNTO_TASK_ID: row.id,
    SPUNTO_TASK_TITLE: row.title,
    SPUNTO_TASK_BRANCH: row.branch,
    SPUNTO_TASK_BASE_BRANCH: row.baseBranch ?? "",
    ...(row.model ? { SPUNTO_TASK_MODEL: row.model } : {}),
    SPUNTO_TASK_STATE: row.state,
    ...(sessionStatus ? { SPUNTO_TASK_SESSION_STATUS: sessionStatus } : {}),
  }
}

// ─── Read paths: derive, don't poll ───────────────────────────────────────────

export type TaskQuery = { states?: TaskState[]; query?: string; projectId?: string; limit?: number; offset?: number }

/**
 * Every task of the install, filtered and paged — what the agent cockpit reads. Only the returned
 * page's live rows are refreshed; the counts ignore the state filter on purpose (a filter you
 * cannot see out of is a trap). Most recently active first, like a conversation list.
 */
export async function listAllTasks(q: TaskQuery = {}) {
  const limit = Math.min(100, Math.max(1, q.limit ?? 40))
  const offset = Math.max(0, q.offset ?? 0)
  const filters = []
  if (q.projectId) filters.push(eq(tasks.projectId, q.projectId))
  // `LIKE` is case-insensitive for ASCII in SQLite — what a search box needs. `%`/`_` are escaped.
  if (q.query?.trim()) {
    const pattern = `%${q.query.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    filters.push(sql`${tasks.title} LIKE ${pattern} ESCAPE '\\'`)
  }
  const scoped = filters.length > 0 ? and(...filters) : undefined

  const counts = Object.fromEntries(TASK_STATES.map((s) => [s, 0])) as Record<TaskState, number>
  const countRows = db
    .select({ state: tasks.state, n: sql<number>`count(*)` })
    .from(tasks)
    .where(scoped)
    .groupBy(tasks.state)
    .all()
  for (const r of countRows) counts[r.state as TaskState] = Number(r.n)
  const total = q.states?.length ? q.states.reduce((sum, s) => sum + counts[s], 0) : Object.values(counts).reduce((a, b) => a + b, 0)

  const where = q.states?.length ? (scoped ? and(scoped, inArray(tasks.state, q.states)) : inArray(tasks.state, q.states)) : scoped
  const rows = db
    .select({ task: tasks, projectName: projects.name })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(where)
    .orderBy(desc(tasks.lastActivityAt), desc(tasks.createdAt))
    .limit(limit)
    .offset(offset)
    .all()
  const page = await Promise.all(
    rows.map(async (r) => ({
      ...serializeTask(isLive(r.task.state) ? await refreshTask(r.task).catch(() => r.task) : r.task),
      projectName: r.projectName,
    })),
  )
  return { tasks: page, total, counts }
}

export async function listProjectTasks(projectId: string, limit = 100): Promise<Task[]> {
  const rows = db
    .select()
    .from(tasks)
    .where(eq(tasks.projectId, projectId))
    .orderBy(desc(tasks.lastActivityAt), desc(tasks.createdAt))
    .limit(Math.min(200, Math.max(1, limit)))
    .all()
  return Promise.all(rows.map((row) => (isLive(row.state) ? refreshTask(row).catch(() => row) : Promise.resolve(row))))
}

export async function getTask(taskId: string): Promise<Task | undefined> {
  const row = getRawTask(taskId)
  if (!row) return undefined
  return refreshTask(row).catch(() => row)
}

/**
 * Bring a task up to date from the one thing that knows: its agent session. `queued` belongs to
 * the run job, `done`/`failed` are terminal, and `in-review` only moves on a click — so only a
 * `running` task has anything to derive.
 */
async function refreshTask(row: Task): Promise<Task> {
  if (row.state !== "running") return row
  if (!row.workerId || !row.commandId) return row

  const cmd = commands.getTaskCommandRow(row.commandId)
  const session = cmd ? await commands.refreshTaskCommand(cmd).catch(() => cmd) : null
  const project = getProjectRow(row.projectId)
  const protocol = protocolOf(project)
  const patch: Partial<Task> = {}

  // An interactive session does not exit between turns, so only its stream says it handed back —
  // and only if someone reads it. Throttled: a read path, and each pass is a `docker exec`.
  if (isInteractive(protocol) && row.state === "running" && session?.status === "running") {
    const since = Date.now() - (lastLiveIngest.get(row.id) ?? 0)
    if (since >= LIVE_INGEST_MIN_INTERVAL_MS) {
      lastLiveIngest.set(row.id, Date.now())
      await events.ingestTaskEvents(row, protocol).catch((err) => console.warn(`[task:${row.id}] live ingestion failed: ${err}`))
    }
  }
  patch.lastRefreshedAt = new Date()

  const state: TaskState = session ? sessionState(row, protocol, session) : (row.state as TaskState)
  if (state !== row.state) {
    lastLiveIngest.delete(row.id)
    patch.state = state
    patch.lastActivityAt = patch.lastRefreshedAt
  }
  if (state === "failed" && !row.error && session) {
    const output = (session.stderr || session.stdout || "").trim().slice(-500)
    patch.error = `Agent session ${session.status}${session.exitCode != null ? ` (exit ${session.exitCode})` : ""}${output ? `: ${output}` : ""}`
  }
  if (state === "failed" && !row.completedAt) patch.completedAt = new Date()

  // The session just stopped: pull whatever it wrote since the last read — the one ingestion
  // nobody has to be watching for, and the last chance before review mode `stop` parks the worker.
  if (row.state === "running" && session && session.status !== "running") {
    await events.ingestTaskEvents(row, protocol).catch((err) => console.warn(`[task:${row.id}] final event ingestion failed: ${err}`))
  }

  // Guarded on the state we read: an Accept or a Drop that landed meanwhile must not be undone.
  const { changes } = db
    .update(tasks)
    .set(patch)
    .where(and(eq(tasks.id, row.id), eq(tasks.state, row.state)))
    .run()
  if (changes === 0) return getRawTask(row.id) ?? row

  // Entering review settles the machine — stopped, or left running. Never awaited by the read.
  if (patch.state === "in-review") void settleTask(row.id)
  const fresh = { ...row, ...patch }
  // The ingestion above may have renamed the task (the session named itself).
  const now = getRawTask(row.id)
  return now ? { ...fresh, title: now.title, autoTitle: now.autoTitle, eventsSeq: now.eventsSeq } : fresh
}

/**
 * One-shot harness: the process exiting *is* the end of the turn. Interactive: a live process
 * means nothing on its own — `session.ended` in the stream is the hand-back signal.
 */
function sessionState(row: Task, protocol: AgentProtocol, session: { status: string }): TaskState {
  if (session.status !== "running") return deriveState(session)
  if (!isInteractive(protocol)) return "running"
  return events.lastEventType(row.id) === "session.ended" ? "in-review" : "running"
}

/** Review mode `stop` parks the machine as the task enters review; `keep` leaves it up. Idempotent. */
async function settleTask(taskId: string): Promise<void> {
  try {
    const task = getRawTask(taskId)
    if (!task?.workerId || task.state !== "in-review") return
    const project = getProjectRow(task.projectId)
    if (project?.taskReviewMode !== "stop") return
    const worker = await getWorkerLive(task.workerId)
    if (!worker || worker.state !== "ready") return
    console.log(`[task:${taskId}] entering review — stopping worker ${task.workerId} (state kept on disk)`)
    await stopWorker(task.workerId)
  } catch (err) {
    console.warn(`[task:${taskId}] could not settle its worker: ${err}`)
  }
}

// ─── The background floor ─────────────────────────────────────────────────────

const REFRESH_FLOOR_MS = 30_000
const SCHEDULER_TICK_MS = 10_000
const MAX_REFRESH_PER_TICK = 25
let schedulerTimer: ReturnType<typeof setInterval> | null = null

/**
 * Re-derive every `running` task nobody has looked at for 30 s. With the dashboard open, reads
 * keep them fresh and nothing comes due; closed, this is what still parks a `stop` worker when
 * its session ends, and what frees a pool machine for the next task.
 */
export async function refreshDueTasks(now = Date.now()): Promise<number> {
  const due = db
    .select()
    .from(tasks)
    .where(eq(tasks.state, "running"))
    .all()
    .filter((t) => !t.lastRefreshedAt || now - t.lastRefreshedAt.getTime() >= REFRESH_FLOOR_MS)
    .slice(0, MAX_REFRESH_PER_TICK)
  await Promise.all(due.map((t) => refreshTask(t).catch((err) => console.warn(`[task:${t.id}] background refresh failed: ${err}`))))
  return due.length
}

/**
 * What a restart interrupted. Lite's jobs live in this process, so one that was mid-flight when
 * it stopped will never finish — and its task would say "Accepting…" or "queued" for ever. Said
 * on the task instead:
 *
 *  - a task still `queued` lost its run (allocation, branch, launch) → failed, with the reason;
 *  - an in-flight Accept, reply or Drop is cleared — Drop is finished (the reader asked for it to
 *    be over), the other two leave the task where it was, with a note.
 *
 * The agent session itself is **not** affected: it is a process in the worker, not in here.
 */
export function recoverInterruptedTasks(): void {
  const now = new Date()
  const cleared = { pendingAction: null, pendingSince: null }
  const queued = db
    .update(tasks)
    .set({ state: "failed", error: "Spunto Lite restarted while this task was starting — delegate it again.", completedAt: now, lastActivityAt: now, ...cleared })
    .where(eq(tasks.state, "queued"))
    .run()
  const dropping = db
    .update(tasks)
    .set({ state: "failed", error: "Cancelled", completedAt: now, lastActivityAt: now, ...cleared })
    .where(and(eq(tasks.pendingAction, "dropping"), inArray(tasks.state, ["running", "in-review"])))
    .run()
  const other = db
    .update(tasks)
    .set({ error: "Spunto Lite restarted while this action was in flight — try again.", ...cleared })
    .where(isNotNull(tasks.pendingAction))
    .run()
  const n = queued.changes + dropping.changes + other.changes
  if (n > 0) console.log(`[tasks] recovered ${n} task(s) interrupted by the restart`)
}

/** Called once at boot (server.ts). */
export function startTaskScheduler(intervalMs = SCHEDULER_TICK_MS): void {
  if (schedulerTimer) return
  recoverInterruptedTasks()
  const tick = () => void refreshDueTasks().catch((err) => console.error("[tasks] background refresh tick failed:", err))
  schedulerTimer = setInterval(tick, intervalMs)
  schedulerTimer.unref?.()
  tick()
}

// ─── Actions ──────────────────────────────────────────────────────────────────

async function requireTask(taskId: string, allowed: TaskState[]): Promise<Task> {
  const task = await getTask(taskId)
  if (!task) throw new TaskActionError("Not found", 404)
  if (!allowed.includes(task.state as TaskState)) {
    throw new TaskActionError(`Task is ${task.state} — expected ${allowed.join(" or ")}`, 409)
  }
  return task
}

/**
 * Mark an action in flight, refusing a second copy of the same one (two clicks, two tabs). Only
 * the *same* action is refused: dropping a task whose accept is stuck is a legitimate way out.
 */
function claimPending(taskId: string, action: TaskPendingAction): Task {
  const { changes } = db
    .update(tasks)
    .set({ pendingAction: action, pendingSince: new Date() })
    .where(and(eq(tasks.id, taskId), sql`${tasks.pendingAction} IS NOT ${action}`))
    .run()
  const row = getRawTask(taskId)!
  if (changes === 0) throw new TaskActionError(`Already ${action} this task — asked for at ${row.pendingSince?.toISOString()}`, 409)
  return row
}

function clearPending(taskId: string, action: TaskPendingAction): void {
  db.update(tasks)
    .set({ pendingAction: null, pendingSince: null })
    .where(and(eq(tasks.id, taskId), eq(tasks.pendingAction, action)))
    .run()
}

/** Run one of the project's commands in the task's own worker, woken first if it was parked. */
async function runTaskAction(task: Task, command: string, kind: "validate" | "cancel"): Promise<{ exitCode: number | null; output: string }> {
  if (!task.workerId) throw new Error(`Task ${task.id} has no worker to run its ${kind} command in`)
  await wakeWorker(task.workerId)
  const project = projectOf(task)
  const result = await commands.runTaskCommand(task.id, task.workerId, {
    command,
    cwd: repoPaths(project)[0],
    env: taskCommandEnv(task),
    timeoutMs: 15 * 60 * 1000,
    label: kind === "validate" ? "Accept command" : "Drop command",
  })
  return { exitCode: result.exitCode, output: `${result.stdout ?? ""}${result.stderr ?? ""}` }
}

/**
 * Accept — the only way a task reaches `done`. What accepting *does* is the project's
 * (`taskValidateCommand`: a merge, a deploy); without one, the decision is the whole thing.
 */
export async function validateTask(taskId: string): Promise<Task> {
  await requireTask(taskId, ["in-review"])
  const claimed = claimPending(taskId, "accepting")
  void runJob(
    taskId,
    "accept",
    async () => {
      try {
        const task = getRawTask(taskId)
        if (!task || task.state !== "in-review") return
        const command = getProjectRow(task.projectId)?.taskValidateCommand?.trim()
        const result = command ? await runTaskAction(task, command, "validate") : { exitCode: 0, output: "" }
        const now = new Date()
        if (result.exitCode === 0) {
          db.update(tasks).set({ state: "done", completedAt: now, lastActivityAt: now, error: null }).where(and(eq(tasks.id, taskId), eq(tasks.state, "in-review"))).run()
        } else {
          db.update(tasks).set({ error: `Accept failed (exit ${result.exitCode}): ${result.output.slice(-500)}`, lastActivityAt: now }).where(eq(tasks.id, taskId)).run()
        }
      } finally {
        clearPending(taskId, "accepting")
      }
    },
    (error) => {
      db.update(tasks).set({ error: `Accept failed: ${error}`.slice(0, 2000), lastActivityAt: new Date() }).where(and(eq(tasks.id, taskId), eq(tasks.state, "in-review"))).run()
    },
  )
  return claimed
}

/**
 * Drop: kill the session first (cleanup must not race an agent still committing), run the
 * project's cleanup if any, and fail the task with the reason — "cancelled" is not a sixth state.
 */
export async function cancelTask(taskId: string): Promise<Task> {
  await requireTask(taskId, ["queued", "running", "in-review"])
  const claimed = claimPending(taskId, "dropping")
  void runJob(
    taskId,
    "drop",
    async () => {
      try {
        const task = getRawTask(taskId)
        if (!task || !isLive(task.state)) return
        const session = task.commandId ? commands.getTaskCommandRow(task.commandId) : undefined
        if (session) await commands.cancelTaskCommand(session).catch((err) => console.warn(`[task:${taskId}] could not cancel the session: ${err}`))
        const command = getProjectRow(task.projectId)?.taskCancelCommand?.trim()
        let note = "Cancelled"
        if (command && task.workerId) {
          try {
            const result = await runTaskAction(task, command, "cancel")
            if (result.exitCode !== 0) note = `Cancelled — cleanup failed (exit ${result.exitCode}): ${result.output.slice(-300)}`
          } catch (err) {
            note = `Cancelled — cleanup could not run: ${(err as Error).message}`
          }
        }
        failTask(taskId, note)
      } finally {
        clearPending(taskId, "dropping")
      }
    },
    // The reader asked for it to be over; a live task with a silent error would block the pool.
    (error) => failTask(taskId, `Cancelled — the drop failed: ${error}`),
  )
  return claimed
}

/** Name a task by hand, in any state. Final: the session no longer renames it. The branch stays. */
export async function renameTask(taskId: string, title: string): Promise<Task | undefined> {
  const { changes } = db.update(tasks).set({ title, autoTitle: false }).where(eq(tasks.id, taskId)).run()
  if (changes === 0) return undefined
  return getTask(taskId)
}

async function isSessionAlive(task: Task): Promise<TaskCommand | null> {
  if (!task.workerId || !task.commandId) return null
  // A parked machine (review mode `stop`) cannot be asked, so its command row still says what it
  // said before the stop — but nothing is running in a stopped container, whatever the row says.
  const worker = await getWorkerLive(task.workerId)
  if (worker?.state !== "ready") return null
  const row = commands.getTaskCommandRow(task.commandId)
  if (!row) return null
  const fresh = await commands.refreshTaskCommand(row).catch(() => row)
  return fresh.status === "running" && fresh.mode === "background" ? fresh : null
}

/**
 * Answer the agent. Interactive and still alive: one write into its stdin, no job, no resume —
 * the session holding the context gets it, even mid-turn. Otherwise a new turn resumes the
 * session on the same branch in the same worker (woken first if parked).
 */
export async function followUpTask(taskId: string, prompt: string, files: InlineFile[] = []): Promise<Task> {
  const current = getRawTask(taskId)
  if (!current) throw new TaskActionError("Not found", 404)
  const project = getProjectRow(current.projectId)
  const protocol = protocolOf(project)
  const allowed: TaskState[] = isInteractive(protocol) ? ["running", "in-review"] : ["in-review"]
  const task = await requireTask(taskId, allowed)
  if (!task.workerId) throw new TaskActionError("This task has no worker to continue in", 409)

  const live = isInteractive(protocol) ? await isSessionAlive(task) : null
  if (live) {
    const stored = attachments.storeFiles(task.id, live.id, "user", files)
    const paths = await attachments.materialize(task.workerId, task.id, attachments.attachmentsByIds(task.id, stored.map((f) => f.id)))
    recordUserTurn(task.id, live.id, protocol, prompt, stored)
    await commands.writeTaskStdin(live, userTurnLine(protocol, `${prompt}${attachments.attachmentPreamble(paths)}`))
    if (task.state !== "running") {
      db.update(tasks).set({ state: "running", error: null, completedAt: null, lastActivityAt: new Date() }).where(eq(tasks.id, taskId)).run()
    }
    return { ...getRawTask(taskId)!, state: "running" }
  }

  if (task.state !== "in-review") throw new TaskActionError("The session is not listening right now — wait for it to hand back", 409)
  if (!project?.taskFollowUpCommand?.trim() && !events.latestSessionId(taskId)) {
    throw new TaskActionError(
      "Nothing to resume: this task has no captured session id. Set the project's Session stream to a harness Spunto can read (so it learns the id), or configure a follow-up command of your own.",
      400,
    )
  }
  const claimed = claimPending(taskId, "replying")
  const stored = attachments.storeFiles(taskId, null, "user", files)
  void runJob(
    taskId,
    "follow-up",
    async () => {
      try {
        const row = getRawTask(taskId)
        if (!row?.workerId || row.state !== "in-review") return
        const proj = projectOf(row)
        await wakeWorker(row.workerId)
        // Drain the finished turn before the cursor moves to the next command's file.
        await events.ingestTaskEvents(row, protocol).catch(() => 0)
        const paths = await attachments.materialize(row.workerId, taskId, attachments.attachmentsByIds(taskId, stored.map((f) => f.id)))
        const sessionId = events.latestSessionId(taskId) ?? ""
        const turn = `${prompt}${attachments.attachmentPreamble(paths)}`
        const session = await startAgentSession(
          taskId,
          row.workerId,
          protocol,
          turn,
          prompt,
          {
            command: sessionCommand(taskId, turn, proj.taskFollowUpCommand?.trim() || DEFAULT_FOLLOW_UP_COMMAND, protocol, row.model),
            cwd: repoPaths(proj)[0],
            env: { ...taskCommandEnv(row), SPUNTO_TASK_SESSION_ID: sessionId },
            timeoutMs: SESSION_TIMEOUT_MS,
            label: "Follow-up",
          },
          stored,
        )
        db.update(tasks)
          .set({ commandId: session.id, state: "running", error: null, completedAt: null, lastActivityAt: new Date() })
          .where(and(eq(tasks.id, taskId), eq(tasks.state, "in-review")))
          .run()
      } finally {
        clearPending(taskId, "replying")
      }
    },
    // Left in review: the work to judge is still there, only the extra turn broke.
    (error) => {
      db.update(tasks).set({ error: `Follow-up failed: ${error}`.slice(0, 2000), lastActivityAt: new Date() }).where(eq(tasks.id, taskId)).run()
    },
  )
  return claimed
}

/**
 * Stop the current turn without killing the session — a `control_request/interrupt` on its stdin.
 * The harness ends the turn and keeps listening; Drop is the one that kills.
 */
export async function interruptTask(taskId: string): Promise<Task> {
  const current = getRawTask(taskId)
  if (!current) throw new TaskActionError("Not found", 404)
  const protocol = protocolOf(getProjectRow(current.projectId))
  const line = interruptLine(protocol, `spunto-${Date.now()}`)
  if (!line) {
    throw new TaskActionError(
      "This project's session cannot be interrupted: it runs a one-shot harness, whose stdin closed with the prompt. Use Drop to stop the task entirely.",
      400,
    )
  }
  const task = await requireTask(taskId, ["running"])
  const live = await isSessionAlive(task)
  if (!live) throw new TaskActionError("The session is not running", 409)
  await commands.writeTaskStdin(live, line)
  return task
}

/** Delete a task and its history. The worker stays — it belongs to the pool. */
export function deleteTask(taskId: string): boolean {
  const task = getRawTask(taskId)
  if (!task) return false
  if (isLive(task.state)) throw new TaskActionError("Drop the task before deleting it", 409)
  db.delete(tasks).where(eq(tasks.id, taskId)).run()
  return true
}

/** Which tasks hold which workers — for the worker cards' "task" chip. Live tasks only. */
export function liveTasksByWorker(projectId: string): { id: string; title: string; state: string; workerId: string }[] {
  return db
    .select({ id: tasks.id, title: tasks.title, state: tasks.state, workerId: tasks.workerId })
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), inArray(tasks.state, ["queued", "running", "in-review"]), isNotNull(tasks.workerId)))
    .all() as { id: string; title: string; state: string; workerId: string }[]
}
