import { z } from "zod"

export const RepositorySchema = z.object({
  id: z.string(),
  provider: z.enum(["github", "gitlab", "bitbucket", "git"]),
  // Display label, e.g. "owner/repo" for GitHub or a name derived from the clone URL.
  project: z.string(),
  workspacePath: z.string(),
  // Raw clone URL for generic ("git") repos, e.g. git@gitlab.com:group/repo.git
  cloneUrl: z.string().optional(),
})

export const SecretInputSchema = z.object({
  name: z.string().regex(/^[A-Z][A-Z0-9_]*$/, "Name must be UPPER_SNAKE_CASE"),
  value: z.string().min(1),
})

export const FeatureInputSchema = z.object({
  id: z.string(),
  options: z.record(z.string(), z.string()).optional(),
})

export const CreateProjectSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  image: z.string().min(1),
  features: z.array(FeatureInputSchema).default([]),
  vscodeExtensions: z.array(z.string()).default([]),
  prewarmImages: z.array(z.string()).default([]),
  dind: z.boolean().default(false),
  postCreateCommand: z.string().optional(),
  postStartCommand: z.string().optional(),
  repositories: z.array(RepositorySchema).default([]),
  forwardPorts: z.array(z.number().int().min(1).max(65535)).default([]),
  secrets: z.array(SecretInputSchema).optional(),
})

export const UpdateProjectSchema = CreateProjectSchema.partial()

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
