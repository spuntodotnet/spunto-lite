import { eq, desc } from "drizzle-orm"
import { db } from "../db/index"
import { workers, projectImageBuilds, type Worker, type Project, type SetupStatus } from "../db/schema"
import { newId, newShortId } from "../lib/id"
import { BASE_DOMAIN } from "../lib/env"
import { CODE_SERVER_EXTENSIONS_GALLERY } from "../lib/extension-registry"
import {
  buildImageScript,
  buildSetupScript,
  buildStartScript,
  buildWorkerScript,
} from "../lib/setup-script"
import {
  docker,
  spawnContainer,
  stopContainer,
  startContainer,
  removeWorker as removeWorkerContainer,
  removeContainerOnly,
  getContainerState,
  getSetupStatus,
  buildProjectImage,
} from "../lib/docker"
import { getProjectRow, ensureDeployKey } from "./projects"
import { resolveSecretsForSpawn } from "./secrets"
import { getSettings } from "./settings"
import { readHostPrivateKey } from "../lib/ssh-keys"

function imageRefFor(projectId: string, version: number): string {
  return `mp-proj-${projectId}:v${version}`
}

function hasDinD(project: Project): boolean {
  return project.dind || project.features.some((f) => f.id === "docker-in-docker")
}

// ─── Image build ──────────────────────────────────────────────────────────────

async function imageExists(ref: string): Promise<boolean> {
  return docker.getImage(ref).inspect().then(() => true).catch(() => false)
}

/** Builds the per-(project,version) image if it isn't already present. Returns the image ref. */
export async function ensureProjectImage(project: Project, version: number): Promise<string> {
  const ref = imageRefFor(project.id, version)
  if (await imageExists(ref)) return ref

  const buildId = newId()
  db.insert(projectImageBuilds).values({ id: buildId, projectId: project.id, version, imageRef: ref, state: "building", logs: "" }).run()

  const { script } = buildImageScript({
    features: project.features,
    vscodeExtensions: project.vscodeExtensions,
    dind: project.dind,
  })

  let logs = ""
  const flush = (chunk: string) => {
    logs += chunk
    // Periodic persistence so the UI can tail progress.
    db.update(projectImageBuilds).set({ logs }).where(eq(projectImageBuilds.id, buildId)).run()
  }

  try {
    await buildProjectImage({ baseImage: project.image, buildScript: script, imageRef: ref, onLog: flush })
    db.update(projectImageBuilds).set({ state: "ready", logs }).where(eq(projectImageBuilds.id, buildId)).run()
    return ref
  } catch (err) {
    logs += `\n[build] ERROR: ${(err as Error).message}\n`
    db.update(projectImageBuilds).set({ state: "error", logs }).where(eq(projectImageBuilds.id, buildId)).run()
    throw err
  }
}

/** Fire-and-forget pre-build of the current version's image (no-op if already built). */
export function triggerBuild(projectId: string): boolean {
  const project = getProjectRow(projectId)
  if (!project) return false
  void ensureProjectImage(project, project.currentVersion).catch((e) => console.error(`[build ${projectId}]`, e))
  return true
}

export function listBuilds(projectId: string) {
  return db
    .select()
    .from(projectImageBuilds)
    .where(eq(projectImageBuilds.projectId, projectId))
    .orderBy(desc(projectImageBuilds.createdAt))
    .all()
}

// ─── Worker script assembly ───────────────────────────────────────────────────

/**
 * `branch` is the worker's own checkout target: `buildFullScript` reads the *current*
 * project row (not the version snapshot), so a per-worker branch can only travel
 * through this argument, never through `project.repositories`.
 */
function buildFullScript(project: Project, branch?: string | null): string {
  const settings = getSettings()
  const secrets = resolveSecretsForSpawn(project.id)
  const userSshPrivateKey = readHostPrivateKey(settings.sshKeyPath) ?? undefined
  const projectDeployKey = ensureDeployKey(project) ?? undefined

  const { script: setup } = buildSetupScript({
    project: {
      repositories: project.repositories,
      features: project.features,
      dind: project.dind,
      postCreateCommand: project.postCreateCommand,
    },
    userInfo: settings.gitUserName ? { name: settings.gitUserName, email: settings.gitUserEmail } : undefined,
    userSshPrivateKey,
    userEnvSecrets: secrets,
    projectDeployKey,
    dotfilesRepo: settings.dotfilesRepo ?? undefined,
    branch: branch ?? undefined,
  })

  const { script: start } = buildStartScript({
    project: {
      name: project.name,
      features: project.features,
      dind: project.dind,
      postCreateCommand: project.postCreateCommand,
      postStartCommand: project.postStartCommand,
      repositories: project.repositories,
    },
  })

  return buildWorkerScript({
    setupScript: setup,
    startScript: start,
    project: {
      postCreateCommand: project.postCreateCommand,
      postStartCommand: project.postStartCommand,
      repositories: project.repositories,
    },
  })
}

function spawnEnv(project: Project, workerId: string): string[] {
  const secrets = resolveSecretsForSpawn(project.id)
  return [
    `WORKER_SLUG=worker-${workerId}`,
    `BASE_DOMAIN=${BASE_DOMAIN}`,
    `PUBLIC_PROTOCOL=http`,
    // The code-server loop exports this itself (lib/setup-script.ts), but having
    // it on the container too means a `code-server --install-extension` typed by
    // hand in the worker's terminal resolves against the same registry.
    ...(CODE_SERVER_EXTENSIONS_GALLERY ? [`EXTENSIONS_GALLERY=${CODE_SERVER_EXTENSIONS_GALLERY}`] : []),
    ...Object.entries(secrets).map(([k, v]) => `${k}=${v}`),
  ]
}

// ─── Spawn pipeline ───────────────────────────────────────────────────────────

/** Fire-and-forget: build the image (if needed) then create/start the container. */
async function runSpawnPipeline(workerId: string, project: Project, version: number, branch?: string | null) {
  try {
    setWorkerState(workerId, "building")
    const image = await ensureProjectImage(project, version)

    setWorkerState(workerId, "starting")
    const script = buildFullScript(project, branch)
    const env = spawnEnv(project, workerId)

    const { containerId } = await spawnContainer({
      workerId,
      image,
      script,
      env,
      hasDinD: hasDinD(project),
      labels: { "spunto.worker": "true", "spunto.workerId": workerId, "spunto.projectId": project.id },
    })
    db.update(workers).set({ containerId, state: "starting" }).where(eq(workers.id, workerId)).run()
  } catch (err) {
    console.error(`[worker ${workerId}] spawn failed:`, err)
    db.update(workers)
      .set({ state: "error", setupStatus: { phase: "error", repos: [], postCreate: null, postStart: null, error: (err as Error).message } })
      .where(eq(workers.id, workerId))
      .run()
  }
}

function setWorkerState(workerId: string, state: string) {
  db.update(workers).set({ state }).where(eq(workers.id, workerId)).run()
}

export function spawnWorker(projectId: string, name?: string, branch?: string): Worker {
  const project = getProjectRow(projectId)
  if (!project) throw new Error("Project not found")
  const id = newShortId()
  const workerName = name?.trim() || `${project.name}-${id.slice(0, 4)}`
  const row: Worker = {
    id,
    projectId,
    name: workerName,
    containerId: null,
    state: "pending",
    setupStatus: { phase: "pending", repos: [], postCreate: null, postStart: null },
    branch: branch?.trim() || null,
    projectVersion: project.currentVersion,
    tags: [],
    createdAt: new Date(),
  }
  db.insert(workers).values(row).run()
  void runSpawnPipeline(id, project, project.currentVersion, row.branch)
  return row
}

// ─── Live state refresh (on-demand polling) ───────────────────────────────────

function derivePhase(setup: SetupStatus | null): string | null {
  return setup?.phase ?? null
}

/**
 * Reconciles a worker's DB state with the live container: reads container state
 * and the in-container setup status file, and derives the worker state.
 */
export async function refreshWorker(w: Worker): Promise<Worker> {
  if (!w.containerId) return w
  const cState = await getContainerState(w.containerId).catch(() => "error" as const)

  if (cState === "not_found") {
    if (w.state === "error") return w
    db.update(workers).set({ state: "stopped", containerId: null }).where(eq(workers.id, w.id)).run()
    return { ...w, state: "stopped", containerId: null }
  }
  if (cState === "stopped") {
    // A failed setup is terminal: don't let the next poll relabel it "stopped".
    if (w.state === "error") return w
    // A container that dies *during* setup didn't stop, it failed — a branch that
    // doesn't exist on the remote, a clone that can't authenticate. Its status file
    // is unreadable once the container is gone (`docker exec` needs it running), so
    // derive the failure from the state we were in: `stopWorker` writes "stopped"
    // before the container actually goes down, so a user-requested stop never lands here.
    const diedSettingUp = w.state === "pending" || w.state === "building" || w.state === "starting"
    if (diedSettingUp) {
      const setup: SetupStatus = {
        ...(w.setupStatus ?? { phase: "error", repos: [], postCreate: null, postStart: null }),
        phase: "error",
        error: w.setupStatus?.error ?? "Setup exited before the workspace was ready — see the logs",
      }
      db.update(workers).set({ state: "error", setupStatus: setup }).where(eq(workers.id, w.id)).run()
      return { ...w, state: "error", setupStatus: setup }
    }
    if (w.state !== "stopped") db.update(workers).set({ state: "stopped" }).where(eq(workers.id, w.id)).run()
    return { ...w, state: "stopped" }
  }
  if (cState === "error") return w

  // running — read setup status
  let setup: SetupStatus | null = w.setupStatus
  try {
    setup = (await getSetupStatus(w.containerId)) as SetupStatus | null
  } catch {
    // keep previous
  }
  const phase = derivePhase(setup)
  const state = phase === "ready" ? "ready" : phase === "error" ? "error" : "starting"
  db.update(workers).set({ state, setupStatus: setup ?? w.setupStatus }).where(eq(workers.id, w.id)).run()
  return { ...w, state, setupStatus: setup ?? w.setupStatus }
}

export function getWorkerRow(id: string): Worker | undefined {
  return db.select().from(workers).where(eq(workers.id, id)).get()
}

export function listWorkerRows(projectId: string): Worker[] {
  return db.select().from(workers).where(eq(workers.projectId, projectId)).orderBy(desc(workers.createdAt)).all()
}

export async function listWorkersLive(projectId: string): Promise<Worker[]> {
  const rows = listWorkerRows(projectId)
  return Promise.all(rows.map((w) => refreshWorker(w).catch(() => w)))
}

export async function getWorkerLive(id: string): Promise<Worker | undefined> {
  const w = getWorkerRow(id)
  if (!w) return undefined
  return refreshWorker(w).catch(() => w)
}

export function setWorkerTags(id: string, tags: string[]): Worker | undefined {
  const w = getWorkerRow(id)
  if (!w) return undefined
  db.update(workers).set({ tags }).where(eq(workers.id, id)).run()
  return { ...w, tags }
}

// ─── Lifecycle actions ────────────────────────────────────────────────────────

export async function stopWorker(id: string): Promise<Worker | undefined> {
  const w = getWorkerRow(id)
  if (!w?.containerId) return w
  await stopContainer(w.containerId)
  db.update(workers).set({ state: "stopped" }).where(eq(workers.id, id)).run()
  return { ...w, state: "stopped" }
}

export async function startWorker(id: string): Promise<Worker | undefined> {
  const w = getWorkerRow(id)
  if (!w?.containerId) return w
  await startContainer(w.containerId)
  db.update(workers).set({ state: "starting" }).where(eq(workers.id, id)).run()
  return { ...w, state: "starting" }
}

export async function deleteWorker(id: string): Promise<void> {
  const w = getWorkerRow(id)
  if (w) await removeWorkerContainer(w.id, w.containerId).catch(() => {})
  db.delete(workers).where(eq(workers.id, id)).run()
}

/**
 * Removes the container but KEEPS the workspace volume, then respawns against
 * the project's current version. The `/workspace` volume (git clone, uncommitted
 * work) survives; the setup script's idempotent clone guard skips re-cloning. A
 * worker created on a branch keeps it: the guard's else-branch checks it out again
 * (best-effort — local work is never clobbered). Use `deleteWorker` to also wipe
 * the volumes.
 */
export async function rebuildWorker(id: string): Promise<Worker | undefined> {
  const w = getWorkerRow(id)
  if (!w) return undefined
  const project = getProjectRow(w.projectId)
  if (!project) return undefined
  await removeContainerOnly(w.id, w.containerId).catch(() => {})
  db.update(workers)
    .set({ containerId: null, state: "pending", projectVersion: project.currentVersion, setupStatus: { phase: "pending", repos: [], postCreate: null, postStart: null } })
    .where(eq(workers.id, id))
    .run()
  void runSpawnPipeline(id, project, project.currentVersion, w.branch)
  return getWorkerRow(id)
}
