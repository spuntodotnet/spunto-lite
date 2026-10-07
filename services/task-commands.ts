import { and, asc, desc, eq } from "drizzle-orm"
import { db } from "../db/index"
import { taskCommands, workers, type TaskCommand } from "../db/schema"
import { newId } from "../lib/id"
import * as wc from "../lib/worker-commands"

/**
 * What the platform ran in a worker for a task, written down — "Branch setup", "Agent session",
 * "Accept command" — so the cockpit can tell the task's story (docs/tasks.md § "Ce que la
 * plateforme a lancé").
 *
 * A foreground command is recorded once it returns. A background one is recorded at launch and
 * **reconciled lazily** from the worker when it is read, like everything else a task derives:
 * the process lives in the container, and a Lite restart loses nothing but a poll.
 */

export type RunInput = {
  command: string
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  label: string
  /** A live stdin (FIFO), for an interactive harness. Background only. */
  stdin?: boolean
}

function statusOf(result: { exitCode: number | null; timedOut: boolean }): string {
  if (result.timedOut) return "timeout"
  if (result.exitCode === 0) return "succeeded"
  if (result.exitCode === 143) return "canceled"
  return "failed"
}

function containerOf(workerId: string): string {
  const w = db.select({ containerId: workers.containerId }).from(workers).where(eq(workers.id, workerId)).get()
  if (!w?.containerId) throw new Error(`Worker ${workerId} has no container`)
  return w.containerId
}

/** Run and wait, then record. The row is written even when the command fails — that is the point. */
export async function runTaskCommand(taskId: string, workerId: string, input: RunInput): Promise<TaskCommand> {
  const id = newId()
  const createdAt = new Date()
  let row: TaskCommand
  try {
    const result = await wc.runCommand({
      containerId: containerOf(workerId),
      command: input.command,
      cwd: input.cwd,
      env: input.env,
      timeoutMs: input.timeoutMs,
    })
    row = {
      id,
      taskId,
      workerId,
      label: input.label,
      command: input.command,
      cwd: input.cwd ?? null,
      mode: "sync",
      status: statusOf(result),
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: result.truncated,
      createdAt,
      finishedAt: new Date(),
    }
  } catch (err) {
    row = {
      id,
      taskId,
      workerId,
      label: input.label,
      command: input.command,
      cwd: input.cwd ?? null,
      mode: "sync",
      status: "failed",
      exitCode: null,
      stdout: "",
      stderr: (err as Error).message,
      truncated: false,
      createdAt,
      finishedAt: new Date(),
    }
  }
  db.insert(taskCommands).values(row).run()
  return row
}

/** Launch detached, record as `running`. Throws when the launch itself failed — nothing is running then. */
export async function startTaskCommand(taskId: string, workerId: string, input: RunInput): Promise<TaskCommand> {
  const id = newId()
  await wc.startCommand({
    containerId: containerOf(workerId),
    commandId: id,
    command: input.command,
    cwd: input.cwd,
    env: input.env,
    timeoutMs: input.timeoutMs,
    stdin: input.stdin,
  })
  const row: TaskCommand = {
    id,
    taskId,
    workerId,
    label: input.label,
    command: input.command,
    cwd: input.cwd ?? null,
    mode: "background",
    status: "running",
    exitCode: null,
    stdout: null,
    stderr: null,
    truncated: false,
    createdAt: new Date(),
    finishedAt: null,
  }
  db.insert(taskCommands).values(row).run()
  return row
}

export function getTaskCommandRow(id: string): TaskCommand | undefined {
  return db.select().from(taskCommands).where(eq(taskCommands.id, id)).get()
}

/**
 * A background command, brought up to date from the worker. Only a `running` row costs a round
 * trip; a finished one is final. A worker that cannot be asked (stopped, gone) leaves the row as
 * it was — except when the container is gone for good, where the process is too: `lost`.
 */
export async function refreshTaskCommand(row: TaskCommand): Promise<TaskCommand> {
  if (row.mode !== "background" || row.status !== "running" || !row.workerId) return row
  const worker = db.select().from(workers).where(eq(workers.id, row.workerId)).get()
  if (!worker?.containerId) {
    const lost = { ...row, status: "lost", finishedAt: new Date() }
    db.update(taskCommands).set({ status: lost.status, finishedAt: lost.finishedAt }).where(eq(taskCommands.id, row.id)).run()
    return lost
  }
  // A parked worker (review mode `stop`) cannot answer, and its process is not running either —
  // but the session may have ended cleanly before the stop. Asked again once it is back up.
  if (worker.state !== "ready") return row

  let status: wc.CommandStatus
  try {
    status = await wc.pollCommand({ containerId: worker.containerId, commandId: row.id })
  } catch {
    return row
  }
  const patch: Partial<TaskCommand> = { stdout: status.stdout, stderr: status.stderr, truncated: status.truncated }
  if (!status.found) {
    patch.status = "lost"
    patch.finishedAt = new Date()
  } else if (!status.running) {
    // No exit code and no process: the wrapper died without writing one (the container restarted).
    patch.status = status.exitCode === null ? "lost" : statusOf(status)
    patch.exitCode = status.exitCode
    patch.finishedAt = new Date()
  }
  // Guarded on `running` so two concurrent readers write the same final answer at most once.
  db.update(taskCommands)
    .set(patch)
    .where(and(eq(taskCommands.id, row.id), eq(taskCommands.status, "running")))
    .run()
  return { ...row, ...patch }
}

/** The latest command of a task under a label ("Agent session", "Follow-up"…), if there is one. */
export function findTaskCommand(taskId: string, label: string): TaskCommand | undefined {
  return db
    .select()
    .from(taskCommands)
    .where(and(eq(taskCommands.taskId, taskId), eq(taskCommands.label, label)))
    .orderBy(desc(taskCommands.createdAt))
    .get()
}

/** Every command of a task, oldest first — the order it happened in. */
export async function listTaskCommands(taskId: string): Promise<TaskCommand[]> {
  const rows = db.select().from(taskCommands).where(eq(taskCommands.taskId, taskId)).orderBy(asc(taskCommands.createdAt)).all()
  return Promise.all(rows.map((r) => refreshTaskCommand(r).catch(() => r)))
}

export async function writeTaskStdin(row: TaskCommand, data: string): Promise<boolean> {
  if (!row.workerId) return false
  return wc.writeCommandStdin({ containerId: containerOf(row.workerId), commandId: row.id, data })
}

export async function cancelTaskCommand(row: TaskCommand): Promise<void> {
  if (!row.workerId || row.mode !== "background") return
  const worker = db.select().from(workers).where(eq(workers.id, row.workerId)).get()
  if (!worker?.containerId || worker.state !== "ready") return
  await wc.cancelCommand({ containerId: worker.containerId, commandId: row.id })
  db.update(taskCommands)
    .set({ status: "canceled", exitCode: 143, finishedAt: new Date() })
    .where(and(eq(taskCommands.id, row.id), eq(taskCommands.status, "running")))
    .run()
}
