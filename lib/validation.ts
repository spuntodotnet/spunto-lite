import { z } from "zod"
import { EXTENSION_ID_HINT, EXTENSION_ID_RE } from "./extensions"

/**
 * A VS Code extension id, checked for shape before it ever reaches the build
 * script. Existence in the registry is checked in the UI at add time
 * (`/api/extensions?id=`); this is the last line of defence against a typo
 * travelling all the way to a `code-server --install-extension` that fails
 * ten minutes later inside a Docker build.
 */
export const ExtensionIdSchema = z.string().regex(EXTENSION_ID_RE, EXTENSION_ID_HINT)

export const RepositorySchema = z.object({
  id: z.string(),
  provider: z.enum(["github", "gitlab", "bitbucket", "git"]),
  // Display label, e.g. "owner/repo" for GitHub or a name derived from the clone URL.
  project: z.string(),
  workspacePath: z.string(),
  // Raw clone URL for generic ("git") repos, e.g. git@gitlab.com:group/repo.git
  cloneUrl: z.string().optional(),
  // Default branch to clone; absent/empty = the remote's default (HEAD).
  branch: z.string().optional(),
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
  secrets: z.array(SecretInputSchema).optional(),
})

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
  secrets: z.array(SecretInputSchema).optional(),
})

export const SettingsSchema = z.object({
  gitUserName: z.string().nullable().optional(),
  gitUserEmail: z.string().nullable().optional(),
  sshKeyPath: z.string().nullable().optional(),
  dotfilesRepo: z.string().nullable().optional(),
  // Plaintext SA key: string to set, null to clear, absent to leave unchanged.
  gcpRegistryKey: z.string().nullable().optional(),
})

export type CreateProjectInput = z.infer<typeof CreateProjectSchema>
export type UpdateProjectInput = z.infer<typeof UpdateProjectSchema>
export type RepositoryInput = z.infer<typeof RepositorySchema>
