import { sql } from "drizzle-orm"
import { sqliteTable, text, integer, blob, primaryKey, index, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { SharedVolume } from "../lib/shared-volumes"
import type { BuildStep } from "@spunto/build/steps"

export type { SharedVolume }
export type { BuildStep }

// ─── Shared JSON-ish shapes ──────────────────────────────────────────────────

/**
 * `ProjectFeature` is the package's, unchanged: it is the input the script generators take, so a
 * second definition here would be one shape maintained twice.
 *
 * `SetupStatus` is the package's, *widened* by two phases. A worker writes this file inside its
 * container and the control plane reads it back minutes later, so the type has to cover what is
 * already on disk — not only what today's generator emits. `pending` and `features` are Lite-era
 * phases older workers still report; everything else is identical, and `timings` comes along.
 *
 * `Repository` stays local, and narrower than the package's: Lite clones URLs with one SSH key
 * and knows nothing of forges, so `provider` is pinned rather than open (see the type's note).
 */
import type { ProjectFeature, SetupStatus as SharedSetupStatus } from "@spunto/build/types"

export type { ProjectFeature }

export type SetupStatus = Omit<SharedSetupStatus, "phase"> & {
  phase: SharedSetupStatus["phase"] | "pending" | "features"
}

/**
 * A repository to clone into a worker's workspace: a URL, and a path to put it at.
 *
 * **No hosting provider, and that is the design.** Lite has no forge integration — no app to
 * install, no token to mint, no API to ask what repositories you own. Every repository is cloned
 * over SSH with the one key you mounted (Settings → SSH key), which behaves the same against any
 * host. A provider field would only be somewhere to keep an assumption about a host we never talk
 * to, and it is exactly the assumption that made `owner/repo` mean one company's domain.
 *
 * `provider` survives as a constant because the shared package still carries it — Spunto Cloud
 * reaches forges through integrations, and the generated clone command branches on it. `git` is
 * the package's name for "clone this URL with the key you were handed", which is Lite's only mode.
 */
export type Repository = {
  id: string
  /** Always `git`. See the note above. */
  provider: "git"
  /** Display label, derived from the clone URL — the last path segment. */
  project: string
  workspacePath: string
  /** SSH or HTTPS clone URL, exactly as git takes it. */
  cloneUrl: string
  /** Default branch to check out. Empty/absent = the remote's default (HEAD). */
  branch?: string
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
  currentVersion: integer("current_version").notNull().default(1),
  favorite: integer("favorite", { mode: "boolean" }).notNull().default(false),
  // ── Delegated work (docs/tasks.md) ──
  // How a task runs in this project. Not part of a version snapshot: none of it goes into the
  // image, and changing the harness must not force a rebuild. All empty = Claude Code, read live.
  /** The harness. Reads the prompt on stdin — the only contract. Null = `claude -p`. */
  taskAgentCommand: text("task_agent_command"),
  /** How its stdout is read (`@spunto/build/agent-stream`). `claude-stream` = live and interactive. */
  taskAgentProtocol: text("task_agent_protocol").notNull().default("claude-stream"),
  /** How a one-shot session is resumed for a follow-up turn. Null = `claude --resume`. */
  taskFollowUpCommand: text("task_follow_up_command"),
  /** Run on a recycled worker after the checkout — reseed, reinstall. Null = nothing. */
  taskResetCommand: text("task_reset_command"),
  /** What Accept runs. Exit 0 ⇒ done. Null = Accept just closes the task. */
  taskValidateCommand: text("task_validate_command"),
  /** Cleanup run by Drop, after the session is killed. */
  taskCancelCommand: text("task_cancel_command"),
  /** `keep` leaves the worker running during review, `stop` parks it. */
  taskReviewMode: text("task_review_mode").notNull().default("keep"),
  /** Default model of a task. Free text: the valid ids belong to the harness. */
  taskAgentModel: text("task_agent_model"),
  /** Appended to the standing instruction every task of this project is given. */
  taskAgentInstructions: text("task_agent_instructions"),
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
  // provisioning | building | starting | ready | stopped | error — the vocabulary of
  // `@spunto/design-system/workers`, so a state needs no translating on its way to a pill.
  state: text("state").notNull().default("provisioning"),
  /**
   * Why a running worker's container went down, when nobody asked it to — the daemon's own
   * message, or the exit code it reported. Null for every other path, including a setup that
   * failed: that story belongs to `setupStatus.error`, which records *where* in the setup it
   * stopped, and overwriting it here would lose that. Same shape as `services.error`.
   */
  error: text("error"),
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
  // provisioning | starting | ready | stopped | error — same vocabulary as workers, so
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
  // The build as blocks, timestamped as the markers in the log went by — what a log cannot carry,
  // since it has no clock in it. Nullable, and stays null for every build recorded before this
  // column existed: those are redrawn from their log alone. Shape owned by @spunto/build/steps.
  steps: text("steps", { mode: "json" }).$type<BuildStep[] | null>(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
})

// ─── Delegated work (docs/tasks.md) ──────────────────────────────────────────

/**
 * A task: a prompt handed to an agent, a worker it runs in, a branch it works on, and something
 * to review at the end. Its `state` is *derived* from the agent session (a background command in
 * the worker) on every read — the row only remembers the last thing observed.
 *
 * Timestamps are milliseconds rather than the seconds the older tables use: a conversation list
 * is sorted on `lastActivityAt`, and two turns in the same second are the common case.
 */
export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    /** True while the platform is the one naming it — the session's own name replaces it once. */
    autoTitle: integer("auto_title", { mode: "boolean" }).notNull().default(false),
    prompt: text("prompt").notNull(),
    baseBranch: text("base_branch"),
    /** Cut from the first title at creation, and never renamed after. */
    branch: text("branch").notNull(),
    /** Resolved once at creation: the task's own choice, else the project's default. */
    model: text("model"),
    workerId: text("worker_id").references(() => workers.id, { onDelete: "set null" }),
    /** The agent session — the `task_commands` row of the current turn. */
    commandId: text("command_id"),
    // queued | running | in-review | done | failed
    state: text("state").notNull().default("queued"),
    error: text("error"),
    /**
     * What the platform is doing to the task on a human's behalf (accepting | dropping |
     * replying). Cloud derives it from its durable job rows; Lite has no job table, so the
     * in-process job writes it and clears it in a `finally` — and a boot clears whatever a crash
     * left behind (`recoverInterruptedTasks`).
     */
    pendingAction: text("pending_action"),
    pendingSince: integer("pending_since", { mode: "timestamp_ms" }),
    /** When the state was last derived — the background floor's clock. Not a fact about the work. */
    lastRefreshedAt: integer("last_refreshed_at", { mode: "timestamp_ms" }),
    /** When the task last *moved*. What every list is sorted on. */
    lastActivityAt: integer("last_activity_at", { mode: "timestamp_ms" }).notNull(),
    // The ingestion cursor: which command's stdout, how far into it, and the last seq written.
    eventsCommandId: text("events_command_id"),
    eventsOffset: integer("events_offset").notNull().default(0),
    eventsSeq: integer("events_seq").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("tasks_project_activity_idx").on(t.projectId, t.lastActivityAt), index("tasks_state_idx").on(t.state)],
)

/**
 * What the platform ran in a worker for a task — branch setup, the session, accept, drop — with
 * the tail of its output. Cloud keeps these as generic `worker_commands`; Lite only ever runs
 * commands *for* a task, so they hang off the task.
 *
 * A `background` row is the source of truth for nothing: its process lives in the worker, under
 * `~/.spunto/commands/<id>/` (lib/worker-commands.ts), and the row is reconciled from there.
 */
export const taskCommands = sqliteTable(
  "task_commands",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    workerId: text("worker_id"),
    label: text("label"),
    command: text("command").notNull(),
    cwd: text("cwd"),
    // sync | background
    mode: text("mode").notNull(),
    // running | succeeded | failed | timeout | canceled | lost
    status: text("status").notNull(),
    exitCode: integer("exit_code"),
    stdout: text("stdout"),
    stderr: text("stderr"),
    truncated: integer("truncated", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("task_commands_task_idx").on(t.taskId, t.createdAt)],
)

/**
 * The agent session, event by event, in the shared vocabulary (`@spunto/build/agent-stream`).
 * `source` is the harness line it was read from — null for what the platform wrote itself (what
 * the human said).
 */
export const taskEvents = sqliteTable(
  "task_events",
  {
    taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    commandId: text("command_id"),
    ts: integer("ts", { mode: "timestamp_ms" }).notNull(),
    type: text("type").notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    source: text("source"),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.seq] }), index("task_events_type_idx").on(t.taskId, t.type)],
)

/** Files of a conversation, both ways (RFC 0022). Deduplicated per task on the content hash. */
export const taskAttachments = sqliteTable(
  "task_attachments",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    commandId: text("command_id"),
    // user | agent
    origin: text("origin").notNull(),
    filename: text("filename"),
    mediaType: text("media_type").notNull(),
    bytes: integer("bytes").notNull(),
    sha256: text("sha256").notNull(),
    data: blob("data", { mode: "buffer" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("task_attachments_task_sha_idx").on(t.taskId, t.sha256)],
)

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
export type Task = typeof tasks.$inferSelect
export type TaskCommand = typeof taskCommands.$inferSelect
export type TaskEvent = typeof taskEvents.$inferSelect
export type TaskAttachment = typeof taskAttachments.$inferSelect
