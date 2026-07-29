// Project-scoped persistent volumes: named Docker volumes declared on a project
// and mounted into **every** worker it spawns, on top of that worker's private
// `/workspace`. What they're for: a pnpm store, `~/.m2`, a `~/.cache`, a heavy
// dataset or a build-artifact directory that two workers of the same project
// would otherwise download or regenerate twice.
//
// Pure helpers — no Docker, no DB, no React — so the API validation, the spawn
// path, the Resources page and the project form all agree on one set of rules.
//
// **Concurrency is not managed.** Several workers write into the same volume at
// the same time and nothing locks: that's fine for caches and read-mostly data,
// and wrong for a shared SQLite database or a lockfile two processes rewrite.

/** One shared volume, as a project declares it. */
export type SharedVolume = {
  /** Per-project slug; the Docker volume is `mp-proj-<projectId>-<name>`. */
  name: string
  /** Absolute path it is mounted at inside every worker. */
  mountPath: string
}

/** Volume-name charset, tightened from Docker's own so the composed name stays readable. */
export const SHARED_VOLUME_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/
export const SHARED_VOLUME_NAME_HINT =
  "Use lowercase letters, digits, '.', '_' or '-', starting with a letter or a digit (e.g. pnpm-store)"
const MAX_NAME_LENGTH = 40

/**
 * Paths a shared volume may never be mounted on. `/workspace` first and
 * foremost: it would shadow the worker's own volume, hiding the clone and
 * breaking the setup script's idempotent-clone guard. The two DinD paths are the
 * per-worker `mp-worker-<id>-{docker,containerd}` volumes, and the last three are
 * kernel filesystems.
 */
export const RESERVED_MOUNT_PATHS = [
  "/workspace",
  "/var/lib/docker",
  "/var/lib/containerd",
  "/proc",
  "/sys",
  "/dev",
]

/** The Docker volume backing a project's shared volume. */
export function sharedVolumeName(projectId: string, name: string): string {
  return `mp-proj-${projectId}-${name}`
}

/**
 * Reverse of `sharedVolumeName`. Project ids are 12 lowercase alphanumerics
 * (`lib/id.ts`) with no dash, so the split is unambiguous even for a volume
 * whose own name contains dashes.
 */
const SHARED_VOLUME_RE = /^mp-proj-([0-9a-z]{12})-(.+)$/

export function parseSharedVolumeName(volume: string): { projectId: string; name: string } | null {
  const m = volume.match(SHARED_VOLUME_RE)
  return m ? { projectId: m[1], name: m[2] } : null
}

/** `"/home/vscode/.cache/"` → `"/home/vscode/.cache"`. Trailing slashes only. */
export function normalizeMountPath(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length <= 1) return trimmed
  return trimmed.replace(/\/+$/, "") || "/"
}

/** Message to show, or null when the path is a usable mount point. */
export function validateMountPath(raw: string): string | null {
  const path = normalizeMountPath(raw)
  if (!path) return "Mount path is required"
  if (!path.startsWith("/")) return `Mount path must be absolute (got "${path}")`
  if (path === "/") return "Mount path can't be /"
  if (path.split("/").includes("..")) return `Mount path can't contain ".." (got "${path}")`
  const reserved = RESERVED_MOUNT_PATHS.find((r) => path === r || path.startsWith(`${r}/`))
  if (reserved) {
    return reserved === "/workspace"
      ? `${path} is inside /workspace, which is each worker's own volume — pick a path outside it`
      : `${path} is reserved by the worker runtime (${reserved})`
  }
  return null
}

/** Message to show, or null when the whole declaration is valid. */
export function validateSharedVolumes(volumes: SharedVolume[]): string | null {
  const names = new Set<string>()
  const paths = new Set<string>()
  for (const v of volumes) {
    const name = v.name.trim()
    if (!name) return "Shared volume name is required"
    if (name.length > MAX_NAME_LENGTH) return `Shared volume name "${name}" is too long (max ${MAX_NAME_LENGTH})`
    if (!SHARED_VOLUME_NAME_RE.test(name)) return `Invalid shared volume name "${name}". ${SHARED_VOLUME_NAME_HINT}`
    const pathError = validateMountPath(v.mountPath)
    if (pathError) return pathError
    if (names.has(name)) return `Duplicate shared volume name "${name}"`
    const path = normalizeMountPath(v.mountPath)
    if (paths.has(path)) return `Two shared volumes are mounted at ${path}`
    names.add(name)
    paths.add(path)
  }
  return null
}

/**
 * A row the user added and hasn't filled in yet is not a volume: the form drops
 * it on submit, so anything counting volumes for the user (the fold's summary,
 * the build manifest) has to agree, or it claims one more than gets saved.
 */
export function isDeclaredVolume(v: SharedVolume): boolean {
  return !!(v.name.trim() || v.mountPath.trim())
}

/** `HostConfig.Binds` entries for a project's shared volumes. */
export function sharedVolumeBinds(projectId: string, volumes: SharedVolume[]): string[] {
  return volumes.map((v) => `${sharedVolumeName(projectId, v.name)}:${normalizeMountPath(v.mountPath)}`)
}
