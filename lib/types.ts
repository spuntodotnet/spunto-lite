// Client-facing types (kept separate from db/schema.ts so client bundles never
// pull in better-sqlite3/drizzle runtime).

export type Repository = {
  id: string
  provider: "github" | "gitlab" | "bitbucket" | "git"
  project: string
  workspacePath: string
  cloneUrl?: string
  branch?: string
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
  /** Branch requested at creation, checked out instead of the remote default. */
  branch: string | null
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

// ─── Resources overview (cross-project) ──────────────────────────────────────

export type ContainerStats = { cpuPercent: number; memUsageMb: number; memLimitMb: number; memPercent: number }

export type WorkerResource = {
  id: string
  name: string
  projectId: string
  projectName: string
  state: string
  running: boolean
  projectVersion: number
  createdAt: string
  stats: ContainerStats | null
}

export type VolumeResource = {
  name: string
  sizeBytes: number
  kind: "workspace" | "docker" | "containerd" | "other"
  workerId: string | null
  workerName: string | null
  projectName: string | null
  inUse: boolean
}

export type ImageResource = {
  ref: string
  sizeBytes: number
  containers: number
  projectId: string | null
  projectName: string | null
  version: number | null
}

export type ResourcesOverview = {
  totals: {
    workersTotal: number
    workersRunning: number
    cpuPercent: number
    memUsageMb: number
    volumesCount: number
    volumesSizeBytes: number
    imagesCount: number
    imagesSizeBytes: number
  }
  workers: WorkerResource[]
  volumes: VolumeResource[]
  images: ImageResource[]
}

// ─── ⌘K search index (see services/search.ts) ────────────────────────────────

export type SearchKind = "project" | "worker" | "service" | "build" | "secret" | "template"

export type SearchHit = {
  id: string
  kind: SearchKind
  label: string
  description?: string
  meta?: string
  keywords: string[]
  /** In-app route. Absent on `service` hits, which don't live on this origin. */
  href?: string
  /** Worker-hosted target, resolved client-side by `workerBaseUrl()`. */
  target?: { workerId: string; port?: number }
}

export type SearchIndex = { hits: SearchHit[]; generatedAt: string }

export type SecretMeta = { id: string; name: string }
export type Settings = { id: string; gitUserName: string | null; gitUserEmail: string | null; sshKeyPath: string | null; dotfilesRepo: string | null; gcpRegistryConfigured: boolean }
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
/** An extension as served by /api/extensions (curated defaults or Open VSX search hits). */
export type ExtensionSuggestion = {
  id: string
  label: string
  publisher: string
  description?: string
  downloads?: number
  verified?: boolean
  /** Latest published version, and the extension's own icon on Open VSX. */
  version?: string
  iconUrl?: string
  url?: string
}

/** Verdict of /api/extensions?id=… for a hand-typed identifier. */
export type ExtensionLookup = {
  id: string
  /** Shape check: `publisher.extension-id`. */
  valid: boolean
  /** Whether Open VSX actually knows it. */
  found: boolean
  extension: ExtensionSuggestion | null
}
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
