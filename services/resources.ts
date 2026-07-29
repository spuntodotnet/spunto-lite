import { db } from "../db/index"
import { workers, projects, services } from "../db/schema"
import { getContainerState, getContainerStats, getSystemDf } from "../lib/docker"
import { parseSharedVolumeName, sharedVolumeName } from "../lib/shared-volumes"
import { serviceAddress } from "./services"

// Aggregated, cross-project view of everything the control plane has running on
// the local Docker daemon: worker containers and shared-service containers (both
// with live CPU/memory), the named volumes they own, and the per-project images
// that were built for them. Powers the "Resources" page — the one place to see
// what's switched on without opening each project.

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

// mp-worker-<workerId>-<workspace|docker|containerd>
const WORKER_VOLUME_RE = /^mp-worker-(.+)-(workspace|docker|containerd)$/
// mp-svc-<serviceId>-<name> — the service id is 12 lowercase alphanumerics (lib/id.ts),
// so the split is unambiguous even for a volume name containing hyphens.
const SERVICE_VOLUME_RE = /^mp-svc-([a-z0-9]{12})-(.+)$/
// mp-proj-<projectId>:v<n>
const PROJECT_IMAGE_RE = /^mp-proj-(.+):v(\d+)$/

/**
 * Reconciles every worker's DB state against the live container (a light inspect,
 * no in-container exec) and fetches CPU/memory for the running ones, then folds in
 * the daemon's volume/image accounting. All the per-container work runs in
 * parallel — the page polls this, so it stays responsive with many workers.
 */
export async function getResourcesOverview(): Promise<ResourcesOverview> {
  const workerRows = db.select().from(workers).all()
  const projectRows = db.select().from(projects).all()
  const serviceRows = db.select().from(services).all()
  const projectById = new Map(projectRows.map((p) => [p.id, p]))

  const [live, liveServices, df] = await Promise.all([
    Promise.all(
      workerRows.map(async (w): Promise<WorkerResource> => {
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

        const cState = await getContainerState(w.containerId).catch(() => "error" as const)
        const running = cState === "running"
        // Correct the stored state against reality without a heavy setup-file read:
        // a container that's gone/stopped reads as "stopped"; a live one keeps its
        // building/starting/ready phase (bumping a stale "stopped" back up).
        let state = w.state
        if (cState === "stopped" || cState === "not_found") state = "stopped"
        else if (running && w.state === "stopped") state = "ready"

        const stats = running ? await getContainerStats(w.containerId).catch(() => null) : null
        return { ...base, state, running, stats }
      }),
    ),
    Promise.all(
      serviceRows.map(async (s): Promise<ServiceResource> => {
        const base = {
          id: s.id,
          slug: s.slug,
          image: s.image,
          address: serviceAddress(s),
          createdAt: (s.createdAt instanceof Date ? s.createdAt : new Date(s.createdAt)).toISOString(),
        }
        if (!s.containerId) return { ...base, state: s.state, running: false, stats: null }
        const cState = await getContainerState(s.containerId).catch(() => "error" as const)
        const running = cState === "running"
        let state = s.state
        if (cState === "stopped" || cState === "not_found") state = s.state === "error" ? "error" : "stopped"
        else if (running && s.state !== "ready") state = "ready"
        const stats = running ? await getContainerStats(s.containerId).catch(() => null) : null
        return { ...base, state, running, stats }
      }),
    ),
    getSystemDf().catch(() => ({ volumes: [], images: [] })),
  ])

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
    .filter((v) => ["mp-worker-", "mp-proj-", "mp-svc-"].some((p) => v.name.startsWith(p)))
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
          // The daemon's own count of containers referencing the volume — i.e.
          // exactly how many workers mount it, running or stopped.
          mountedBy: v.refCount >= 0 ? v.refCount : null,
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

  return {
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
