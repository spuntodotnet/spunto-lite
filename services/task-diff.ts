import { eq } from "drizzle-orm"
import { db } from "../db/index"
import { projects, workers, type Task } from "../db/schema"
import { runCommand } from "../lib/worker-commands"
import { diffSummaryScript, filePatchScript, parseDiffSummary, parsePatch, type FilePatch, type RepoDiff } from "../lib/task-diff"

/**
 * The diff of a task, read with git **in its own machine** (docs/tasks.md § "Relire le diff") —
 * no forge involved. Read-only and unrecorded: opening a file does not write into "What ran".
 * Nothing is cached — the machine may still be changing under the reviewer.
 */

const SUMMARY_TIMEOUT_MS = 45_000
const PATCH_TIMEOUT_MS = 30_000
const MAX_PATCH_BYTES = 512 * 1024
const MAX_SUMMARY_BYTES = 2 * 1024 * 1024

/**
 * Why there is nothing to show. `node-unreachable` and `unsupported` are Cloud's (a BYOC node);
 * Lite has one Docker daemon, so only the first two can happen here.
 */
export type DiffUnavailable = "no-machine" | "machine-stopped"

export type TaskDiff = {
  available: boolean
  reason: DiffUnavailable | null
  /**
   * The branch the checkout is on now, read in the worker — whichever the agent made (RFC 0056:
   * Lite makes none). Falls back to the branch an older task was created on, when nothing could
   * be read. A string, not null: it is the panel's header.
   */
  branch: string
  baseBranch: string | null
  repos: RepoDiff[]
  additions: number
  deletions: number
  files: number
}

function reachable(task: Task): string | DiffUnavailable {
  if (!task.workerId) return "no-machine"
  const worker = db.select().from(workers).where(eq(workers.id, task.workerId)).get()
  if (!worker?.containerId) return "no-machine"
  if (worker.state !== "ready") return "machine-stopped"
  return worker.containerId
}

type RepoDir = { cwd: string; name: string; branch: string | null }

/**
 * Where the project's repositories live in a worker — where its setup cloned them — and the
 * branch each was cloned on when the project says (null = the remote's default).
 */
export function repoDirs(projectId: string): RepoDir[] {
  const project = db.select({ repositories: projects.repositories }).from(projects).where(eq(projects.id, projectId)).get()
  const dirs = (project?.repositories ?? [])
    .filter((r) => typeof r.workspacePath === "string" && r.workspacePath.length > 0)
    .map((r) => ({ cwd: `/workspace/${r.workspacePath}`, name: r.workspacePath, branch: r.branch?.trim() || null }))
  return dirs.length > 0 ? dirs : [{ cwd: "/workspace", name: "workspace", branch: null }]
}

/**
 * What a repository is compared against: the task's base branch, else the one the repository was
 * cloned on — the branch a fresh worker starts from, and a recycled one is reset to.
 */
function baseOf(task: Task, dir: RepoDir): string | null {
  return task.baseBranch || dir.branch
}

export async function taskDiff(task: Task): Promise<TaskDiff> {
  const empty = { branch: task.branch ?? "", baseBranch: task.baseBranch, repos: [] as RepoDiff[], additions: 0, deletions: 0, files: 0 }
  const containerId = reachable(task)
  if (containerId === "no-machine" || containerId === "machine-stopped") return { available: false, reason: containerId, ...empty }

  const repos: RepoDiff[] = []
  for (const dir of repoDirs(task.projectId)) {
    try {
      const result = await runCommand({
        containerId,
        command: diffSummaryScript(baseOf(task, dir)),
        cwd: dir.cwd,
        timeoutMs: SUMMARY_TIMEOUT_MS,
        maxOutputBytes: MAX_SUMMARY_BYTES,
      })
      // A non-zero exit with output still carries a usable diff; only a *silent* failure is one.
      if (!result.stdout.trim()) {
        repos.push(failedRepo(dir, task, (result.stderr || "git said nothing").trim().slice(-400)))
        continue
      }
      repos.push(parseDiffSummary(result.stdout, { cwd: dir.cwd, name: dir.name }))
    } catch (err) {
      repos.push(failedRepo(dir, task, String(err)))
    }
  }
  return {
    available: true,
    reason: null,
    ...empty,
    branch: repos.find((r) => r.branch)?.branch ?? empty.branch,
    repos,
    additions: repos.reduce((sum, r) => sum + r.additions, 0),
    deletions: repos.reduce((sum, r) => sum + r.deletions, 0),
    files: repos.reduce((sum, r) => sum + r.files.length, 0),
  }
}

function failedRepo(dir: RepoDir, task: Task, detail: string): RepoDiff {
  return { cwd: dir.cwd, name: dir.name, base: baseOf(task, dir) ?? "", mergeBase: null, head: null, branch: null, files: [], additions: 0, deletions: 0, error: detail }
}

export type TaskFilePatch = FilePatch & { repo: string; available: boolean; reason: DiffUnavailable | null }

/** One file's patch, on demand — the list opens instantly, the bytes arrive per file. */
export async function taskFilePatch(
  task: Task,
  params: { repo?: string; path: string; untracked?: boolean; oldPath?: string | null },
): Promise<TaskFilePatch> {
  const blank = { path: params.path, hunks: [], binary: false, truncated: false, repo: params.repo ?? "" }
  const containerId = reachable(task)
  if (containerId === "no-machine" || containerId === "machine-stopped") return { ...blank, available: false, reason: containerId }

  const dirs = repoDirs(task.projectId)
  // An unknown repo falls back to the first: a stale tab, not an attack surface — the path is
  // quoted, and git refuses to leave the repository either way.
  const dir = dirs.find((d) => d.name === params.repo) ?? dirs[0]
  const result = await runCommand({
    containerId,
    command: filePatchScript(baseOf(task, dir), params.path, { untracked: params.untracked, oldPath: params.oldPath ?? null }),
    cwd: dir.cwd,
    timeoutMs: PATCH_TIMEOUT_MS,
    maxOutputBytes: MAX_PATCH_BYTES,
  })
  const patch = parsePatch(result.stdout, { truncated: result.truncated })
  return { ...patch, path: patch.path || params.path, repo: dir.name, available: true, reason: null }
}
