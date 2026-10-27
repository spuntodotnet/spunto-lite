import { z } from "zod"
import { EXTENSION_ID_HINT, isExtensionId } from "./extensions"
import {
  SHARED_VOLUME_NAME_HINT,
  SHARED_VOLUME_NAME_RE,
  normalizeMountPath,
  validateMountPath,
  validateSharedVolumes,
} from "./shared-volumes"

/**
 * A VS Code extension id, checked for shape before it ever reaches the build
 * script. Existence in the registry is checked in the UI at add time
 * (`/api/extensions?id=`); this is the last line of defence against a typo
 * travelling all the way to a `code-server --install-extension` that fails
 * ten minutes later inside a Docker build.
 */
// `refine` over `regex`: the grammar is the package's (it is what the build resolves ids
// against), and it is a function rather than a pattern we could hand to zod.
export const ExtensionIdSchema = z.string().refine(isExtensionId, EXTENSION_ID_HINT)

/**
 * A repository is a clone URL, full stop — see the `Repository` type for why Lite models no
 * hosting provider. `provider` is a literal rather than an absent field because the shared
 * package still reads it, and `cloneUrl` is required because without it there is nothing to
 * clone: a row that reached the API with only a label used to be accepted and then fail, minutes
 * later, inside a build log.
 */
export const RepositorySchema = z.object({
  id: z.string(),
  provider: z.literal("git"),
  /** Display label — derived from the URL by the form, free text as far as the API cares. */
  project: z.string(),
  workspacePath: z.string(),
  /** e.g. `git@example.com:group/repo.git`, or an https URL. Cloned with the mounted SSH key. */
  cloneUrl: z.string().min(1, "A repository needs a clone URL"),
  // Default branch to clone; absent/empty = the remote's default (HEAD).
  branch: z.string().optional(),
})

/**
 * A volume mounted in every worker of a project. The mount path is normalized
 * (trailing slashes dropped) *before* the guard runs, so `/workspace/` can't
 * sneak past the check that keeps a shared volume from shadowing the worker's
 * own `/workspace` — see `lib/shared-volumes.ts` for the full rule set.
 */
export const SharedVolumeSchema = z.object({
  name: z.string().regex(SHARED_VOLUME_NAME_RE, SHARED_VOLUME_NAME_HINT).max(40),
  mountPath: z
    .string()
    .transform(normalizeMountPath)
    .superRefine((path, ctx) => {
      const error = validateMountPath(path)
      if (error) ctx.addIssue({ code: "custom", message: error })
    }),
})

/** The whole list — same per-volume rules, plus no duplicate name and no shared mount path. */
export const SharedVolumesSchema = z.array(SharedVolumeSchema).superRefine((volumes, ctx) => {
  const error = validateSharedVolumes(volumes)
  if (error) ctx.addIssue({ code: "custom", message: error })
})

export const SecretInputSchema = z.object({
  name: z.string().regex(/^[A-Z][A-Z0-9_]*$/, "Name must be UPPER_SNAKE_CASE"),
  value: z.string().min(1),
})

export const FeatureInputSchema = z.object({
  id: z.string(),
  options: z.record(z.string(), z.string()).optional(),
  /**
   * OCI reference for a feature that isn't in the catalog — what the form's
   * "custom OCI ref" field adds. Ignored for a catalog id, whose ref is always
   * resolved server-side (see `resolveFeatures`).
   */
  ociRef: z.string().optional(),
})

/**
 * How delegated work runs in a project (docs/taches.md § "Réglages du projet"). Every field
 * accepts `null` or an empty string to mean "back to the default". Same names as Spunto Cloud's
 * project fields and as the portable spec (`@spunto/build/spec`), so an exported project carries
 * them across.
 *
 * The harness itself is not here: it is `agentAppIds` (RFC 0048), which goes into the image. The
 * CLI-era fields (`taskAgentCommand`, `taskAgentProtocol`, `taskFollowUpCommand`, and
 * `taskResetCommand`) are gone with it — an older client or file that still sends them has them
 * dropped by the parse, like any unknown key.
 */
export const TaskSettingsSchema = z.object({
  taskValidateCommand: z.string().max(10_000).nullable().optional(),
  taskCancelCommand: z.string().max(10_000).nullable().optional(),
  taskReviewMode: z.enum(["keep", "stop"]).optional(),
  /** The default model per agent app, `{ claude: "claude-opus-5-5" }`. Replaces the whole map. */
  taskAgentModels: z.record(z.string(), z.string().trim().max(200)).optional(),
  taskAgentInstructions: z.string().max(10_000).nullable().optional(),
})

export type TaskSettingsInput = z.infer<typeof TaskSettingsSchema>

/** The keys above, for whoever has to tell a task setting from a build-relevant field. */
export const TASK_SETTING_KEYS = Object.keys(TaskSettingsSchema.shape) as (keyof TaskSettingsInput)[]

export const CreateProjectSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  image: z.string().min(1),
  features: z.array(FeatureInputSchema).default([]),
  vscodeExtensions: z.array(ExtensionIdSchema).default([]),
  prewarmImages: z.array(z.string()).default([]),
  dind: z.boolean().default(false),
  postCreateCommand: z.string().optional(),
  postStartCommand: z.string().optional(),
  repositories: z.array(RepositorySchema).default([]),
  forwardPorts: z.array(z.number().int().min(1).max(65535)).default([]),
  sharedVolumes: SharedVolumesSchema.default([]),
  secrets: z.array(SecretInputSchema).optional(),
  /**
   * The agent apps this project's tasks may run under, the first being the default (RFC 0048).
   * Absent = Claude Code, so that a new project can delegate out of the box.
   */
  agentAppIds: z.array(z.string().min(1).max(100)).max(10).optional(),
}).extend(TaskSettingsSchema.shape)

/**
 * PATCH shape — every field plain-optional, "absent" meaning "leave unchanged"
 * (which is what `updateProject` assumes).
 *
 * Deliberately NOT `CreateProjectSchema.partial()`: `.partial()` makes a field
 * optional but keeps its `.default([])`, so a PATCH that never mentioned
 * `vscodeExtensions` still parsed as `[]` and wiped the project's extensions —
 * same for features, repositories, prewarm images and forwarded ports.
 */
export const UpdateProjectSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  image: z.string().min(1).optional(),
  features: z.array(FeatureInputSchema).optional(),
  vscodeExtensions: z.array(ExtensionIdSchema).optional(),
  prewarmImages: z.array(z.string()).optional(),
  dind: z.boolean().optional(),
  postCreateCommand: z.string().optional(),
  postStartCommand: z.string().optional(),
  repositories: z.array(RepositorySchema).optional(),
  forwardPorts: z.array(z.number().int().min(1).max(65535)).optional(),
  sharedVolumes: SharedVolumesSchema.optional(),
  secrets: z.array(SecretInputSchema).optional(),
  /** Replaces the whole list. Part of the image: a change mints a version, like features. */
  agentAppIds: z.array(z.string().min(1).max(100)).max(10).optional(),
}).extend(TaskSettingsSchema.shape)

// ─── Shared services ──────────────────────────────────────────────────────────

/**
 * A service's slug doubles as a **DNS label** (workers reach it at `http://<slug>:…`)
 * and as a reverse-proxy subdomain prefix (`svc-<slug>.localhost`), so it's held to
 * what both accept: lowercase alphanumerics and inner hyphens.
 */
export const ServiceSlugSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, "Slug must be a DNS label: lowercase letters, digits and inner hyphens")

/** Either a literal value or a reference to a global secret — never both, never neither. */
export const ServiceEnvVarSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.]*$/, "Invalid environment variable name"),
    value: z.string().optional(),
    secretName: z.string().optional(),
  })
  .refine((v) => (v.value === undefined) !== (v.secretName === undefined), {
    message: "Provide either a value or a secretName",
  })

export const ServicePortSchema = z.object({
  container: z.number().int().min(1).max(65535),
  /** Absent/null = reachable over the shared network only, not published on the host. */
  host: z.number().int().min(1).max(65535).nullable().optional(),
})

export const ServiceVolumeSchema = z.object({
  // Suffix of the real volume `mp-svc-<serviceId>-<name>`, so it has to be a safe
  // Docker volume-name fragment.
  name: z.string().regex(/^[a-z0-9][a-z0-9_.-]*$/, "Volume name must be lowercase alphanumeric"),
  mountPath: z.string().startsWith("/", "Mount path must be absolute"),
})

export const ServiceRestartPolicySchema = z.enum(["no", "unless-stopped", "always", "on-failure"])

export const CreateServiceSchema = z.object({
  slug: ServiceSlugSchema,
  description: z.string().optional(),
  image: z.string().min(1),
  command: z.string().nullable().optional(),
  env: z.array(ServiceEnvVarSchema).default([]),
  ports: z.array(ServicePortSchema).default([]),
  volumes: z.array(ServiceVolumeSchema).default([]),
  httpPort: z.number().int().min(1).max(65535).nullable().optional(),
  restartPolicy: ServiceRestartPolicySchema.default("unless-stopped"),
  /** Start the container right away (the default). False creates the spec only. */
  start: z.boolean().default(true),
})

/**
 * PATCH shape — plain-optional throughout, "absent" meaning "leave unchanged".
 * Same reasoning as `UpdateProjectSchema`: `.partial()` would keep the `.default([])`
 * and silently wipe env/ports/volumes on a PATCH that never mentioned them.
 */
export const UpdateServiceSchema = z.object({
  slug: ServiceSlugSchema.optional(),
  description: z.string().nullable().optional(),
  image: z.string().min(1).optional(),
  command: z.string().nullable().optional(),
  env: z.array(ServiceEnvVarSchema).optional(),
  ports: z.array(ServicePortSchema).optional(),
  volumes: z.array(ServiceVolumeSchema).optional(),
  httpPort: z.number().int().min(1).max(65535).nullable().optional(),
  restartPolicy: ServiceRestartPolicySchema.optional(),
})

export type CreateServiceInput = z.infer<typeof CreateServiceSchema>
export type UpdateServiceInput = z.infer<typeof UpdateServiceSchema>

export const SettingsSchema = z.object({
  gitUserName: z.string().nullable().optional(),
  gitUserEmail: z.string().nullable().optional(),
  sshKeyPath: z.string().nullable().optional(),
  /**
   * A **full** clone URL, or empty. Not an `owner/repo` shorthand, on purpose: the shared package
   * expands a bare shorthand against one company's domain, which is an assumption Lite doesn't
   * make anywhere else — a dotfiles repo lives wherever the SSH key reaches, and the URL is how
   * you say where.
   */
  dotfilesRepo: z
    .string()
    .refine(
      (v) => v.trim() === "" || /^(https?:\/\/|ssh:\/\/|git:\/\/|file:\/\/|[^/\s]+@[^/\s]+:)/.test(v.trim()),
      "Use a full clone URL (git@host:owner/repo.git, https://…), not an owner/repo shorthand",
    )
    .nullable()
    .optional(),
  // Plaintext SA key: string to set, null to clear, absent to leave unchanged.
  gcpRegistryKey: z.string().nullable().optional(),
})

export type CreateProjectInput = z.infer<typeof CreateProjectSchema>
export type UpdateProjectInput = z.infer<typeof UpdateProjectSchema>
export type RepositoryInput = z.infer<typeof RepositorySchema>

// ─── Delegated work (docs/tasks.md) ───────────────────────────────────────────

/**
 * A git ref a user typed. Checked here rather than left to `git checkout` minutes later in a
 * worker: the branch setup quotes it either way, but an error at the POST is one the person
 * delegating can still act on. The rules are `git check-ref-format`'s, minus the obscure ones.
 */
export function isValidGitRef(ref: string): boolean {
  if (!ref || ref.length > 255) return false
  if (ref.startsWith("-") || ref.startsWith("/") || ref.endsWith("/") || ref.endsWith(".") || ref.endsWith(".lock")) return false
  if (ref.includes("..") || ref.includes("//") || ref.includes("@{") || ref === "@") return false
  return !/[\x00-\x20\x7f~^:?*[\\]/.test(ref)
}

/** A file dropped into a prompt or a reply (RFC 0022) — base64 in a JSON body. */
export const TaskFileInputSchema = z.object({
  filename: z.string().max(480).nullish(),
  mediaType: z.string().min(1).max(255),
  data: z.string().min(1),
})

export const CreateTaskSchema = z.object({
  /** Optional: without one the task starts under the prompt's first line, then takes the session's own name. */
  title: z.string().trim().min(1).max(200).optional(),
  prompt: z.string().trim().min(1).max(50_000),
  files: z.array(TaskFileInputSchema).max(10).optional(),
  baseBranch: z.string().trim().max(255).refine((v) => v === "" || isValidGitRef(v), "Invalid git branch name").optional(),
  model: z.string().trim().max(200).optional(),
  /** The harness picked — one of the project's `agentAppIds`. Absent = the project's default. */
  agentAppId: z.string().max(100).nullable().optional(),
  /** The app's own parameters (`{ effort: "high" }`), checked against its catalog. */
  agentOptions: z.record(z.string(), z.string().max(200)).nullable().optional(),
})

export const TaskMessageSchema = z.object({
  prompt: z.string().trim().min(1).max(50_000),
  files: z.array(TaskFileInputSchema).max(10).optional(),
})

export const RenameTaskSchema = z.object({ title: z.string().trim().min(1).max(200) })

export type CreateTaskInput = z.infer<typeof CreateTaskSchema>
