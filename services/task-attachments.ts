import { createHash } from "node:crypto"
import { and, eq, inArray } from "drizzle-orm"
import { customAlphabet } from "nanoid"
import { db } from "../db/index"
import { taskAttachments, workers, type TaskAttachment } from "../db/schema"
import { shellQuote } from "../lib/shell"
import { runCommand } from "../lib/worker-commands"
import { MAX_FILES_PER_TURN, MAX_TURN_BYTES, cleanFilename, decodeAttachment, workerFilename } from "../lib/task-attachments"

/**
 * The files of a task's conversation (RFC 0022): storing them, serving them, and putting the
 * human's ones where the agent can open them.
 *
 *  - **from the agent** — a screenshot a tool handed back. Ingestion catches the bytes on the way
 *    past (`lib/task-attachments.ts`) and this stores them.
 *  - **from a human** — dropped into the composer. The file lands in the worker **as a file**, and
 *    the turn says where (`materialize`). A path works for every harness and every dialect.
 *
 * Same design as Spunto Cloud; the only difference is how the bytes reach the container — a
 * local `docker exec` rather than an RPC to a node agent.
 */

// Lowercase alphanumerics: the id ends up in a path built by a shell inside the worker.
const newAttachmentId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 21)

export type InlineFile = { filename?: string | null; mediaType: string; data: string }
export type StoredFile = { id: string; filename: string | null; mediaType: string; bytes: number }

/**
 * `MAX_ARG_STRLEN` caps a single `execve` argument at 128 KiB, so base64 goes over in chunks that
 * ride in the environment (whose budget is ~2 MiB for argv and envp together), eight per exec.
 */
const CHUNK_CHARS = 96 * 1024
const CHUNKS_PER_TRIP = 8

export function serializeFile(row: Pick<TaskAttachment, "id" | "filename" | "mediaType" | "bytes">): StoredFile {
  return { id: row.id, filename: row.filename, mediaType: row.mediaType, bytes: row.bytes }
}

/**
 * Store what a turn carried, deduplicated per task on the content hash. Anything that doesn't
 * decode, or busts a ceiling, is dropped rather than thrown: this also runs on the read path that
 * ingests a live session, where one malformed blob must cost its own file and nothing else.
 */
export function storeFiles(taskId: string, commandId: string | null, origin: "user" | "agent", files: InlineFile[]): StoredFile[] {
  const stored: StoredFile[] = []
  let budget = MAX_TURN_BYTES
  for (const file of files.slice(0, MAX_FILES_PER_TURN)) {
    const buf = decodeAttachment(file.data)
    if (!buf) continue
    if (buf.length > budget) break
    budget -= buf.length
    const sha256 = createHash("sha256").update(buf).digest("hex")

    const existing = db
      .select()
      .from(taskAttachments)
      .where(and(eq(taskAttachments.taskId, taskId), eq(taskAttachments.sha256, sha256)))
      .get()
    if (existing) {
      stored.push(serializeFile(existing))
      continue
    }
    const row: TaskAttachment = {
      id: `att_${newAttachmentId()}`,
      taskId,
      commandId,
      origin,
      filename: cleanFilename(file.filename),
      mediaType: file.mediaType || "application/octet-stream",
      bytes: buf.length,
      sha256,
      data: buf,
      createdAt: new Date(),
    }
    db.insert(taskAttachments).values(row).onConflictDoNothing().run()
    const winner = db
      .select()
      .from(taskAttachments)
      .where(and(eq(taskAttachments.taskId, taskId), eq(taskAttachments.sha256, sha256)))
      .get()
    if (winner) stored.push(serializeFile(winner))
  }
  return stored
}

/** One attachment's bytes — scoped to its task, never by id alone. */
export function getAttachment(taskId: string, attachmentId: string): TaskAttachment | undefined {
  return db
    .select()
    .from(taskAttachments)
    .where(and(eq(taskAttachments.taskId, taskId), eq(taskAttachments.id, attachmentId)))
    .get()
}

/** The rows behind a list of ids, in the order given. Missing ids are skipped. */
export function attachmentsByIds(taskId: string, ids: string[]): TaskAttachment[] {
  if (ids.length === 0) return []
  const rows = db
    .select()
    .from(taskAttachments)
    .where(and(eq(taskAttachments.taskId, taskId), inArray(taskAttachments.id, ids)))
    .all()
  const byId = new Map(rows.map((r) => [r.id, r]))
  return ids.map((id) => byId.get(id)).filter((r): r is TaskAttachment => !!r)
}

/**
 * Write a turn's files into the worker and say where they landed — each in its own directory
 * named after its id, under its own (scrubbed) name. The path is echoed back by the shell that
 * resolved `$HOME`, never guessed here. Best-effort: a file that could not be written costs its
 * own path, and the turn goes ahead with the rest.
 */
export async function materialize(workerId: string, taskId: string, attachments: TaskAttachment[]): Promise<string[]> {
  if (attachments.length === 0) return []
  const worker = db.select().from(workers).where(eq(workers.id, workerId)).get()
  if (!worker?.containerId || worker.state !== "ready") {
    console.warn(`[task:${taskId}] cannot write attachments: worker ${workerId} is not ready`)
    return []
  }
  const containerId = worker.containerId
  const run = async (command: string, env?: Record<string, string>) => {
    const result = await runCommand({ containerId, command, cwd: "/workspace", env, timeoutMs: 60_000, maxOutputBytes: 4096 })
    if (result.exitCode !== 0) throw new Error((result.stderr || result.stdout || `exit ${result.exitCode}`).trim())
    return result.stdout
  }

  const paths: string[] = []
  for (const attachment of attachments) {
    const dir = `"$HOME"/.spunto/attachments/${taskId}/${attachment.id}`
    const quoted = `${dir}/${shellQuote(workerFilename(attachment.id, attachment.filename, attachment.mediaType))}`
    const base64 = Buffer.from(attachment.data).toString("base64")
    try {
      const chunks: string[] = []
      for (let offset = 0; offset < base64.length; offset += CHUNK_CHARS) chunks.push(base64.slice(offset, offset + CHUNK_CHARS))
      for (let i = 0; i < chunks.length; i += CHUNKS_PER_TRIP) {
        const batch = chunks.slice(i, i + CHUNKS_PER_TRIP)
        const env = Object.fromEntries(batch.map((chunk, n) => [`SPUNTO_ATT_${n}`, chunk]))
        await run(
          [
            `set -e`,
            `mkdir -p ${dir}`,
            `printf %s ${batch.map((_, n) => `"$SPUNTO_ATT_${n}"`).join("")} ${i === 0 ? ">" : ">>"} ${dir}/payload.b64`,
          ].join("\n"),
          env,
        )
      }
      const path = (
        await run([`set -e`, `base64 -d < ${dir}/payload.b64 > ${quoted}`, `rm -f ${dir}/payload.b64`, `printf %s ${quoted}`].join("\n"))
      ).trim()
      if (path) paths.push(path)
    } catch (err) {
      console.warn(`[task:${taskId}] could not write attachment ${attachment.id} into the worker: ${err}`)
    }
  }
  return paths
}

/** What the harness is told about the files, appended to the turn it receives (never to the timeline). */
export function attachmentPreamble(paths: string[]): string {
  if (paths.length === 0) return ""
  const many = paths.length > 1
  return [
    "",
    `---`,
    `${paths.length} file${many ? "s" : ""} attached by the user, written into the worker — open ${many ? "them" : "it"} with your tools:`,
    ...paths.map((p) => `- ${p}`),
  ].join("\n")
}
