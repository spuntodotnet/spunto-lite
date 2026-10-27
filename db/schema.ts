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
  /**
   * The agent apps whose feature the image carries (RFC 0048). Absent on snapshots taken before
   * agent apps — read it as `?? []`.
   */
  agentAppIds?: string[]
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
  /**
   * The agent apps this project's tasks may run under (RFC 0048, docs/taches.md), in order — the
   * first is the default. Part of the image: each one's feature is baked in, so the list is
   * versioned like the features are.
   */
  agentAppIds: text("agent_app_ids", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  currentVersion: integer("current_version").notNull().default(1),
  favorite: integer("favorite", { mode: "boolean" }).notNull().default(false),
  // ── Delegated work (docs/tasks.md) ──
  // How a task runs in this project. Not part of a version snapshot: none of it goes into the
  // image (the harness itself is `agentAppIds`, above).
  /**
   * Deprecated with agent apps (RFC 0048): no longer written nor offered. Read only for a task
   * delegated before them (`agentAppId` null), which finishes on the CLI it began on.
   */
  taskAgentCommand: text("task_agent_command"),
  /** Deprecated, as above: the dialect of a task delegated before agent apps. */
  taskAgentProtocol: text("task_agent_protocol").notNull().default("claude-stream"),
  /** Deprecated, as above. */
  taskFollowUpCommand: text("task_follow_up_command"),
  /** Deprecated (Cloud removed it on 2026-10-26): no longer run nor offered. */
  taskResetCommand: text("task_reset_command"),
  /** What Accept runs. Exit 0 ⇒ done. Null = Accept just closes the task. */
  taskValidateCommand: text("task_validate_command"),
  /** Cleanup run by Drop, after the session is killed. */
  taskCancelCommand: text("task_cancel_command"),
  /** `keep` leaves the worker running during review, `stop` parks it. */
  taskReviewMode: text("task_review_mode").notNull().default("keep"),
  /** Deprecated: the single default model before agent apps, moved into `taskAgentModels`. */
  taskAgentModel: text("task_agent_model"),
  /** The default model of a task, per agent app (`{ claude: "claude-opus-5-5" }`). */
  taskAgentModels: text("task_agent_models", { mode: "json" }).$type<Record<string, string>>().notNull().default(sql`'{}'`),
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
  /**
   * `agent`: the container carries `@spunto/build`'s in-box agent, which dials back (lib/agent.ts)
   * and carries everything that happens inside it. `exec`: everything is a `docker exec` — the
   * workers created before the agent, until they are rebuilt. See `WORKER_DATA_PLANE`.
   */
  dataPlane: text("data_plane").$type<"agent" | "exec">().notNull().default("exec"),
  /** SHA-256 of the token the worker's agent says hello with — never the token itself. */
  agentTokenHash: text("agent_token_hash"),
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
    /**
     * The agent app the task runs under (RFC 0048), fixed at creation like the model. Null for a
     * task delegated before agent apps: it finishes on the CLI it began on (`LEGACY_CLI`).
     */
    agentAppId: text("agent_app_id"),
    /** The app's own parameters the task picked (`{ effort: "high" }`), checked against its catalog. */
    agentOptions: text("agent_options", { mode: "json" }).$type<Record<string, string>>(),
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

// ─── MCP servers (docs/serveurs-mcp.md) ──────────────────────────────────────

/**
 * Cloud's organization MCP servers (RFC 0049), for Lite's single user: declared once by URL,
 * connected in OAuth from Settings, and reached by task sessions through Lite's gateway
 * (`/api/mcp-gateway/<id>`) — the worker never holds the vendor's credential.
 */
export const mcpServers = sqliteTable("mcp_servers", {
  id: text("id").primaryKey(),
  /** What the agent calls it (`mcp__<name>__<tool>`): lowercase letters, digits and dashes. */
  name: text("name").notNull().unique(),
  /** The Streamable HTTP endpoint. */
  url: text("url").notNull(),
  /** Deduced at declaration: `none` (it answered), `oauth` (it challenged with metadata), `header` (given). */
  auth: text("auth").$type<"none" | "oauth" | "header">().notNull(),
  /** `default`: every project's tasks get it unless one turns it off. `optional`: the reverse. */
  mode: text("mode").$type<"default" | "optional">().notNull().default("default"),
  /** What OAuth discovery found (`McpOAuthMetadata`, lib/mcp-oauth.ts). Null unless `oauth`. */
  oauth: text("oauth", { mode: "json" }).$type<Record<string, unknown> | null>(),
  /** Registered dynamically on first Connect, or given at declaration. */
  clientId: text("client_id"),
  encryptedClientSecret: text("encrypted_client_secret"),
  /** The static header of an `auth: header` server, name and value both encrypted. */
  encryptedHeaderName: text("encrypted_header_name"),
  encryptedHeaderValue: text("encrypted_header_value"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
})

/** The OAuth connection of a server — one per server, since Lite has one user. */
export const mcpConnections = sqliteTable("mcp_connections", {
  serverId: text("server_id")
    .primaryKey()
    .references(() => mcpServers.id, { onDelete: "cascade" }),
  encryptedAccessToken: text("encrypted_access_token").notNull(),
  encryptedRefreshToken: text("encrypted_refresh_token"),
  /** Null when the authorization server gave no `expires_in`. */
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  /** `needs_reauth` once a refresh was refused: only a new Connect helps. */
  status: text("status").$type<"ok" | "needs_reauth">().notNull().default("ok"),
  scope: text("scope"),
  connectedAt: integer("connected_at", { mode: "timestamp_ms" }).notNull(),
})

/**
 * A project's departure from a server's mode. A row exists only to differ from it: switching
 * back to what the mode says deletes the row, so the project keeps following the server.
 */
export const projectMcpSettings = sqliteTable(
  "project_mcp_settings",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    serverId: text("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("project_mcp_settings_project_server_idx").on(t.projectId, t.serverId)],
)

/** An authorization in progress (15 minutes): what the callback needs to finish it. */
export const mcpOauthStates = sqliteTable("mcp_oauth_states", {
  state: text("state").primaryKey(),
  serverId: text("server_id")
    .notNull()
    .references(() => mcpServers.id, { onDelete: "cascade" }),
  encryptedCodeVerifier: text("encrypted_code_verifier").notNull(),
  /** The issuer the answer must come from (RFC 9207). */
  issuer: text("issuer").notNull(),
  /** The `redirect_uri` of the authorization request, sent again with the code. */
  redirectUri: text("redirect_uri").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
})

/**
 * What a task session shows the gateway (`Authorization: Bearer lmg_…`) — Cloud's worker token,
 * narrowed to one task. SHA-256 of the token, never the token. Minted at every session start;
 * all of a task's tokens die with its row.
 */
export const mcpGatewayTokens = sqliteTable(
  "mcp_gateway_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    projectId: text("project_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("mcp_gateway_tokens_task_idx").on(t.taskId)],
)

export type McpServer = typeof mcpServers.$inferSelect
export type McpConnection = typeof mcpConnections.$inferSelect
export type ProjectMcpSetting = typeof projectMcpSettings.$inferSelect
