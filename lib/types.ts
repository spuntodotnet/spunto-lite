// Client-facing types (kept separate from db/schema.ts so client bundles never
// pull in better-sqlite3/drizzle runtime).

export type Repository = {
  id: string
  provider: "github" | "gitlab" | "bitbucket" | "git"
  project: string
  workspacePath: string
  cloneUrl?: string
}

export type ProjectFeature = { id: string; options?: Record<string, string>; ociRef?: string; localScript?: string }

export type SetupStatus = {
  phase: "pending" | "initializing" | "credentials" | "dotfiles" | "cloning" | "features" | "lifecycle" | "ready" | "error"
  repos: { name: string; state: "pending" | "cloning" | "done" | "error" }[]
  postCreate: "pending" | "running" | "done" | "error" | null
  postStart: "pending" | "running" | "done" | "error" | null
  error?: string
}

export type Project = {
  id: string
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
  currentVersion: number
  favorite: boolean
  createdAt: string
  deployPublicKey: string | null
}

export type WorkerState = "pending" | "building" | "starting" | "ready" | "stopped" | "error"

export type Worker = {
  id: string
  projectId: string
  name: string
  containerId: string | null
  state: WorkerState
  setupStatus: SetupStatus | null
  projectVersion: number
  tags: string[]
  createdAt: string
}

export type ProjectVersion = {
  id: string
  projectId: string
  version: number
  config: Omit<Project, "id" | "currentVersion" | "favorite" | "createdAt" | "deployPublicKey">
  createdAt: string
}

export type ProjectImageBuild = {
  id: string
  projectId: string
  version: number
  imageRef: string
  state: "building" | "ready" | "error"
  logs: string
  createdAt: string
}

export type SecretMeta = { id: string; name: string }
export type Settings = { id: string; gitUserName: string | null; gitUserEmail: string | null; sshKeyPath: string | null }
export type HostKey = { name: string; hasPublic: boolean }

export type DevImage = { id: string; label: string; image: string; description: string }
export type DevFeature = {
  id: string
  label: string
  ociRef?: string
  localScript?: string
  description: string
  options?: { name: string; default: string; description: string }[]
}
export type ExtensionSuggestion = { id: string; label: string }
export type Template = {
  id: string
  name: string
  description: string
  stack: string
  image: string
  features?: { id: string; options?: Record<string, string> }[]
  postCreateCommand: string
  postStartCommand: string
  forwardPorts: number[]
}
