import { sql } from "drizzle-orm"
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"

// ─── Shared JSON-ish shapes ──────────────────────────────────────────────────

export type Repository = {
  id: string
  provider: "github" | "gitlab" | "bitbucket" | "git"
  project: string // display label, e.g. "owner/repo"
  workspacePath: string
  cloneUrl?: string
}

export type ProjectFeature = {
  id: string
  options?: Record<string, string>
  ociRef?: string
  localScript?: string
}

export type SetupStatus = {
  phase:
    | "pending"
    | "credentials"
    | "dotfiles"
    | "cloning"
    | "features"
    | "lifecycle"
    | "ready"
    | "error"
  repos: { name: string; state: "pending" | "cloning" | "done" | "error" }[]
  postCreate: "pending" | "running" | "done" | "error" | null
  postStart: "pending" | "running" | "done" | "error" | null
  error?: string
}

/** Immutable snapshot of the build-relevant config at a given version. */
export type ProjectVersionConfig = {
  name: string
  description: string | null
  image: string
  features: ProjectFeature[]
  vscodeExtensions: string[]
  prewarmImages: string[]
  dind: boolean
  postCreateCommand: string | null
  postStartCommand: string | null
  repositories: Repository[]
  forwardPorts: number[]
}

// ─── Tables ──────────────────────────────────────────────────────────────────

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  image: text("image").notNull(),
  features: text("features", { mode: "json" }).$type<ProjectFeature[]>().notNull().default(sql`'[]'`),
  vscodeExtensions: text("vscode_extensions", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  prewarmImages: text("prewarm_images", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  dind: integer("dind", { mode: "boolean" }).notNull().default(false),
  postCreateCommand: text("post_create_command"),
  postStartCommand: text("post_start_command"),
  repositories: text("repositories", { mode: "json" }).$type<Repository[]>().notNull().default(sql`'[]'`),
  forwardPorts: text("forward_ports", { mode: "json" }).$type<number[]>().notNull().default(sql`'[]'`),
  // Per-project ed25519 deploy key (AES-256-GCM), generated on demand for generic git repos.
  deployKeyPrivate: text("deploy_key_private"),
  currentVersion: integer("current_version").notNull().default(1),
  favorite: integer("favorite", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
})

export const projectVersions = sqliteTable("project_versions", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  config: text("config", { mode: "json" }).$type<ProjectVersionConfig>().notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
})

export const projectSecrets = sqliteTable("project_secrets", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  encryptedValue: text("encrypted_value").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
})

export const userSecrets = sqliteTable("user_secrets", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  encryptedValue: text("encrypted_value").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
})

export const workers = sqliteTable("workers", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  containerId: text("container_id"),
  // pending | building | starting | ready | stopped | error
  state: text("state").notNull().default("pending"),
  setupStatus: text("setup_status", { mode: "json" }).$type<SetupStatus | null>(),
  projectVersion: integer("project_version").notNull().default(1),
  tags: text("tags", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
})

export const projectImageBuilds = sqliteTable("project_image_builds", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  imageRef: text("image_ref").notNull(),
  // building | ready | error
  state: text("state").notNull().default("building"),
  logs: text("logs").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
})

/** Single-row settings table (id is always "singleton"). */
export const settings = sqliteTable("settings", {
  id: text("id").primaryKey().default("singleton"),
  gitUserName: text("git_user_name"),
  gitUserEmail: text("git_user_email"),
  // Relative filename under the mounted /host-ssh dir, e.g. "id_ed25519".
  sshKeyPath: text("ssh_key_path"),
})

export type Project = typeof projects.$inferSelect
export type Worker = typeof workers.$inferSelect
export type ProjectImageBuild = typeof projectImageBuilds.$inferSelect
export type Settings = typeof settings.$inferSelect
