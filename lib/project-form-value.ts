// The seam between `@spunto/design-system/projects` and Lite's project API.
//
// `ProjectForm` is controlled by one `ProjectFormValue` and knows no route: it
// hands the value back on submit and the app maps it to its own payload. That
// mapping lives here — pure functions, no React — so the shape sent to
// /api/projects is one readable object rather than a dozen `useState`s read at
// submit time, and so a test can assert the payload directly.
//
// Lite's model is *narrower* than the dashboard's: a repository is a clone URL and nothing else,
// cloned with the one mounted SSH key (see the `Repository` type). So every row this module
// produces is a `git` row, and the package's provider machinery — the picker, the per-host
// grouping, the "connect an integration" prompt — is simply never fed.

import {
  toProjectFormValue,
  type ProjectFeatureSelection,
  type ProjectFormValue,
  type ProjectRepo,
} from "@spunto/design-system/projects"
import { AVAILABLE_FEATURES } from "./catalogs"
import { EXTENSION_ID_HINT, isExtensionId } from "./extensions"
import type { ProjectExport } from "./project-export"
import { isDeclaredVolume, validateSharedVolumes } from "./shared-volumes"
import type { Project, ProjectFeature, Repository, SharedVolume } from "./types"

/** Pre-selected in the creation form, exactly as the hand-rolled form did. */
export const DEFAULT_IMAGE = "mcr.microsoft.com/devcontainers/javascript-node:20"

/**
 * The form value as Lite carries it: the package's `ProjectFormValue` plus the
 * one field of Lite's project the package has no room for.
 *
 * Extending the value is a documented contract of the package, not a trick — the
 * form only ever patches at the spread, and `ProjectForm<LiteFormValue>` (it
 * infers from `value`) makes every callback, including a custom section's
 * `render`, speak this type with no cast at the boundary.
 */
export interface LiteFormValue extends ProjectFormValue, TaskSettings {
  sharedVolumes: SharedVolume[]
}

/**
 * How delegated work runs (docs/taches.md § "Réglages du projet") — the form's "Delegated work"
 * section, on its Agents page, as in Spunto Cloud. Strings rather than nulls: a field emptied in
 * the form is sent as "", which the API stores as "back to the default".
 */
export interface TaskSettings {
  /** The agent apps the project's tasks may run under, the first being the default (RFC 0048). */
  agentAppIds: string[]
  /** The default model per app; an app left out runs its own default. */
  taskAgentModels: Record<string, string>
  taskAgentInstructions: string
  taskValidateCommand: string
  taskCancelCommand: string
  taskReviewMode: "keep" | "stop"
}

/** A new project's: Claude Code, as the API defaults to — so it can delegate out of the box. */
const DEFAULT_TASK_SETTINGS: TaskSettings = {
  agentAppIds: ["claude"],
  taskAgentModels: {},
  taskAgentInstructions: "",
  taskValidateCommand: "",
  taskCancelCommand: "",
  taskReviewMode: "keep",
}

/** The body POSTed to /api/projects and PATCHed to /api/projects/:id. */
export type ProjectPayload = {
  name: string
  description?: string
  image: string
  features: { id: string; options?: Record<string, string>; ociRef?: string }[]
  vscodeExtensions: string[]
  prewarmImages: string[]
  dind: boolean
  postCreateCommand?: string
  postStartCommand?: string
  repositories: Repository[]
  forwardPorts: number[]
  sharedVolumes: SharedVolume[]
  secrets: { name: string; value: string }[]
} & TaskSettings

/** A fresh creation form: everything empty but the default base image. */
export function newProjectFormValue(): LiteFormValue {
  return { ...toProjectFormValue({ image: DEFAULT_IMAGE }), sharedVolumes: [], ...DEFAULT_TASK_SETTINGS }
}

/** An existing project, as the form edits it. */
export function fromProject(p: Project): LiteFormValue {
  return {
    ...toProjectFormValue({
      name: p.name,
      description: p.description ?? "",
      image: p.image,
      repositories: p.repositories.map(toFormRepo),
      features: p.features.map(toFormFeature),
      vscodeExtensions: p.vscodeExtensions,
      postCreateCommand: p.postCreateCommand ?? "",
      postStartCommand: p.postStartCommand ?? "",
      forwardPorts: p.forwardPorts,
      prewarmImages: p.prewarmImages,
      dockerInDocker: p.dind,
    }),
    sharedVolumes: p.sharedVolumes ?? [],
    agentAppIds: p.agentAppIds ?? [],
    taskAgentModels: p.taskAgentModels ?? {},
    taskAgentInstructions: p.taskAgentInstructions ?? "",
    taskValidateCommand: p.taskValidateCommand ?? "",
    taskCancelCommand: p.taskCancelCommand ?? "",
    taskReviewMode: p.taskReviewMode === "stop" ? "stop" : "keep",
  }
}

/**
 * An imported spec (see lib/project-export.ts), as a creation form.
 * Secrets are *names* in an export — values never leave the instance — and the
 * package's `SecretList` has no "row waiting for its value" state, so they don't
 * become drafts: the form names them in its import banner instead.
 */
export function fromExport({ project: p }: ProjectExport): LiteFormValue {
  return {
    ...toProjectFormValue({
      name: p.name,
      description: p.description ?? "",
      image: p.image,
      repositories: p.repositories.map((r) => toFormRepo({ ...r, id: r.id ?? crypto.randomUUID() })),
      features: p.features.map((f) => toFormFeature({ id: f.id, options: f.options })),
      vscodeExtensions: p.vscodeExtensions,
      postCreateCommand: p.postCreateCommand ?? "",
      postStartCommand: p.postStartCommand ?? "",
      forwardPorts: p.forwardPorts,
      prewarmImages: p.prewarmImages,
      dockerInDocker: p.dind,
    }),
    // A spec exported before shared volumes existed simply doesn't have the key.
    sharedVolumes: p.sharedVolumes ?? [],
    // The spec has no harness list (it is this instance's apps): the new project's default. Its
    // CLI-era fields (`taskAgentCommand`…) are left behind — agent apps replaced them (RFC 0048).
    ...DEFAULT_TASK_SETTINGS,
    // Default models are kept only for apps the project allows — the API refuses the others.
    taskAgentModels: Object.fromEntries(
      Object.entries(p.taskAgentModels ?? {}).filter(([app]) => DEFAULT_TASK_SETTINGS.agentAppIds.includes(app)),
    ),
    taskAgentInstructions: p.taskAgentInstructions ?? "",
    taskValidateCommand: p.taskValidateCommand ?? "",
    taskCancelCommand: p.taskCancelCommand ?? "",
    taskReviewMode: p.taskReviewMode === "stop" ? "stop" : "keep",
  }
}

/**
  * A stored repository, as a form row. Always a `git` row: that is the only kind Lite has.
  *
  * `cloneUrl` is passed through rather than defaulted, and an **imported** spec is where it can
  * legitimately be missing — a spec written by Spunto Cloud names its repositories by forge and
  * `owner/repo`, which is not an address Lite can clone. Such a row arrives with its label and an
  * empty URL, for the user to fill in before creating: an import pre-fills a form they review, so
  * asking for the one thing we cannot know beats guessing a host on their behalf.
  */
function toFormRepo(r: Pick<Repository, "id" | "project" | "workspacePath" | "branch"> & { cloneUrl?: string }): ProjectRepo {
  return {
    id: r.id,
    provider: "git",
    project: r.project,
    workspacePath: r.workspacePath,
    // Stored data is always "touched": picking another repo must never overwrite
    // a workspace path someone set by hand months ago.
    workspacePathTouched: true,
    cloneUrl: r.cloneUrl,
    branch: r.branch,
  }
}

function toFormFeature(f: Pick<ProjectFeature, "id" | "options"> & { ociRef?: string }): ProjectFeatureSelection {
  return {
    id: f.id,
    // `version` only, on purpose: it's the one option the catalog declares as
    // editable, and the rest of a stored `options` was merged server-side from
    // the catalog's own defaults — echoing it back would change the payload
    // without changing a thing about the project.
    options: f.options?.version ? { version: f.options.version } : undefined,
    // A ref the catalog doesn't know is the user's own: keep it, or saving would
    // drop a feature down to an id nothing can install.
    ...(AVAILABLE_FEATURES.some((c) => c.id === f.id) ? {} : { ociRef: f.ociRef }),
  }
}

/**
 * The form value, as Lite's API takes it. Field for field what the hand-rolled
 * form used to build — same trims, same "empty means absent", same filters — so
 * creating and editing a project write exactly what they wrote before.
 */
export function toProjectPayload(value: LiteFormValue): ProjectPayload {
  const repos = value.repositories
  return {
    name: value.name.trim(),
    description: value.description.trim() || undefined,
    image: value.image.trim(),
    features: value.features.map((f) => ({
      id: f.id,
      options: f.options?.version ? { version: f.options.version } : undefined,
      ociRef: f.ociRef,
    })),
    vscodeExtensions: value.vscodeExtensions,
    prewarmImages: value.prewarmImages,
    dind: value.dockerInDocker,
    postCreateCommand: value.postCreateCommand.trim() || undefined,
    postStartCommand: value.postStartCommand.trim() || undefined,
    repositories: repos
      // No URL, no repository: the row is one the user added and hasn't filled in — or one an
      // imported Cloud spec named by forge, which is a label and not an address.
      .filter((r) => r.cloneUrl?.trim())
      .map((r) => {
        const cloneUrl = r.cloneUrl!.trim()
        return {
          id: r.id,
          provider: "git" as const,
          project: r.project.trim() || deriveLabel(cloneUrl),
          workspacePath: r.workspacePath.trim() || deriveLabel(cloneUrl),
          cloneUrl,
          branch: r.branch?.trim() || undefined,
        }
      }),
    // The package's port field drops anything unparseable but keeps large
    // numbers; the API caps at 65535, so the bound is enforced here too.
    forwardPorts: value.forwardPorts.filter((n) => Number.isInteger(n) && n > 0 && n < 65536),
    sharedVolumes: value.sharedVolumes
      .filter(isDeclaredVolume)
      .map((v) => ({ name: v.name.trim(), mountPath: v.mountPath.trim() })),
    secrets: value.secrets.filter((s) => s.name && s.value).map(({ name, value: v }) => ({ name, value: v })),
    agentAppIds: value.agentAppIds,
    // The whole map, only for apps still allowed: one whose model was cleared runs its own default.
    taskAgentModels: Object.fromEntries(
      Object.entries(value.taskAgentModels).filter(([app, model]) => model && value.agentAppIds.includes(app)),
    ),
    taskAgentInstructions: value.taskAgentInstructions,
    taskValidateCommand: value.taskValidateCommand,
    taskCancelCommand: value.taskCancelCommand,
    taskReviewMode: value.taskReviewMode,
  }
}

/**
 * What the API would reject anyway, said in the form instead. Returns the message
 * to show, or null when the payload is fine.
 */
export function validateProjectPayload(p: ProjectPayload): string | null {
  if (!p.name) return "Name is required"
  if (!p.image) return "Base image is required"
  const bad = p.vscodeExtensions.filter((id) => !isExtensionId(id))
  if (bad.length) return `Invalid extension id: ${bad.join(", ")}. ${EXTENSION_ID_HINT}`
  return validateSharedVolumes(p.sharedVolumes)
}

/**
 * Keeps row ids unique. The package mints local ids from a module counter
 * (`repo-1`, `repo-2`…), which is unique within a page but can collide with an
 * id already *stored* on the project being edited — and two rows sharing an id
 * would then be edited, and saved, as one.
 */
export function withUniqueRepoIds(repos: ProjectRepo[]): ProjectRepo[] {
  const seen = new Set<string>()
  return repos.map((r) => {
    if (!seen.has(r.id)) {
      seen.add(r.id)
      return r
    }
    return { ...r, id: crypto.randomUUID() }
  })
}

/** `git@gitlab.com:group/repo.git` → `repo`. */
function deriveLabel(urlOrPath: string): string {
  const cleaned = urlOrPath.replace(/\.git$/, "")
  const parts = cleaned.split(/[/:]/).filter(Boolean)
  return parts[parts.length - 1] || "repo"
}
