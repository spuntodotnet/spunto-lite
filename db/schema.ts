import { sql } from "drizzle-orm"
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"
import type { SharedVolume } from "../lib/shared-volumes"

export type { SharedVolume }

// ─── Shared JSON-ish shapes ──────────────────────────────────────────────────

export type Repository = {
  id: string
  provider: "github" | "gitlab" | "bitbucket" | "git"
  project: string // display label, e.g. "owner/repo"
  workspacePath: string
  cloneUrl?: string
  /** Default branch to check out. Empty/absent = the remote's default (HEAD). */
  branch?: string
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
    | "initializing"
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

/**
 * One environment variable of a shared service. Either a literal `value` (plain
 * config, stored as-is in SQLite) or `secretName`, the name of a **global secret**
 * whose AES-GCM encrypted value is decrypted at start time and never persisted
 * here. Anything sensitive belongs in the second form.
 */
export type ServiceEnvVar = { name: string; value?: string; secretName?: string }

/**
 * A port the service listens on. `container` is always declared (that's how workers
 * and the reverse proxy reach it over the shared network); `host` additionally
 * publishes it on the machine, for a psql or a mongosh run outside any container.
 */
export type ServicePort = { container: number; host?: number | null }

/**
 * A persistent named volume. `name` is the user-facing suffix; the real Docker
 * volume is `mp-svc-<serviceId>-<name>`, so it survives container recreation
 * (edit, restart) and is only removed with the service itself.
 */
export type ServiceVolume = { name: string; mountPath: string }

export type ServiceRestartPolicy = "no" | "unless-stopped" | "always" | "on-failure"

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
  /**
   * Absent on snapshots taken before shared volumes existed — read it as `?? []`,
   * never assume the key is there.
   */
  sharedVolumes?: SharedVolume[]
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
  // Volumes mounted in *every* worker of the project (on top of its private
  // /workspace) — a dependency cache, a dataset, build artifacts. They outlive
  // the workers and are only destroyed with the project (see lib/shared-volumes.ts).
  sharedVolumes: text("shared_volumes", { mode: "json" }).$type<SharedVolume[]>().notNull().default(sql`'[]'`),
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
  // Branch checked out at clone time, overriding each repository's own default.
  // Null = the remote's default branch. Persisted so a rebuild (which keeps the
  // /workspace volume) still knows which branch this worker was created for.
  branch: text("branch"),
  projectVersion: integer("project_version").notNull().default(1),
  tags: text("tags", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
})

/**
 * A long-lived dependency shared by *every* dev environment — one Elasticsearch,
 * one Postgres, one MinIO for all the workers of all the projects. Deliberately
 * **global**: no `projectId`, because mutualising is the whole point. Its
 * lifecycle is independent of any worker (it survives their deletion), and it's
 * reachable from every worker by DNS at its `slug` on the shared network.
 *
 * v1 is one container per service: a stack (Elasticsearch + Kibana) is declared
 * as two services on the same network, not as an imported docker-compose file.
 */
export const services = sqliteTable("services", {
  id: text("id").primaryKey(),
  /** DNS label — the hostname workers resolve, and the `svc-<slug>` proxy prefix. */
  slug: text("slug").notNull().unique(),
  description: text("description"),
  image: text("image").notNull(),
  /**
   * Overrides the image's `CMD`, for images that take their configuration as
   * arguments (`minio server /data --console-address :9001`). Tokenised as a shell
   * would, not run through one — no pipes, no expansion.
   */
  command: text("command"),
  env: text("env", { mode: "json" }).$type<ServiceEnvVar[]>().notNull().default(sql`'[]'`),
  ports: text("ports", { mode: "json" }).$type<ServicePort[]>().notNull().default(sql`'[]'`),
  volumes: text("volumes", { mode: "json" }).$type<ServiceVolume[]>().notNull().default(sql`'[]'`),
  /**
   * Container port serving HTTP, if any. Two consequences: the service is
   * browsable at `http://svc-<slug>.<BASE_DOMAIN>` through the reverse proxy, and
   * the `SPUNTO_SVC_<SLUG>` variable injected into workers is a full `http://` URL.
   */
  httpPort: integer("http_port"),
  restartPolicy: text("restart_policy").$type<ServiceRestartPolicy>().notNull().default("unless-stopped"),
  containerId: text("container_id"),
  // pending | starting | ready | stopped | error — same vocabulary as workers, so
  // the UI's status pills are shared.
  state: text("state").notNull().default("stopped"),
  /** Last start failure (missing image, port already bound…), surfaced in the UI. */
  error: text("error"),
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
  // Personal dotfiles repo (Codespaces-style): "owner/repo" shorthand or full URL.
  // Cloned into ~/dotfiles on first boot of every worker and its install script run.
  dotfilesRepo: text("dotfiles_repo"),
  // GCP service-account key (roles/artifactregistry.reader), AES-256-GCM encrypted.
  // Control-plane credential used to pull private Artifact Registry / GCR base
  // images — NOT injected into workers (unlike user/project secrets).
  gcpRegistryKey: text("gcp_registry_key"),
})

export type Project = typeof projects.$inferSelect
export type Worker = typeof workers.$inferSelect
export type Service = typeof services.$inferSelect
export type ProjectImageBuild = typeof projectImageBuilds.$inferSelect
export type Settings = typeof settings.$inferSelect
