import { readFileSync, writeFileSync, renameSync } from "node:fs"
import { join } from "node:path"
import { db } from "../db/index"
import { workers, projects, services } from "../db/schema"
import { getContainerStats, listAllContainers, listAllImages, listAllVolumes, measureVolumeSizes } from "../lib/docker"
import type { ListedContainer } from "../lib/docker"
import { DATA_DIR } from "../lib/env"
import { track } from "../lib/telemetry"
import { parseSharedVolumeName, sharedVolumeName } from "../lib/shared-volumes"
import { serviceAddress } from "./services"

// Aggregated, cross-project view of everything the control plane has running on
// the local Docker daemon: worker containers and shared-service containers (both
// with live CPU/memory), the named volumes they own, and the per-project images
// that were built for them. Powers the "Resources" page — the one place to see
// what's switched on without opening each project.
//
// What is slow to measure is measured in the background, and the page reads the last
// measurement instead of waiting for a new one:
//
//  - **Lists** (which workers, services, volumes, images exist, what state each container is in,
//    who mounts what): read per request. Three listing calls to the daemon, milliseconds — and
//    a service or volume created a second ago is on the page.
//  - **CPU and memory**: `docker stats` waits a second per container for a second reading.
//    Sampled every STATS_INTERVAL_MS for every running container.
//  - **Volume sizes**: walking every file of every volume (`docker system df`) — minutes once
//    workers carry DinD image stores. That call on every poll is what kept the page on
//    "Loading…". Measured every SIZES_INTERVAL_MS (and on demand, `POST /api/resources/refresh`),
//    kept on disk so a restart shows the last sizes instead of nothing.

export type ContainerStats = {
  cpuPercent: number
  memUsageMb: number
  memLimitMb: number
  memPercent: number
}

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

/** How old each background measurement is, so the page can say so. */
export type ResourcesFreshness = {
  /** When CPU/memory were last sampled. Null until the first sample. */
  statsAt: string | null
  /** When volume sizes were last measured, and how long the walk took. */
  sizesAt: string | null
  sizesDurationMs: number | null
  /** Set while a measurement runs: when it started. */
  sizesMeasuringSince: string | null
  /** The last measurement's failure, if it failed — the sizes shown are then the ones before. */
  sizesError: string | null
}

export type ResourcesOverview = {
  freshness: ResourcesFreshness
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

// ─── Background measurements ─────────────────────────────────────────────────

const STATS_INTERVAL_MS = 15_000
const SIZES_INTERVAL_MS = Number(process.env.RESOURCES_SIZES_INTERVAL_MS) || 10 * 60_000
const SIZES_FILE = join(DATA_DIR, "resources-volume-sizes.json")

type StatsCache = { at: number; byContainer: Map<string, ContainerStats> }
type SizesCache = {
  at: number | null
  durationMs: number | null
  sizes: Record<string, number>
  measuringSince: number | null
  error: string | null
}
type Measurements = { stats: StatsCache | null; sizes: SizesCache; started: boolean }

// On `globalThis`, like lib/agent.ts: the refresher starts from server.ts's module graph, the
// route that reads it is bundled by Next — same process, two copies of this module.
const KEY = Symbol.for("spunto-lite.resources")
function measurements(): Measurements {
  const g = globalThis as typeof globalThis & { [KEY]?: Measurements }
  return (g[KEY] ??= { stats: null, sizes: loadSizes(), started: false })
}

function loadSizes(): SizesCache {
  const empty: SizesCache = { at: null, durationMs: null, sizes: {}, measuringSince: null, error: null }
  try {
    const saved = JSON.parse(readFileSync(SIZES_FILE, "utf8")) as Partial<SizesCache>
    return { ...empty, at: saved.at ?? null, durationMs: saved.durationMs ?? null, sizes: saved.sizes ?? {} }
  } catch {
    return empty
  }
}

function saveSizes(c: SizesCache) {
  try {
    const tmp = `${SIZES_FILE}.tmp`
    writeFileSync(tmp, JSON.stringify({ at: c.at, durationMs: c.durationMs, sizes: c.sizes }))
    renameSync(tmp, SIZES_FILE)
  } catch (err) {
    console.warn(`[resources] could not save volume sizes: ${err}`)
  }
}

/** Ids of the running containers the control plane owns — workers and shared services. */
function ownedContainerIds(): string[] {
  const rows = [
    ...db.select({ containerId: workers.containerId }).from(workers).all(),
    ...db.select({ containerId: services.containerId }).from(services).all(),
  ]
  return rows.map((r) => r.containerId).filter((id): id is string => !!id)
}

async function sampleStats(): Promise<void> {
  const owned = new Set(ownedContainerIds())
  const running = (await listAllContainers()).filter((c) => c.state === "running" && owned.has(c.id))
  const byContainer = new Map<string, ContainerStats>()
  await Promise.all(
    running.map(async (c) => {
      const stats = await getContainerStats(c.id).catch(() => null)
      if (stats) byContainer.set(c.id, stats)
    }),
  )
  measurements().stats = { at: Date.now(), byContainer }
}

/**
 * Measure every volume's size now, unless a measurement is already running (the daemon refuses
 * a second `df` while one runs anyway). Resolves when it is done; callers that only want to
 * kick it off don't await.
 */
export async function measureVolumeSizesNow(): Promise<void> {
  const m = measurements()
  if (m.sizes.measuringSince) return
  const started = Date.now()
  m.sizes.measuringSince = started
  try {
    const sizes = await measureVolumeSizes()
    const durationMs = Date.now() - started
    m.sizes = { at: Date.now(), durationMs, sizes, measuringSince: null, error: null }
    saveSizes(m.sizes)
    const own = Object.entries(sizes).filter(([name]) => OWNED_VOLUME_PREFIXES.some((p) => name.startsWith(p)))
    track("resources.volume_sizes", {
      duration_ms: durationMs,
      volumes: own.length,
      volumes_bytes: own.reduce((s, [, n]) => s + Math.max(0, n), 0),
      volumes_all: Object.keys(sizes).length,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    m.sizes = { ...m.sizes, measuringSince: null, error: message }
    console.warn(`[resources] measuring volume sizes failed: ${message}`)
    track("resources.volume_sizes_failed", { duration_ms: Date.now() - started, error: message })
  }
}

/** Start both background measurements. Once per process; started with the task scheduler. */
export function startResourcesRefresher(): void {
  const m = measurements()
  if (m.started) return
  m.started = true
  let sampling = false
  const statsTick = async () => {
    if (sampling) return
    sampling = true
    try {
      await sampleStats()
    } catch (err) {
      console.warn(`[resources] stats sampling failed: ${err}`)
    } finally {
      sampling = false
    }
  }
  setInterval(statsTick, STATS_INTERVAL_MS).unref?.()
  setInterval(() => void measureVolumeSizesNow(), SIZES_INTERVAL_MS).unref?.()
  void statsTick()
  // Sizes saved by the previous run are shown meanwhile; a fresh walk starts right away only if
  // they are older than one interval.
  if (!m.sizes.at || Date.now() - m.sizes.at > SIZES_INTERVAL_MS) void measureVolumeSizesNow()
}

// ─── The overview ────────────────────────────────────────────────────────────

const OWNED_VOLUME_PREFIXES = ["mp-worker-", "mp-proj-", "mp-svc-"]
// mp-worker-<workerId>-<workspace|docker|containerd>
const WORKER_VOLUME_RE = /^mp-worker-(.+)-(workspace|docker|containerd)$/
// mp-svc-<serviceId>-<name> — the service id is 12 lowercase alphanumerics (lib/id.ts),
// so the split is unambiguous even for a volume name containing hyphens.
const SERVICE_VOLUME_RE = /^mp-svc-([a-z0-9]{12})-(.+)$/
// mp-proj-<projectId>:v<n>[-r<recipe>] — the recipe suffix is optional because images built
// before it exists are still on disk, and this page is what shows them to be pruned. Kept in step
// with `imageRefFor` (services/workers.ts); `isProjectImageRef` from @spunto/build/naming cannot
// be used here, as it predates the suffix and rejects every tag this release produces.
const PROJECT_IMAGE_RE = /^mp-proj-(.+?):v(\d+)(?:-r\d+)?$/

/**
 * Reconciles every worker's and service's DB state against the daemon's container list (one
 * call, no per-container inspect), then folds in the volumes and images it lists, with the last
 * background measurements for what is slow to measure: CPU/memory and volume sizes. Answers in
 * milliseconds whatever is on the daemon — the page polls it.
 */
export async function getResourcesOverview(): Promise<ResourcesOverview> {
  const workerRows = db.select().from(workers).all()
  const projectRows = db.select().from(projects).all()
  const serviceRows = db.select().from(services).all()
  const projectById = new Map(projectRows.map((p) => [p.id, p]))
  const m = measurements()

  const [containers, volumeList, imageList] = await Promise.all([
    // Null when the daemon didn't answer: the stored states are then shown as they are.
    listAllContainers().catch((): ListedContainer[] | null => null),
    listAllVolumes().catch(() => []),
    listAllImages().catch(() => []),
  ])
  const containerById = new Map((containers ?? []).map((c) => [c.id, c]))
  // A container sampled before it was stopped keeps no stale bars: stats only for running ones.
  const statsOf = (id: string, running: boolean) => (running ? (m.stats?.byContainer.get(id) ?? null) : null)
  const containerState = (id: string) => {
    if (!containers) return "unknown"
    const c = containerById.get(id)
    return !c ? "not_found" : c.state === "running" ? "running" : "stopped"
  }

  const live = workerRows.map((w): WorkerResource => {
    const project = projectById.get(w.projectId)
    const base = {
      id: w.id,
      name: w.name,
      projectId: w.projectId,
      projectName: project?.name ?? "(deleted project)",
      projectVersion: w.projectVersion,
      createdAt: (w.createdAt instanceof Date ? w.createdAt : new Date(w.createdAt)).toISOString(),
    }
    if (!w.containerId) return { ...base, state: w.state, running: false, stats: null }

    const cState = containerState(w.containerId)
    const running = cState === "running"
    // Correct the stored state against reality without a heavy setup-file read:
    // a container that's gone/stopped reads as "stopped"; a live one keeps its
    // building/starting/ready phase (bumping a stale "stopped" back up).
    let state = w.state
    if (cState === "stopped" || cState === "not_found") state = "stopped"
    else if (running && w.state === "stopped") state = "ready"
    return { ...base, state, running, stats: statsOf(w.containerId, running) }
  })

  const liveServices = serviceRows.map((s): ServiceResource => {
    const base = {
      id: s.id,
      slug: s.slug,
      image: s.image,
      address: serviceAddress(s),
      createdAt: (s.createdAt instanceof Date ? s.createdAt : new Date(s.createdAt)).toISOString(),
    }
    if (!s.containerId) return { ...base, state: s.state, running: false, stats: null }
    const cState = containerState(s.containerId)
    const running = cState === "running"
    let state = s.state
    if (cState === "stopped" || cState === "not_found") state = s.state === "error" ? "error" : "stopped"
    else if (running && s.state !== "ready") state = "ready"
    return { ...base, state, running, stats: statsOf(s.containerId, running) }
  })

  // Who mounts what, and how many containers run each image — from the container list, so a
  // volume mounted a second ago counts even though its size is from the last walk.
  const mounts = new Map<string, number>()
  const imageUse = new Map<string, number>()
  for (const c of containers ?? []) {
    for (const v of c.volumes) mounts.set(v, (mounts.get(v) ?? 0) + 1)
    imageUse.set(c.imageId, (imageUse.get(c.imageId) ?? 0) + 1)
  }
  const df = {
    volumes: volumeList.map((v) => ({ name: v.name, sizeBytes: m.sizes.sizes[v.name] ?? -1, refCount: mounts.get(v.name) ?? 0 })),
    images: imageList.map((i) => ({ ...i, containers: imageUse.get(i.id) ?? 0 })),
  }

  const workerById = new Map(live.map((w) => [w.id, w]))
  const serviceById = new Map(serviceRows.map((s) => [s.id, s]))

  // Declared shared volumes, keyed by the Docker name they get. A `mp-proj-…`
  // volume that isn't in here is one whose declaration (or whose project) is
  // gone — it stays listed, so its disk usage never becomes invisible.
  const declaredShared = new Map(
    projectRows.flatMap((p) =>
      (p.sharedVolumes ?? []).map((v) => [sharedVolumeName(p.id, v.name), { project: p, mountPath: v.mountPath }] as const),
    ),
  )

  const volumes: VolumeResource[] = df.volumes
    .filter((v) => OWNED_VOLUME_PREFIXES.some((p) => v.name.startsWith(p)))
    .map((v): VolumeResource => {
      const base = {
        name: v.name,
        sizeBytes: v.sizeBytes,
        inUse: v.refCount > 0,
        workerId: null,
        workerName: null,
        projectId: null,
        projectName: null,
        serviceSlug: null,
        mountPath: null,
        mountedBy: null,
      }

      const svc = v.name.match(SERVICE_VOLUME_RE)
      if (svc) {
        // A shared service's data volume: no worker, no project — it belongs to the
        // service, and outlives every environment that used it.
        return { ...base, kind: "service", serviceSlug: serviceById.get(svc[1])?.slug ?? null }
      }

      if (v.name.startsWith("mp-proj-")) {
        const declared = declaredShared.get(v.name)
        const projectId = declared?.project.id ?? parseSharedVolumeName(v.name)?.projectId ?? null
        return {
          ...base,
          kind: "shared",
          projectId,
          projectName: declared?.project.name ?? (projectId ? (projectById.get(projectId)?.name ?? null) : null),
          mountPath: declared?.mountPath ?? null,
          // Containers referencing the volume, running or stopped — i.e. exactly
          // how many workers mount it.
          mountedBy: v.refCount,
        }
      }

      const m = v.name.match(WORKER_VOLUME_RE)
      const workerId = m?.[1] ?? null
      const worker = workerId ? workerById.get(workerId) : undefined
      return {
        ...base,
        kind: (m?.[2] ?? "other") as VolumeResource["kind"],
        workerId,
        workerName: worker?.name ?? null,
        projectId: worker?.projectId ?? null,
        projectName: worker?.projectName ?? null,
      }
    })
    .sort((a, b) => b.sizeBytes - a.sizeBytes)

  const images: ImageResource[] = df.images
    .flatMap((img) =>
      img.repoTags
        .filter((t) => t.startsWith("mp-proj-"))
        .map((ref) => {
          const m = ref.match(PROJECT_IMAGE_RE)
          const projectId = m?.[1] ?? null
          return {
            ref,
            sizeBytes: img.sizeBytes,
            containers: img.containers,
            projectId,
            projectName: projectId ? (projectById.get(projectId)?.name ?? "(deleted project)") : null,
            version: m ? Number(m[2]) : null,
          }
        }),
    )
    .sort((a, b) => b.sizeBytes - a.sizeBytes)

  const running = live.filter((w) => w.running)
  const runningServices = liveServices.filter((s) => s.running)
  const knownSize = (n: number) => (n >= 0 ? n : 0)
  // CPU/memory are summed over *every* running container the control plane owns:
  // a shared Elasticsearch is often the heaviest thing on the machine, so leaving
  // it out of the totals would make the dashboard lie.
  const busy = [...running, ...runningServices]

  const iso = (t: number | null | undefined) => (t ? new Date(t).toISOString() : null)
  return {
    freshness: {
      statsAt: iso(m.stats?.at),
      sizesAt: iso(m.sizes.at),
      sizesDurationMs: m.sizes.durationMs,
      sizesMeasuringSince: iso(m.sizes.measuringSince),
      sizesError: m.sizes.error,
    },
    totals: {
      workersTotal: live.length,
      workersRunning: running.length,
      servicesTotal: liveServices.length,
      servicesRunning: runningServices.length,
      cpuPercent: Math.round(busy.reduce((s, c) => s + (c.stats?.cpuPercent ?? 0), 0) * 100) / 100,
      memUsageMb: Math.round(busy.reduce((s, c) => s + (c.stats?.memUsageMb ?? 0), 0) * 100) / 100,
      volumesCount: volumes.length,
      volumesSizeBytes: volumes.reduce((s, v) => s + knownSize(v.sizeBytes), 0),
      imagesCount: images.length,
      imagesSizeBytes: images.reduce((s, i) => s + knownSize(i.sizeBytes), 0),
    },
    workers: live.sort((a, b) => Number(b.running) - Number(a.running) || a.name.localeCompare(b.name)),
    services: liveServices.sort((a, b) => Number(b.running) - Number(a.running) || a.slug.localeCompare(b.slug)),
    volumes,
    images,
  }
}
