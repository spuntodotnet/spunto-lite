import { eq, desc } from "drizzle-orm"
import { db } from "../db/index"
import {
  projects,
  projectVersions,
  type Project,
  type ProjectFeature,
  type ProjectVersionConfig,
} from "../db/schema"
import { newId } from "../lib/id"
import { encrypt, decrypt } from "../lib/crypto"
import { generateSSHKeyPair, derivePublicKey } from "../lib/ssh"
import { AVAILABLE_FEATURES } from "../lib/catalogs"
import type { CreateProjectInput, UpdateProjectInput } from "../lib/validation"
import { setProjectSecret } from "./secrets"

/** Resolves each feature id against the catalog, baking in its ociRef/localScript. */
function resolveFeatures(features: { id: string; options?: Record<string, string> }[]): ProjectFeature[] {
  return features.map((f) => {
    const cat = AVAILABLE_FEATURES.find((c) => c.id === f.id)
    return {
      id: f.id,
      options: { ...cat?.defaultOptions, ...f.options },
      ociRef: cat?.ociRef,
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
  }
}

function createVersion(projectId: string, version: number, config: ProjectVersionConfig) {
  db.insert(projectVersions).values({ id: newId(), projectId, version, config }).run()
}

/** Public shape: strips the encrypted deploy key, derives the public half. */
export type SerializedProject = Omit<Project, "deployKeyPrivate"> & { deployPublicKey: string | null }

export function serializeProject(p: Project): SerializedProject {
  const { deployKeyPrivate, ...rest } = p
  let deployPublicKey: string | null = null
  if (deployKeyPrivate) {
    try {
      deployPublicKey = derivePublicKey(decrypt(deployKeyPrivate))
    } catch {
      deployPublicKey = null
    }
  }
  return { ...rest, deployPublicKey }
}

/**
 * Ensures a project has a deploy key once it has ≥1 generic "git" repo.
 * Never regenerated once set (the public half is registered host-side).
 * Returns the decrypted private key, or null if no git repo needs one.
 */
export function ensureDeployKey(p: Project): string | null {
  const needsKey = p.repositories.some((r) => r.provider === "git")
  if (!needsKey) return p.deployKeyPrivate ? decrypt(p.deployKeyPrivate) : null
  if (p.deployKeyPrivate) return decrypt(p.deployKeyPrivate)
  const { privateKey } = generateSSHKeyPair()
  db.update(projects).set({ deployKeyPrivate: encrypt(privateKey) }).where(eq(projects.id, p.id)).run()
  p.deployKeyPrivate = encrypt(privateKey)
  return privateKey
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

export function createProject(input: CreateProjectInput): SerializedProject {
  const id = newId()
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
    deployKeyPrivate: null,
    currentVersion: 1,
    favorite: false,
    createdAt: new Date(),
  }
  db.insert(projects).values(row).run()
  createVersion(id, 1, buildVersionConfig(row))

  // Inline secrets → project_secrets (kept out of the versioned config).
  for (const s of input.secrets ?? []) setProjectSecret(id, s.name, s.value)

  // Generate a deploy key eagerly if a generic git repo is present.
  const fresh = getProjectRow(id)!
  ensureDeployKey(fresh)
  return serializeProject(getProjectRow(id)!)
}

export function updateProject(id: string, input: UpdateProjectInput): SerializedProject | undefined {
  const existing = getProjectRow(id)
  if (!existing) return undefined

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
      currentVersion: merged.currentVersion,
    })
    .where(eq(projects.id, id))
    .run()

  createVersion(id, merged.currentVersion, buildVersionConfig(merged))

  if (input.secrets) for (const s of input.secrets) setProjectSecret(id, s.name, s.value)

  ensureDeployKey(getProjectRow(id)!)
  return serializeProject(getProjectRow(id)!)
}

export function setFavorite(id: string, favorite: boolean): SerializedProject | undefined {
  const existing = getProjectRow(id)
  if (!existing) return undefined
  db.update(projects).set({ favorite }).where(eq(projects.id, id)).run()
  return serializeProject(getProjectRow(id)!)
}

export function deleteProject(id: string) {
  db.delete(projects).where(eq(projects.id, id)).run()
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
      currentVersion: newVersion,
    })
    .where(eq(projects.id, projectId))
    .run()
  createVersion(projectId, newVersion, c)
  return serializeProject(getProjectRow(projectId)!)
}
