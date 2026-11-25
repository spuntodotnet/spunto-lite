import { asc, eq } from "drizzle-orm"
import { z } from "zod"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { db } from "../db/index"
import { tasks, type Task } from "../db/schema"
import { getProjectRow } from "./projects"
import { taskDiff, taskFilePatch } from "./task-diff"
import * as service from "./tasks"

/**
 * `spunto-tasks` — the MCP server a task's own session reaches to delegate sub-tasks and follow
 * them (docs/taches.md § « Sous-tâches »), Cloud's `task-subtasks.mcp.ts`. Served at
 * `/api/task-mcp`, offered in `SPUNTO_AGENT_MCP` to every session.
 *
 * **Scoped by the task.** The caller shows its session's gateway token (`SPUNTO_WORKER_TOKEN`,
 * minted for one task at session start, like the MCP gateway's); that task is the parent, and the
 * tools reach **its children and nothing else** — no other task, not even a sibling.
 *
 * Stateless (one server per request): nothing to keep between two calls of a session.
 */

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean }

const json = (data: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] })

/** An error is an answer the agent reads and acts on, not a protocol failure. */
function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  return fn().catch((err: unknown) => ({
    content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
    isError: true,
  }))
}

/** Where a human opens it — a path of this Lite: it does not know the address it is reached at. */
const taskPath = (t: Pick<Task, "id">) => `/agents?task=${t.id}`

/** A sub-task as the parent's session reads it: where the work stands, not the whole row. */
function summary(t: Task) {
  return {
    id: t.id,
    projectId: t.projectId,
    title: t.title,
    state: t.state,
    error: t.error,
    agentAppId: t.agentAppId,
    model: t.model,
    createdAt: t.createdAt,
    lastActivityAt: t.lastActivityAt,
    path: taskPath(t),
  }
}

/** What the REST route answers with a `TaskActionError` (409 « Task is running… »), said to the agent. */
async function act<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof service.TaskActionError) throw new Error(err.message)
    throw err
  }
}

const taskIdInput = { taskId: z.string().describe("The sub-task's id (from create_subtask or list_subtasks).") }

export const SUBTASKS_INSTRUCTIONS = (parent: Pick<Task, "id" | "title">) =>
  `You are Spunto task ${parent.id} (« ${parent.title} »). ` +
  "You can delegate parts of your work to sub-tasks — each one a worker with its own agent — and steer them to the end: " +
  "`create_subtask` to start one; you do not need to poll it — when it hands back (`in-review`) or fails, Spunto sends you a message " +
  "starting with `[Spunto] Sub-task`, like a reply in this conversation. Then read its report (`get_subtask`) and its changes " +
  "(`get_subtask_diff`), and decide: `validate_subtask` to accept its work (it ends `done`), `message_subtask` to answer or correct it, " +
  "`cancel_subtask` to drop it. `interrupt_subtask` stops a turn going the wrong way, `retry_subtask` restarts one that failed before it got going. " +
  "If you have nothing else to do while sub-tasks run, end your turn: their messages will wake you. " +
  "Sub-tasks cost a machine each: delegate work that is worth running in parallel, not every step."

export function subtasksServer(parent: Task): McpServer {
  const server = new McpServer({ name: "spunto-tasks", version: "1.0.0" }, { instructions: SUBTASKS_INSTRUCTIONS(parent) })

  /** One of the parent's children, refreshed — or an error naming what is reachable. */
  async function child(taskId: string): Promise<Task> {
    const row = service.getRawTask(taskId)
    if (!row || row.parentTaskId !== parent.id) throw new Error(`No sub-task ${taskId} under this task — list_subtasks gives the ids of yours`)
    return (await service.getTask(row.id)) ?? row
  }

  /** After an action: the sub-task as it now stands, with the action it is waiting on (`accepting`, `dropping`…). */
  function after(t: Task, note: string) {
    const now = service.getRawTask(t.id) ?? t
    return json({ ...summary(now), pendingAction: now.pendingAction ?? null, note })
  }

  server.registerTool(
    "create_subtask",
    {
      title: "Delegate a sub-task",
      description:
        "Start another task — a worker and an agent session of its own — to work on part of yours in parallel. " +
        "It runs under the project's harness and model unless you say otherwise, and appears under this task in Spunto Lite. " +
        "Returns at once with the sub-task `queued`. No need to poll it: when it hands back (`in-review`) or fails, " +
        "a message from Spunto arrives in this conversation. " +
        "Give it everything it needs in `prompt`: it does not see this conversation, nor this worker's files.",
      inputSchema: {
        prompt: z.string().min(1).max(50_000).describe("The instructions for the sub-task's agent — self-contained."),
        title: z.string().min(1).max(200).optional().describe("A one-line name. Omitted: it names itself."),
        projectId: z.string().optional().describe("Another project to run it in. Omitted: this task's own project."),
        agentAppId: z.string().optional().describe("Harness to run it under (one of the project's agent apps). Omitted: the project's default."),
        model: z.string().optional().describe("Model for its session. Omitted: the project's default for that harness."),
        baseBranch: z.string().optional().describe("Branch its worker starts from. Omitted: the repository's default."),
      },
    },
    async (input) =>
      guard(async () => {
        const projectId = input.projectId ?? parent.projectId
        if (!getProjectRow(projectId)) throw new Error(`No project ${projectId} in this Spunto Lite`)
        const created = await act(() =>
          service.createTask(projectId, {
            prompt: input.prompt,
            title: input.title,
            agentAppId: input.agentAppId,
            model: input.model,
            baseBranch: input.baseBranch,
            parentTaskId: parent.id,
          }),
        )
        return json(summary(created))
      }),
  )

  server.registerTool(
    "list_subtasks",
    {
      title: "List sub-tasks",
      description:
        "The sub-tasks this task delegated, oldest first, with where each stands: `queued` (waiting for its worker), `running`, " +
        "`in-review` (its agent finished its turn and handed back), `done` (accepted), `failed`.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      guard(async () => {
        const rows = db.select().from(tasks).where(eq(tasks.parentTaskId, parent.id)).orderBy(asc(tasks.createdAt)).all()
        const live = await Promise.all(rows.map((r) => (service.isLive(r.state) ? service.getTask(r.id).then((t) => t ?? r) : r)))
        return json(live.map(summary))
      }),
  )

  server.registerTool(
    "get_subtask",
    {
      title: "Read a sub-task",
      description:
        "Where one of your sub-tasks stands, and the last messages its agent wrote — its report once it is `in-review`. " +
        "No need to call it in a loop: Spunto messages you when a sub-task hands back or fails.",
      inputSchema: {
        ...taskIdInput,
        messages: z.number().int().min(1).max(20).optional().describe("How many of its agent's last messages to return. Default 1."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ taskId, messages }) =>
      guard(async () => {
        const t = await child(taskId)
        return json({ ...summary(t), lastMessages: service.lastAgentMessages(t.id, messages ?? 1) })
      }),
  )

  server.registerTool(
    "get_subtask_diff",
    {
      title: "Read what a sub-task changed",
      description:
        "What one of your sub-tasks changed in its repositories, read with git in its own worker: the files, compared from the " +
        "merge base with its base branch and including what it did not commit. Pass `path` for one file's patch. " +
        "`available: false` says why it cannot be read now (`machine-stopped`: its worker was parked for review).",
      inputSchema: {
        ...taskIdInput,
        path: z.string().min(1).max(4096).optional().describe("One file's patch instead of the list — its path relative to the repository, as the list gives it."),
        repo: z.string().max(255).optional().describe("With `path`: which repository, by its `name` in the list. Omitted: the project's first."),
        oldPath: z.string().max(4096).optional().describe("With `path`, for a renamed file: the path it had."),
        untracked: z.boolean().optional().describe("With `path`, for a file the list marks `untracked`."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ taskId, path, repo, oldPath, untracked }) =>
      guard(async () => {
        const t = await child(taskId)
        return json(path ? await taskFilePatch(t, { path, repo, oldPath, untracked: untracked ?? false }) : await taskDiff(t))
      }),
  )

  server.registerTool(
    "message_subtask",
    {
      title: "Answer a sub-task",
      description:
        "Send one of your sub-tasks a message — an answer to its question, a correction, the next step. " +
        "Its session picks it up like a reply from a human: at once if it is listening, or resumed if it is in review. " +
        "You are messaged again when it next hands back.",
      inputSchema: {
        ...taskIdInput,
        prompt: z.string().min(1).max(50_000).describe("What to tell it."),
      },
    },
    async ({ taskId, prompt }) =>
      guard(async () => {
        const t = await child(taskId)
        return json(summary(await act(() => service.followUpTask(t.id, prompt))))
      }),
  )

  server.registerTool(
    "validate_subtask",
    {
      title: "Accept a sub-task's work",
      description:
        "Accept one of your sub-tasks once it is `in-review` and its work is what you wanted — the same as Accept in Spunto Lite: " +
        "the project's accept command runs in its worker, then it is `done` and its worker goes back to the pool. " +
        "Answers at once with `pendingAction: \"accepting\"`; it is `done` a few seconds later (`get_subtask`). " +
        "If the accept command fails it stays `in-review`, with the failure in `error`. Read its report and diff first: accepting is final.",
      inputSchema: taskIdInput,
      annotations: { destructiveHint: true },
    },
    async ({ taskId }) =>
      guard(async () => {
        const t = await child(taskId)
        return after(await act(() => service.validateTask(t.id)), "Accepting — done once the project's accept command has run.")
      }),
  )

  server.registerTool(
    "cancel_subtask",
    {
      title: "Drop a sub-task",
      description:
        "Drop one of your sub-tasks — queued, running or in review — the same as Drop in Spunto Lite: its session is killed, the project's " +
        "drop command runs, and it ends `failed` (« Cancelled »). For work you no longer need; to change its course, `message_subtask` or " +
        "`interrupt_subtask` instead. You are not messaged about a sub-task you dropped yourself.",
      inputSchema: taskIdInput,
      annotations: { destructiveHint: true },
    },
    async ({ taskId }) =>
      guard(async () => {
        const t = await child(taskId)
        return after(await act(() => service.cancelTask(t.id, { byParent: true })), "Dropping — failed (« Cancelled ») in a few seconds.")
      }),
  )

  server.registerTool(
    "interrupt_subtask",
    {
      title: "Interrupt a sub-task's turn",
      description:
        "Stop what one of your `running` sub-tasks is doing without ending it: its agent abandons the turn it is on, keeps its context, " +
        "and waits — then `message_subtask` to set it on another course. Unlike `cancel_subtask`, nothing is lost.",
      inputSchema: taskIdInput,
    },
    async ({ taskId }) =>
      guard(async () => {
        const t = await child(taskId)
        return after(await act(() => service.interruptTask(t.id)), "Interrupt sent — it hands back once its agent has stopped.")
      }),
  )

  server.registerTool(
    "retry_subtask",
    {
      title: "Start a failed sub-task over",
      description:
        "Run a `failed` sub-task again from the top — same prompt, a fresh session — when it failed before its agent got going " +
        "(its worker could not start, its setup failed). One whose session ran is answered instead, with `message_subtask`.",
      inputSchema: taskIdInput,
    },
    async ({ taskId }) =>
      guard(async () => {
        const t = await child(taskId)
        return after(await act(() => service.retryTask(t.id)), "Queued again.")
      }),
  )

  return server
}
