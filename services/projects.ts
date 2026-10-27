import { eq, desc } from "drizzle-orm"
import { db } from "../db/index"
import {
  projects,
  projectVersions,
  workers,
  type Project,
  type ProjectFeature,
  type ProjectVersionConfig,
} from "../db/schema"
import { newId } from "../lib/id"
import { removeWorker as removeWorkerContainer, removeProjectImages, removeProjectVolumes } from "../lib/docker"
import { AVAILABLE_FEATURES } from "../lib/catalogs"
import { TASK_SETTING_KEYS, type CreateProjectInput, type TaskSettingsInput, type UpdateProjectInput } from "../lib/validation"
import { buildProjectSpec, type ProjectExport } from "../lib/project-export"
import { setProjectSecret, listProjectSecrets } from "./secrets"
import { agentAppIdsError, projectModelsError } from "../lib/agent-apps"

/** Why a project's harness settings cannot be saved — an unknown app, or a model of another app. */
export class ProjectAgentAppsError extends Error {}

/** The harness every new project starts with when it names none — so it can delegate right away. */
const DEFAULT_AGENT_APP_IDS = ["claude"]

/**
 * Resolves each feature id against the catalog, baking in its ociRef/localScript.
 * An id the catalog doesn't know keeps the ref it came with — that's a feature the
 * user typed themselves, and dropping the ref would leave nothing to install from.
 */
function resolveFeatures(features: { id: string; options?: Record<string, string>; ociRef?: string }[]): ProjectFeature[] {
  return features.map((f) => {
    const cat = AVAILABLE_FEATURES.find((c) => c.id === f.id)
    return {
      id: f.id,
      options: { ...cat?.defaultOptions, ...f.options },
      ociRef: cat?.ociRef ?? f.ociRef,
      localScript: cat?.localScript,
    }
  })
}

export function buildVersionConfig(p: Project): ProjectVersionConfig {
  return {
    name: p.name,
    description: p.description,
    image: p.image,
    features: p.features,
    vscodeExtensions: p.vscodeExtensions,
    prewarmImages: p.prewarmImages,
    dind: p.dind,
    postCreateCommand: p.postCreateCommand,
    postStartCommand: p.postStartCommand,
    repositories: p.repositories,
    forwardPorts: p.forwardPorts,
    sharedVolumes: p.sharedVolumes,
    agentAppIds: p.agentAppIds,
  }
}

function createVersion(projectId: string, version: number, config: ProjectVersionConfig) {
  db.insert(projectVersions).values({ id: newId(), projectId, version, config }).run()
}

/**
 * Public shape: the row minus the columns agent apps deprecated (below). Kept as its own name
 * because the project row has held a secret before and may again.
 *
 * It used to carry a `deployPublicKey`: a per-project key Lite generated to clone a raw-URL
 * repository. It went away with the provider notion — one mounted SSH key clones everything now
 * (see `Repository`). Worth recording *why*, because it read like a feature: nothing ever rendered
 * its public half, so there was no way to register it on a host, so it could only ever clone a
 * public repository. A private one failed with a key the user could not see, let alone install.
 */
export type SerializedProject = Omit<Project, (typeof DEPRECATED_COLUMNS)[number]>

/**
 * Columns agent apps replaced (RFC 0048): still on the row so that a task delegated before them can
 * finish on the CLI it began on, but neither written nor exposed any more.
 */
const DEPRECATED_COLUMNS = ["taskAgentCommand", "taskAgentProtocol", "taskFollowUpCommand", "taskResetCommand", "taskAgentModel"] as const

export function serializeProject(p: Project): SerializedProject {
  const out: Partial<Project> = { ...p }
  for (const key of DEPRECATED_COLUMNS) delete out[key]
  return out as SerializedProject
}

export function listProjects(): SerializedProject[] {
  return db.select().from(projects).orderBy(desc(projects.favorite), desc(projects.createdAt)).all().map(serializeProject)
}

export function getProjectRow(id: string): Project | undefined {
  return db.select().from(projects).where(eq(projects.id, id)).get()
}

export function getProject(id: string): SerializedProject | undefined {
  const row = getProjectRow(id)
  return row ? serializeProject(row) : undefined
}

/** Throws `ProjectAgentAppsError` when the apps or their default models do not hold together. */
function checkAgentApps(agentAppIds: string[], models: Record<string, string>): void {
  const problem = agentAppIdsError(agentAppIds) ?? projectModelsError(agentAppIds, models)
  if (problem) throw new ProjectAgentAppsError(problem)
}

/** Blank values mean "the harness's default", which is no entry at all. */
function cleanModels(models: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!models) return undefined
  return Object.fromEntries(Object.entries(models).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()]))
}

export function createProject(input: CreateProjectInput): SerializedProject {
  const id = newId()
  const agentAppIds = input.agentAppIds ?? DEFAULT_AGENT_APP_IDS
  checkAgentApps(agentAppIds, cleanModels(input.taskAgentModels) ?? {})
  const row: Project = {
    id,
    name: input.name,
    description: input.description ?? null,
    image: input.image,
    features: resolveFeatures(input.features),
    vscodeExtensions: input.vscodeExtensions,
    prewarmImages: input.prewarmImages,
    dind: input.dind,
    postCreateCommand: input.postCreateCommand ?? null,
    postStartCommand: input.postStartCommand ?? null,
    repositories: input.repositories,
    forwardPorts: input.forwardPorts,
    sharedVolumes: input.sharedVolumes,
    agentAppIds,
    currentVersion: 1,
    favorite: false,
    taskAgentCommand: null,
    taskAgentProtocol: "claude-stream",
    taskFollowUpCommand: null,
    taskResetCommand: null,
    taskValidateCommand: null,
    taskCancelCommand: null,
    taskReviewMode: "keep",
    taskAgentModel: null,
    taskAgentModels: {},
    taskAgentInstructions: null,
    ...taskSettingsColumns(input),
    createdAt: new Date(),
  }
  db.insert(projects).values(row).run()
  createVersion(id, 1, buildVersionConfig(row))

  // Inline secrets → project_secrets (kept out of the versioned config).
  for (const s of input.secrets ?? []) setProjectSecret(id, s.name, s.value)

  return serializeProject(getProjectRow(id)!)
}

/**
 * The task settings of a create or a patch, as columns. `null`/blank = back to the default, and
 * absent = leave alone (only meaningful on a patch — a create starts from the column defaults).
 */
function taskSettingsColumns(input: TaskSettingsInput): Partial<Project> {
  const out: Record<string, unknown> = {}
  for (const key of TASK_SETTING_KEYS) {
    const value = input[key]
    if (value === undefined) continue
    if (key === "taskReviewMode") out[key] = value
    else if (key === "taskAgentModels") out[key] = cleanModels(value as Record<string, string>)
    else out[key] = typeof value === "string" && value.trim() ? value.trim() : null
  }
  return out as Partial<Project>
}

export function updateProject(id: string, input: UpdateProjectInput): SerializedProject | undefined {
  const existing = getProjectRow(id)
  if (!existing) return undefined

  // The default models must name apps the project allows — the list as it will be after this patch.
  if (input.agentAppIds || input.taskAgentModels) {
    const appIds = input.agentAppIds ?? existing.agentAppIds
    // An app switched off takes its default model with it, unless the patch sets the map itself.
    const models = cleanModels(input.taskAgentModels) ?? Object.fromEntries(Object.entries(existing.taskAgentModels).filter(([k]) => appIds.includes(k)))
    checkAgentApps(appIds, models)
    if (!input.taskAgentModels) input = { ...input, taskAgentModels: models }
  }

  // Task settings live beside the version history, not in it: none of them goes into the image,
  // so changing a model or an instruction must not mint a version (and mark every worker out of
  // date). The harness list does go into the image (`agentAppIds`), and is versioned below.
  const taskSettings = taskSettingsColumns(input)
  if (Object.keys(taskSettings).length > 0) db.update(projects).set(taskSettings).where(eq(projects.id, id)).run()
  const buildKeys = Object.keys(input).filter(
    (k) => !TASK_SETTING_KEYS.includes(k as keyof TaskSettingsInput) && (input as Record<string, unknown>)[k] !== undefined,
  )
  if (buildKeys.length === 0) return serializeProject(getProjectRow(id)!)

  const merged: Project = {
    ...existing,
    name: input.name ?? existing.name,
    description: input.description !== undefined ? (input.description ?? null) : existing.description,
    image: input.image ?? existing.image,
    features: input.features ? resolveFeatures(input.features) : existing.features,
    vscodeExtensions: input.vscodeExtensions ?? existing.vscodeExtensions,
    prewarmImages: input.prewarmImages ?? existing.prewarmImages,
    dind: input.dind ?? existing.dind,
    postCreateCommand:
      input.postCreateCommand !== undefined ? (input.postCreateCommand ?? null) : existing.postCreateCommand,
    postStartCommand:
      input.postStartCommand !== undefined ? (input.postStartCommand ?? null) : existing.postStartCommand,
    repositories: input.repositories ?? existing.repositories,
    forwardPorts: input.forwardPorts ?? existing.forwardPorts,
    sharedVolumes: input.sharedVolumes ?? existing.sharedVolumes,
    agentAppIds: input.agentAppIds ?? existing.agentAppIds,
    currentVersion: existing.currentVersion + 1,
  }

  db.update(projects)
    .set({
      name: merged.name,
      description: merged.description,
      image: merged.image,
      features: merged.features,
      vscodeExtensions: merged.vscodeExtensions,
      prewarmImages: merged.prewarmImages,
      dind: merged.dind,
      postCreateCommand: merged.postCreateCommand,
      postStartCommand: merged.postStartCommand,
      repositories: merged.repositories,
      forwardPorts: merged.forwardPorts,
      sharedVolumes: merged.sharedVolumes,
      agentAppIds: merged.agentAppIds,
      currentVersion: merged.currentVersion,
    })
    .where(eq(projects.id, id))
    .run()

  createVersion(id, merged.currentVersion, buildVersionConfig(merged))

  if (input.secrets) for (const s of input.secrets) setProjectSecret(id, s.name, s.value)

  return serializeProject(getProjectRow(id)!)
}

export function setFavorite(id: string, favorite: boolean): SerializedProject | undefined {
  const existing = getProjectRow(id)
  if (!existing) return undefined
  db.update(projects).set({ favorite }).where(eq(projects.id, id)).run()
  return serializeProject(getProjectRow(id)!)
}

/**
 * Deletes a project and everything it owns: its workers' containers, networks and
 * volumes, its shared volumes, the images built for it, then the row itself
 * (versions, secrets, workers and build rows go with it through the FK cascades).
 * Docker cleanup is best effort — a container that can't be removed never blocks
 * the deletion. Returns false when the project doesn't exist.
 *
 * This is the *only* place shared volumes are destroyed — they survive worker
 * deletions and rebuilds — so the UI asks for an explicit confirmation before
 * calling it (see `components/delete-project-dialog.tsx`). Workers go first: a
 * volume still attached to a live container can't be removed.
 */
export async function deleteProject(id: string): Promise<boolean> {
  const existing = getProjectRow(id)
  if (!existing) return false

  const rows = db.select().from(workers).where(eq(workers.projectId, id)).all()
  for (const w of rows) await removeWorkerContainer(w.id, w.containerId).catch(() => {})
  await removeProjectVolumes(id)
  await removeProjectImages(id)

  db.delete(projects).where(eq(projects.id, id)).run()
  return true
}

/**
 * Builds the portable spec of a project (see `lib/project-export.ts`).
 * Instance-scoped fields (id, version, favorite) are left out, and
 * secrets travel as **names only** — values are write-only and never exported.
 */
export function exportProject(id: string): ProjectExport | undefined {
  const p = getProjectRow(id)
  if (!p) return undefined
  return buildProjectSpec({
    name: p.name,
    // `?? undefined` so unset fields are omitted from the JSON rather than
    // serialised as null — keeps the file directly re-postable to /api/projects.
    description: p.description ?? undefined,
    image: p.image,
    // Drop ociRef/localScript: they're re-resolved from the catalog on import —
    // except for a feature the catalog doesn't have, whose ref is the only thing
    // that says where it comes from.
    features: p.features.map((f) => ({
      id: f.id,
      options: f.options,
      ...(AVAILABLE_FEATURES.some((c) => c.id === f.id) ? {} : { ociRef: f.ociRef }),
    })),
    vscodeExtensions: p.vscodeExtensions,
    prewarmImages: p.prewarmImages,
    dind: p.dind,
    postCreateCommand: p.postCreateCommand ?? undefined,
    postStartCommand: p.postStartCommand ?? undefined,
    repositories: p.repositories,
    forwardPorts: p.forwardPorts,
    // The *declaration* travels — a name and a mount path, no data and nothing
    // sensitive. The volume itself is per-instance and created on first spawn.
    sharedVolumes: p.sharedVolumes,
    // How delegated work runs here — the spec's own fields, shared with Spunto Cloud. Defaults are
    // left out like every other unset field. The spec has no field for the agent apps themselves
    // (Cloud's export leaves them out too): a project made from the file starts on Claude Code.
    taskValidateCommand: p.taskValidateCommand ?? undefined,
    taskCancelCommand: p.taskCancelCommand ?? undefined,
    taskReviewMode: p.taskReviewMode as ProjectExport["project"]["taskReviewMode"],
    taskAgentModels: Object.keys(p.taskAgentModels).length ? p.taskAgentModels : undefined,
    secretNames: listProjectSecrets(id).map((s) => s.name),
  })
}

export function listVersions(projectId: string) {
  return db
    .select()
    .from(projectVersions)
    .where(eq(projectVersions.projectId, projectId))
    .orderBy(desc(projectVersions.version))
    .all()
}

/** Restores an old version by writing its config as a NEW version (never mutates history). */
export function restoreVersion(projectId: string, version: number): SerializedProject | undefined {
  const existing = getProjectRow(projectId)
  if (!existing) return undefined
  const snap = db
    .select()
    .from(projectVersions)
    .where(eq(projectVersions.projectId, projectId))
    .all()
    .find((v) => v.version === version)
  if (!snap) return undefined
  const c = snap.config
  const newVersion = existing.currentVersion + 1
  db.update(projects)
    .set({
      name: c.name,
      description: c.description,
      image: c.image,
      features: c.features,
      vscodeExtensions: c.vscodeExtensions,
      prewarmImages: c.prewarmImages,
      dind: c.dind,
      postCreateCommand: c.postCreateCommand,
      postStartCommand: c.postStartCommand,
      repositories: c.repositories,
      forwardPorts: c.forwardPorts,
      // Snapshots taken before shared volumes existed simply don't have the key.
      sharedVolumes: c.sharedVolumes ?? [],
      // Snapshots taken before agent apps: the image had none injected.
      agentAppIds: c.agentAppIds ?? [],
      currentVersion: newVersion,
    })
    .where(eq(projects.id, projectId))
    .run()
  createVersion(projectId, newVersion, c)
  return serializeProject(getProjectRow(projectId)!)
}
