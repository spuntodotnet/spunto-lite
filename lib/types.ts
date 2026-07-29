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

/** A project-level volume mounted in every worker of the project. */
export type SharedVolume = { name: string; mountPath: string }

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
  sharedVolumes: SharedVolume[]
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

// ─── Shared services (cross-project, "Ship" local) ───────────────────────────

/** Either a literal `value` or `secretName`, the name of a global secret. */
export type ServiceEnvVar = { name: string; value?: string; secretName?: string }
/** `host` absent/null = reachable over the shared network only, not published on the machine. */
export type ServicePort = { container: number; host?: number | null }
export type ServiceVolume = { name: string; mountPath: string }
export type ServiceRestartPolicy = "no" | "unless-stopped" | "always" | "on-failure"
/** Same vocabulary as `WorkerState`, so the status pills are shared. */
export type ServiceState = "pending" | "starting" | "ready" | "stopped" | "error"

export type Service = {
  id: string
  slug: string
  description: string | null
  image: string
  /** Overrides the image's CMD (tokenised as a shell would quote it, not run by one). */
  command: string | null
  env: ServiceEnvVar[]
  ports: ServicePort[]
  volumes: ServiceVolume[]
  httpPort: number | null
  restartPolicy: ServiceRestartPolicy
  containerId: string | null
  state: ServiceState
  error: string | null
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

export type ServiceResource = {
  id: string
  slug: string
  image: string
  state: string
  running: boolean
  /** In-cluster address workers use, e.g. `http://elasticsearch:9200`. */
  address: string
  createdAt: string
  stats: ContainerStats | null
}

export type VolumeResource = {
  name: string
  sizeBytes: number
  /**
   * `shared` is a project-level volume mounted in every worker of that project;
   * `service` belongs to a shared service, not to any project.
   */
  kind: "workspace" | "docker" | "containerd" | "shared" | "service" | "other"
  workerId: string | null
  workerName: string | null
  projectId: string | null
  projectName: string | null
  /** Set on a `service` volume: which shared service owns it. */
  serviceSlug: string | null
  /** `shared` volumes only: where it lands in each worker, and how many mount it. */
  mountPath: string | null
  mountedBy: number | null
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
    servicesTotal: number
    servicesRunning: number
    cpuPercent: number
    memUsageMb: number
    volumesCount: number
    volumesSizeBytes: number
    imagesCount: number
    imagesSizeBytes: number
  }
  workers: WorkerResource[]
  services: ServiceResource[]
  volumes: VolumeResource[]
  images: ImageResource[]
}

// ─── ⌘K search index (see services/search.ts) ────────────────────────────────

export type SearchKind = "project" | "worker" | "service" | "build" | "secret" | "template"

/** A proxied target, resolved client-side by `workerBaseUrl()` / `serviceBaseUrl()`. */
export type SearchTarget = { workerId: string; port?: number } | { serviceSlug: string; port?: number }

export type SearchHit = {
  id: string
  kind: SearchKind
  label: string
  description?: string
  meta?: string
  keywords: string[]
  /** In-app route. Absent on hits that live on a proxied subdomain, not this origin. */
  href?: string
  target?: SearchTarget
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
/** Which registry /api/extensions is resolving ids against, so the UI can name it. */
export type ExtensionRegistryInfo = {
  /** Display name — "Open VSX", or the configured gallery's host. */
  name: string
  /** Registry homepage, for "view on <name>" links. */
  homeUrl?: string
  /** True when EXTENSIONS_GALLERY overrides the Open VSX default. */
  custom: boolean
}

/** An extension as served by /api/extensions (curated defaults or registry search hits). */
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
  /** Whether the active registry actually knows it. */
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
