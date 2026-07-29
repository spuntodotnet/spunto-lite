// The seam between `@spunto/design-system/projects` and Lite's project API.
//
// `ProjectForm` is controlled by one `ProjectFormValue` and knows no route: it
// hands the value back on submit and the app maps it to its own payload. That
// mapping lives here — pure functions, no React — so the shape sent to
// /api/projects is one readable object rather than a dozen `useState`s read at
// submit time, and so a test can assert the payload directly.
//
// Lite's model is *not* the dashboard's: it keeps four repository providers and a
// per-repo branch, where the package models `github | git` and no branch. Where
// the two disagree, this module keeps Lite's data intact — see `LiteRepo`.

import {
  toProjectFormValue,
  type ProjectFeatureSelection,
  type ProjectFormValue,
  type ProjectRepo,
} from "@spunto/design-system/projects"
import { AVAILABLE_FEATURES } from "./catalogs"
import { EXTENSION_ID_HINT, isExtensionId } from "./extensions"
import type { ProjectExport } from "./project-export"
import { validateSharedVolumes } from "./shared-volumes"
import type { Project, ProjectFeature, Repository, SharedVolume } from "./types"

/** Pre-selected in the creation form, exactly as the hand-rolled form did. */
export const DEFAULT_IMAGE = "mcr.microsoft.com/devcontainers/javascript-node:20"

/**
 * A repo row as Lite carries it: the package's `ProjectRepo` plus the two things
 * Lite's model has and the package's doesn't.
 *
 * Both ride along as extra properties on the same object rather than in a
 * side-map keyed by row id: `RepoList` is fully controlled and patches a row with
 * a spread, so whatever it doesn't know about survives the round trip, and the
 * form value stays the single source of truth (import, edit, submit all read it).
 */
export type LiteRepo = ProjectRepo & {
  /** Branch to clone; empty/absent = the remote's default. */
  branch?: string
  /**
   * Set only for a stored `gitlab` / `bitbucket` row. The package offers two
   * providers, so those edit like a GitHub one (both address `owner/repo`) — but
   * saving must write back what was stored, not silently rewrite the spec.
   */
  storedProvider?: Repository["provider"]
}

/**
 * The form value as Lite carries it: the package's `ProjectFormValue` plus the
 * one field of Lite's project the package has no room for. Same trick as
 * `LiteRepo` — `ProjectForm` patches its value with a spread, so a key it knows
 * nothing about survives every edit and the value stays the single source of
 * truth (import, edit, submit all read it).
 */
export type LiteFormValue = ProjectFormValue & { sharedVolumes: SharedVolume[] }

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
}

/** A fresh creation form: everything empty but the default base image. */
export function newProjectFormValue(): LiteFormValue {
  return { ...toProjectFormValue({ image: DEFAULT_IMAGE }), sharedVolumes: [] }
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
  }
}

function toFormRepo(r: Repository): LiteRepo {
  return {
    id: r.id,
    provider: r.provider === "git" ? "git" : "github",
    project: r.project,
    workspacePath: r.workspacePath,
    // Stored data is always "touched": picking another repo must never overwrite
    // a workspace path someone set by hand months ago.
    workspacePathTouched: true,
    cloneUrl: r.cloneUrl,
    branch: r.branch,
    ...(r.provider === "gitlab" || r.provider === "bitbucket" ? { storedProvider: r.provider } : {}),
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
export function toProjectPayload(value: ProjectFormValue): ProjectPayload {
  const repos = value.repositories as LiteRepo[]
  const sharedVolumes = (value as LiteFormValue).sharedVolumes ?? []
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
      // A row with nothing identifying it isn't a repository yet — the user added
      // it and hasn't filled it in.
      .filter((r) => (r.provider === "git" ? r.cloneUrl?.trim() : r.project.trim()))
      .map((r) => {
        const provider = r.storedProvider ?? r.provider
        return {
          id: r.id,
          provider,
          project: r.provider === "git" ? r.project || deriveLabel(r.cloneUrl || "") : r.project.trim(),
          workspacePath: r.workspacePath.trim() || deriveLabel(r.project || r.cloneUrl || "app"),
          cloneUrl: r.provider === "git" ? r.cloneUrl?.trim() : undefined,
          branch: r.branch?.trim() || undefined,
        }
      }),
    // The package's port field drops anything unparseable but keeps large
    // numbers; the API caps at 65535, so the bound is enforced here too.
    forwardPorts: value.forwardPorts.filter((n) => Number.isInteger(n) && n > 0 && n < 65536),
    // A row the user added and hasn't filled in isn't a volume yet.
    sharedVolumes: sharedVolumes
      .filter((v) => v.name.trim() || v.mountPath.trim())
      .map((v) => ({ name: v.name.trim(), mountPath: v.mountPath.trim() })),
    secrets: value.secrets.filter((s) => s.name && s.value).map(({ name, value: v }) => ({ name, value: v })),
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
