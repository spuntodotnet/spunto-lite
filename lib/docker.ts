import Docker from "dockerode"
import { existsSync } from "node:fs"
import { hostname } from "node:os"
import { getGcpRegistryKey, normalizeGcpKey } from "../services/settings"
import { gcpAccessTokenFromCredential } from "./gcp-token"
import { sharedVolumeBinds, type SharedVolume } from "./shared-volumes"

// Docker operations, ported/simplified from apps/agent/src/docker.ts. The control
// plane talks straight to the local daemon — no remote agent, no OTLP telemetry
// network. Private GCP Artifact Registry / GCR base images work via a configured
// GCP credential (see getAuthForImage below); other registries are assumed public.

export const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET || "/var/run/docker.sock" })

// ── Private-registry auth (GCP Artifact Registry / GCR) ───────────────────────
//
// dockerode does NOT read ~/.docker/config.json. So we resolve a GCP credential
// ourselves and mint a short-lived OAuth2 access token, passing it to the daemon
// as `oauth2accesstoken` — exactly what `docker-credential-gcloud` does on the
// host. The credential can be a service-account key OR a gcloud user credential
// (authorized_user / application_default_credentials.json), see lib/gcp-token.ts.
//
// Source of the credential, in order: the encrypted value configured in the UI
// (Settings → Container registry, stored in SQLite), then the GCP_SA_KEY env var
// as a headless/CI fallback. Neither → behaves as before (public images only).
function gcpRegistryCredential(): string | null {
  return getGcpRegistryKey() ?? normalizeGcpKey(process.env.GCP_SA_KEY)
}

// Registry hostname of an image ref: "europe-west1-docker.pkg.dev/p/r/i:t" → the
// first segment. Docker Hub short refs (no dot/colon in the first segment) → null.
function registryHost(image: string): string | null {
  const first = image.split("/")[0]
  if (!first.includes(".") && !first.includes(":")) return null
  return first
}

function isGcpRegistry(host: string): boolean {
  return host.endsWith(".pkg.dev") || host === "gcr.io" || host.endsWith(".gcr.io")
}

type RegistryAuth = { username: string; password: string; serveraddress: string }

// Auth for a plain `docker pull` (dockerode `authconfig`). Returns undefined for
// public / non-GCP registries or when no credential is configured. Mints a fresh
// access token from the configured GCP credential.
export async function getAuthForImage(image: string): Promise<RegistryAuth | undefined> {
  const host = registryHost(image)
  if (!host || !isGcpRegistry(host)) return undefined
  const cred = gcpRegistryCredential()
  if (!cred) return undefined
  const token = await gcpAccessTokenFromCredential(cred)
  return { username: "oauth2accesstoken", password: token, serveraddress: host }
}

// Auth map for a `docker build` — the FROM base image is pulled by the daemon,
// which takes a per-registry map via the X-Registry-Config header (dockerode
// `registryconfig` build option), not a single authconfig.
export async function getRegistryConfigForImage(
  image: string,
): Promise<Record<string, { username: string; password: string }> | undefined> {
  const auth = await getAuthForImage(image)
  if (!auth) return undefined
  return { [auth.serveraddress]: { username: auth.username, password: auth.password } }
}

export function workerNetworkName(workerId: string): string {
  return `mp-worker-${workerId}-net`
}
function containerName(workerId: string): string {
  return `mp-worker-${workerId}`
}

async function ensureNetwork(networkName: string): Promise<void> {
  const networks = await docker.listNetworks({ filters: { name: [networkName] } })
  if (networks.find((n) => n.Name === networkName)) return
  try {
    await docker.createNetwork({ Name: networkName, Driver: "bridge" })
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode !== 409) throw err
  }
}

// ─── Shared network (workers ⇄ shared services) ───────────────────────────────
//
// Each worker still gets its own `mp-worker-<id>-net`, created at spawn and torn
// down with it. On top of that, one bridge shared by everything: every shared
// service joins it under a DNS alias equal to its slug, and every worker joins it
// at spawn — so `curl http://elasticsearch:9200` resolves from any worker.
//
// The alternative was to attach each service to each worker's own network instead.
// It isolates better (you'd pick which worker sees what) but costs a connect for
// every (worker, service) pair, replayed on every spawn *and* every service
// creation — and there's nothing to isolate from on a single-user local machine.
// One common bridge it is; per-project scoping can come later as a filter on top.
//
// Unlike a worker network, this one is *never* removed: it's infrastructure shared
// by objects with independent lifecycles, so no single deletion owns it.
export const SHARED_NETWORK_NAME = "mp-shared-net"

export async function ensureSharedNetwork(): Promise<void> {
  await ensureNetwork(SHARED_NETWORK_NAME)
}

/**
 * Joins a container to the shared network, optionally under DNS aliases. Creates
 * the network if needed and is idempotent — re-connecting an already-attached
 * container is a no-op, not an error. Best effort: a worker that can't reach the
 * shared services must still boot, so a failure here is logged, never thrown.
 */
export async function connectToSharedNetwork(containerId: string, aliases: string[] = []): Promise<void> {
  try {
    await ensureSharedNetwork()
    const info = await docker.getContainer(containerId).inspect()
    if (info.NetworkSettings.Networks?.[SHARED_NETWORK_NAME]) return
    await docker
      .getNetwork(SHARED_NETWORK_NAME)
      .connect({ Container: containerId, ...(aliases.length > 0 ? { EndpointConfig: { Aliases: aliases } } : {}) })
  } catch (err: unknown) {
    if (!(err as Error).message?.includes("already")) {
      console.warn(`[docker] connectToSharedNetwork(${containerId}):`, (err as Error).message)
    }
  }
}

/**
 * Connects the control-plane container itself to a worker network so it can reach
 * the worker's container IP directly (for the reverse proxy). No-op outside Docker.
 */
export async function connectSelfToNetwork(networkName: string): Promise<void> {
  if (!existsSync("/.dockerenv")) return
  const selfId = hostname()
  try {
    const networks = await docker.listNetworks({ filters: { name: [networkName] } })
    const net = networks.find((n) => n.Name === networkName)
    if (!net) return
    const info = await docker.getNetwork(net.Id).inspect()
    if (Object.keys(info.Containers ?? {}).some((id) => id.startsWith(selfId))) return
    await docker.getNetwork(net.Id).connect({ Container: selfId })
  } catch (err: unknown) {
    if (!(err as Error).message?.includes("already")) {
      console.warn(`[docker] connectSelfToNetwork(${networkName}):`, (err as Error).message)
    }
  }
}

// ─── Spawn ────────────────────────────────────────────────────────────────────

export type SpawnParams = {
  workerId: string
  projectId: string
  image: string
  script: string
  env: string[]
  hasDinD: boolean
  /** Project-level volumes mounted in every worker, alongside its own /workspace. */
  sharedVolumes: SharedVolume[]
  labels: Record<string, string>
}

/** Pulls `image` unless the daemon already has it (with private-registry auth if needed). */
export async function ensureImage(image: string): Promise<void> {
  const exists = await docker.getImage(image).inspect().then(() => true).catch(() => false)
  if (exists) return
  const authconfig = await getAuthForImage(image)
  await new Promise<void>((resolve, reject) => {
    docker.pull(image, authconfig ? { authconfig } : {}, (err, stream) => {
      if (err) return reject(err)
      if (!stream) return reject(new Error(`docker pull returned no stream for ${image}`))
      docker.modem.followProgress(stream, (e) => (e ? reject(e) : resolve()))
    })
  })
}

/** Creates a named volume unless the daemon already has it. */
async function ensureVolume(name: string): Promise<void> {
  const existing = await docker.listVolumes({ filters: { name: [name] } })
  if (existing.Volumes?.find((v) => v.Name === name)) return
  await docker.createVolume({ Name: name })
}

export async function spawnContainer(params: SpawnParams): Promise<{ containerId: string; isRestart: boolean }> {
  const name = containerName(params.workerId)

  // Restart path: container already exists (stopped worker).
  const existingId = await (async () => {
    try {
      const existing = docker.getContainer(name)
      const info = await existing.inspect()
      if (!info.State.Running) await existing.start()
      return info.Id
    } catch {
      return null // doesn't exist — create it
    }
  })()
  if (existingId) {
    // A container created before the shared network existed isn't on it yet.
    await connectToSharedNetwork(existingId, [`worker-${params.workerId}`])
    return { containerId: existingId, isRestart: true }
  }

  const workspaceVolume = `mp-worker-${params.workerId}-workspace`
  await ensureVolume(workspaceVolume)
  if (params.hasDinD) {
    for (const suffix of ["docker", "containerd"]) await ensureVolume(`mp-worker-${params.workerId}-${suffix}`)
  }
  // Project volumes are created on demand by the first worker that needs them,
  // and reused (never recreated) by every later one — that's the whole point.
  const sharedBinds = sharedVolumeBinds(params.projectId, params.sharedVolumes)
  for (const bind of sharedBinds) await ensureVolume(bind.split(":")[0])

  // Pull base image if missing.
  await ensureImage(params.image)

  const network = workerNetworkName(params.workerId)
  await ensureNetwork(network)

  const container = await docker.createContainer({
    name,
    Image: params.image,
    Cmd: ["bash", "-c", params.script],
    Env: params.env.length > 0 ? params.env : undefined,
    Labels: params.labels,
    HostConfig: {
      NetworkMode: network,
      Privileged: params.hasDinD,
      Init: true,
      Binds: [
        `${workspaceVolume}:/workspace`,
        ...(params.hasDinD
          ? [`mp-worker-${params.workerId}-docker:/var/lib/docker`, `mp-worker-${params.workerId}-containerd:/var/lib/containerd`]
          : []),
        // Last, but they can't shadow anything above: a mount path inside
        // /workspace (or on a DinD path) is rejected at validation time.
        ...sharedBinds,
      ],
    },
  })

  // Joined *before* start, so the shared services resolve from the very first line
  // of the setup script. `NetworkMode` above keeps the worker's own network as its
  // primary one, which is what the reverse proxy resolves against.
  await connectToSharedNetwork(container.id, [`worker-${params.workerId}`])

  await container.start()
  const info = await container.inspect()
  await connectSelfToNetwork(network)
  return { containerId: info.Id, isRestart: false }
}

// ─── Shared services ──────────────────────────────────────────────────────────

export function serviceContainerName(serviceId: string): string {
  return `mp-svc-${serviceId}`
}

/**
 * Real Docker volume backing a service's named volume. Keyed on the service **id**,
 * not its slug, so renaming the slug doesn't orphan the data.
 */
export function serviceVolumeName(serviceId: string, name: string): string {
  return `mp-svc-${serviceId}-${name}`
}

export type SpawnServiceParams = {
  serviceId: string
  slug: string
  image: string
  /** Overrides the image's CMD. Already tokenised; empty = keep the image's own. */
  command: string[]
  env: string[]
  ports: { container: number; host?: number | null }[]
  volumes: { name: string; mountPath: string }[]
  restartPolicy: string
}

/**
 * Creates (or restarts) a shared service's container. Idempotent: an existing
 * container for this service is simply started again — its named volumes and its
 * place on the shared network are untouched. Recreating it after a spec change is
 * the caller's job (`removeServiceContainer` then this).
 */
export async function spawnServiceContainer(params: SpawnServiceParams): Promise<string> {
  const name = serviceContainerName(params.serviceId)

  const existingId = await (async () => {
    try {
      const existing = docker.getContainer(name)
      const info = await existing.inspect()
      if (!info.State.Running) await existing.start()
      return info.Id
    } catch {
      return null
    }
  })()
  if (existingId) {
    await connectToSharedNetwork(existingId, [params.slug])
    return existingId
  }

  for (const vol of params.volumes) await ensureVolume(serviceVolumeName(params.serviceId, vol.name))

  await ensureImage(params.image)
  await ensureSharedNetwork()

  const container = await docker.createContainer({
    name,
    Image: params.image,
    Cmd: params.command.length > 0 ? params.command : undefined,
    Env: params.env.length > 0 ? params.env : undefined,
    Labels: {
      "spunto.service": "true",
      "spunto.serviceId": params.serviceId,
      "spunto.serviceSlug": params.slug,
    },
    ExposedPorts: Object.fromEntries(params.ports.map((p) => [`${p.container}/tcp`, {}])),
    HostConfig: {
      // The service's *primary* network, with its slug as DNS alias — so a worker
      // (also on this network) reaches it as `http://<slug>:<port>`.
      NetworkMode: SHARED_NETWORK_NAME,
      RestartPolicy: { Name: params.restartPolicy },
      // Only the ports that asked for a host binding are published: reachability
      // from the workers goes through the shared network, not through the host.
      PortBindings: Object.fromEntries(
        params.ports
          .filter((p) => p.host != null)
          .map((p) => [`${p.container}/tcp`, [{ HostPort: String(p.host) }]]),
      ),
      Binds: params.volumes.map((v) => `${serviceVolumeName(params.serviceId, v.name)}:${v.mountPath}`),
    },
    NetworkingConfig: {
      EndpointsConfig: { [SHARED_NETWORK_NAME]: { Aliases: [params.slug] } },
    },
  })

  await container.start()
  const info = await container.inspect()
  // So the reverse proxy can reach it at svc-<slug>.<BASE_DOMAIN> without publishing
  // a host port.
  await connectSelfToNetwork(SHARED_NETWORK_NAME)
  return info.Id
}

/**
 * Removes a service's container, KEEPING its named volumes and the shared network
 * (which outlives every individual service). Used by stop-and-recreate on edit.
 */
export async function removeServiceContainer(serviceId: string, containerId: string | null): Promise<void> {
  for (const ref of [containerId, serviceContainerName(serviceId)]) {
    if (!ref) continue
    try {
      const container = docker.getContainer(ref)
      try {
        await container.stop({ t: 10 })
      } catch {}
      await container.remove()
      return
    } catch (err: unknown) {
      if ((err as { statusCode?: number }).statusCode !== 404) throw err
    }
  }
}

/** Removes the container AND the service's named volumes. Used by delete. */
export async function removeService(
  serviceId: string,
  containerId: string | null,
  volumeNames: string[],
): Promise<void> {
  await removeServiceContainer(serviceId, containerId)
  for (const name of volumeNames) {
    try {
      await docker.getVolume(serviceVolumeName(serviceId, name)).remove()
    } catch {}
  }
}

export async function stopContainer(containerId: string): Promise<void> {
  try {
    await docker.getContainer(containerId).stop({ t: 10 })
  } catch (err: unknown) {
    const c = (err as { statusCode?: number }).statusCode
    if (c !== 404 && c !== 304) throw err
  }
}

export async function startContainer(containerId: string): Promise<void> {
  await docker.getContainer(containerId).start()
}

/**
 * Removes the container and its network, but KEEPS the named volumes
 * (`mp-worker-<id>-{workspace,docker,containerd}`). Used by rebuild: the
 * `/workspace` volume survives so the idempotent clone guard in the setup
 * script skips re-cloning and preserves the user's working tree.
 */
export async function removeContainerOnly(workerId: string, containerId: string | null): Promise<void> {
  if (containerId) {
    try {
      const container = docker.getContainer(containerId)
      try {
        await container.stop({ t: 5 })
      } catch {}
      await container.remove()
    } catch (err: unknown) {
      if ((err as { statusCode?: number }).statusCode !== 404) throw err
    }
  }
  const network = workerNetworkName(workerId)
  try {
    const networks = await docker.listNetworks({ filters: { name: [network] } })
    const net = networks.find((n) => n.Name === network)
    if (net) {
      try {
        await docker.getNetwork(net.Id).disconnect({ Container: hostname(), Force: true })
      } catch {}
      await docker.getNetwork(net.Id).remove()
    }
  } catch {}
}

/**
 * Removes the container + network AND all volumes the worker owns. Used by delete.
 * Strictly the three `mp-worker-<id>-*` ones: a project's shared volumes are
 * `mp-proj-<projectId>-*` and outlive every worker that mounted them — deleting
 * a worker must never take the team's dependency cache with it.
 */
export async function removeWorker(workerId: string, containerId: string | null): Promise<void> {
  await removeContainerOnly(workerId, containerId)
  for (const suffix of ["workspace", "docker", "containerd"]) {
    try {
      await docker.getVolume(`mp-worker-${workerId}-${suffix}`).remove()
    } catch {}
  }
}

/**
 * Removes every image built for a project (`mp-proj-<projectId>:v*`). Best effort:
 * an image still referenced by a surviving container is simply left behind.
 */
export async function removeProjectImages(projectId: string): Promise<void> {
  try {
    const images = await docker.listImages({ filters: { reference: [`mp-proj-${projectId}:*`] } })
    for (const img of images) {
      try {
        await docker.getImage(img.Id).remove({ force: true })
      } catch {}
    }
  } catch {}
}

/**
 * Removes every shared volume of a project (`mp-proj-<projectId>-<name>`), data
 * included. Only ever called from the project deletion path, behind an explicit
 * confirmation — nothing else in the app destroys them, not even deleting the
 * last worker that mounted them. Best effort: a volume still attached to a
 * container the daemon couldn't remove is left behind rather than blocking.
 *
 * The daemon's `name` filter is a substring match, so the prefix is re-checked
 * here — otherwise a project id that happens to be a substring of another's
 * would take its volumes down too.
 */
export async function removeProjectVolumes(projectId: string): Promise<void> {
  const prefix = `mp-proj-${projectId}-`
  try {
    const { Volumes } = await docker.listVolumes({ filters: { name: [prefix] } })
    for (const vol of Volumes ?? []) {
      if (!vol.Name.startsWith(prefix)) continue
      try {
        await docker.getVolume(vol.Name).remove({ force: true })
      } catch {}
    }
  } catch {}
}

/**
 * Live state of a service container. Richer than `getContainerState` because a
 * service that *died* has to be told apart from one that was stopped on purpose:
 * the exit code and the daemon's own error message are what the UI shows.
 */
export async function inspectServiceContainer(
  containerId: string,
): Promise<
  | { state: "running" }
  | { state: "stopped"; exitCode: number; error: string | null }
  | { state: "not_found" }
  | { state: "error" }
> {
  try {
    const info = await docker.getContainer(containerId).inspect()
    if (info.State.Running) return { state: "running" }
    return {
      state: "stopped",
      exitCode: info.State.ExitCode ?? 0,
      error: info.State.Error?.trim() || null,
    }
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) return { state: "not_found" }
    return { state: "error" }
  }
}

export async function getContainerState(containerId: string): Promise<"running" | "stopped" | "not_found" | "error"> {
  try {
    const info = await docker.getContainer(containerId).inspect()
    return info.State.Running ? "running" : "stopped"
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) return "not_found"
    return "error"
  }
}

// ─── Stream demux (Docker's 8-byte multiplexed frame header) ──────────────────

function demux(buf: Buffer): string {
  let out = ""
  let offset = 0
  while (offset + 8 <= buf.length) {
    const size = buf.readUInt32BE(offset + 4)
    offset += 8
    if (offset + size > buf.length) break
    out += buf.subarray(offset, offset + size).toString("utf8")
    offset += size
  }
  if (!out && buf.length > 0) out = buf.toString("utf8")
  return out
}

/** Runs a command in the container and returns its combined stdout/stderr. */
async function execCapture(containerId: string, cmd: string[], timeoutMs = 5000): Promise<string> {
  const container = docker.getContainer(containerId)
  const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true })
  const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) =>
    exec.start({ hijack: true, stdin: false }, (err, s) => (err || !s ? reject(err) : resolve(s))),
  )
  const buf = await new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = []
    stream.on("data", (c: Buffer) => chunks.push(c))
    stream.on("end", () => resolve(Buffer.concat(chunks)))
    stream.on("error", () => resolve(Buffer.concat(chunks)))
    setTimeout(() => resolve(Buffer.concat(chunks)), timeoutMs)
  })
  return demux(buf)
}

export async function getContainerLogs(containerId: string, tail = 400): Promise<string> {
  const container = docker.getContainer(containerId)
  return new Promise((resolve, reject) => {
    container.logs({ stdout: true, stderr: true, follow: false, tail }, (err, buffer) => {
      if (err) {
        if ((err as { statusCode?: number }).statusCode === 404) return resolve("")
        return reject(err)
      }
      resolve(buffer ? demux(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer as never)) : "")
    })
  })
}

export async function getContainerStats(containerId: string) {
  const container = docker.getContainer(containerId)
  // With { stream: false } dockerode returns the parsed stats object, not a stream.
  const raw = (await container.stats({ stream: false })) as unknown as {
    cpu_stats: { cpu_usage: { total_usage: number; percpu_usage?: number[] }; system_cpu_usage: number; online_cpus?: number }
    precpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage: number }
    memory_stats: { usage: number; limit: number; stats?: { inactive_file?: number; cache?: number } }
  } | null
  if (!raw) return null
  const r = raw
  // Coerce to finite numbers — some daemons (cgroup v2, Docker Desktop VM) omit
  // memory_stats fields, which would otherwise yield NaN → serialized as null.
  const n = (x: number) => (Number.isFinite(x) ? x : 0)
  const cpuDelta = r.cpu_stats.cpu_usage.total_usage - r.precpu_stats.cpu_usage.total_usage
  const systemDelta = r.cpu_stats.system_cpu_usage - r.precpu_stats.system_cpu_usage
  const numCPUs = r.cpu_stats.online_cpus ?? r.cpu_stats.cpu_usage.percpu_usage?.length ?? 1
  const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * numCPUs * 100 : 0
  const cache = r.memory_stats.stats?.inactive_file ?? r.memory_stats.stats?.cache ?? 0
  const memUsage = Math.max(0, (r.memory_stats.usage ?? 0) - cache)
  const memLimit = r.memory_stats.limit ?? 0
  return {
    cpuPercent: n(Math.round(cpuPercent * 100) / 100),
    memUsageMb: n(Math.round((memUsage / 1024 / 1024) * 100) / 100),
    memLimitMb: n(Math.round((memLimit / 1024 / 1024) * 100) / 100),
    memPercent: memLimit > 0 ? n(Math.round((memUsage / memLimit) * 10000) / 100) : 0,
  }
}

// ─── System-wide resource usage (for the Resources overview) ──────────────────

export type DfVolume = { name: string; sizeBytes: number; refCount: number }
export type DfImage = { id: string; repoTags: string[]; sizeBytes: number; created: number; containers: number }

/**
 * One-shot `docker system df` — the daemon's own accounting of volume and image
 * disk usage. Cheaper and more accurate than inspecting each object: sizes come
 * straight from the daemon. `UsageData.Size` is -1 when the daemon hasn't
 * computed it yet (we surface that as -1 so the UI can show "—").
 */
export async function getSystemDf(): Promise<{ volumes: DfVolume[]; images: DfImage[] }> {
  const df = (await docker.df()) as unknown as {
    Volumes?: { Name: string; UsageData?: { Size?: number; RefCount?: number } }[]
    Images?: { Id: string; RepoTags?: string[] | null; Size?: number; Created?: number; Containers?: number }[]
  }
  const volumes = (df.Volumes ?? []).map((v) => ({
    name: v.Name,
    sizeBytes: v.UsageData?.Size ?? -1,
    refCount: v.UsageData?.RefCount ?? -1,
  }))
  const images = (df.Images ?? []).map((i) => ({
    id: i.Id,
    repoTags: (i.RepoTags ?? []).filter((t) => t && t !== "<none>:<none>"),
    sizeBytes: i.Size ?? 0,
    created: i.Created ?? 0,
    containers: i.Containers ?? 0,
  }))
  return { volumes, images }
}

/**
 * Resolves a worker container's IP on its **own** network, for the reverse proxy.
 * The worker also sits on `mp-shared-net` (for the shared services), so the network
 * is named explicitly rather than "first one found": the control plane is only
 * guaranteed to have joined `mp-worker-<id>-net`.
 */
export async function resolveContainerIp(workerId: string): Promise<string | null> {
  const containers = await docker.listContainers({
    all: false,
    filters: JSON.stringify({ label: ["spunto.worker=true"] }),
  })
  const match = containers.find((c) => c.Labels["spunto.workerId"]?.toLowerCase() === workerId.toLowerCase())
  if (!match) return null
  const info = await docker.getContainer(match.Id).inspect()
  const networks = info.NetworkSettings.Networks ?? {}
  const own = networks[workerNetworkName(workerId)]?.IPAddress
  if (own) return own
  const ip = Object.values(networks)
    .map((n) => n?.IPAddress)
    .find((x) => x && x.length > 0)
  return ip || null
}

/** Resolves a shared service's IP on the shared network, for the reverse proxy. */
export async function resolveServiceIp(slug: string): Promise<string | null> {
  const containers = await docker.listContainers({
    all: false,
    filters: JSON.stringify({ label: ["spunto.service=true"] }),
  })
  const match = containers.find((c) => c.Labels["spunto.serviceSlug"] === slug)
  if (!match) return null
  const info = await docker.getContainer(match.Id).inspect()
  const networks = info.NetworkSettings.Networks ?? {}
  const shared = networks[SHARED_NETWORK_NAME]?.IPAddress
  if (shared) return shared
  const ip = Object.values(networks)
    .map((n) => n?.IPAddress)
    .find((x) => x && x.length > 0)
  return ip || null
}

export async function getGitStatus(
  containerId: string,
  repoPaths: string[],
): Promise<{ path: string; branch: string; modified: number; ahead: number; behind: number }[]> {
  if (repoPaths.length === 0) return []
  const pathList = repoPaths.map((p) => `'${p.replace(/'/g, "'\\''")}'`).join(" ")
  const script = [
    `git config --global --add safe.directory '*' 2>/dev/null || true`,
    `for p in ${pathList}; do`,
    `  if git -C "$p" rev-parse --git-dir >/dev/null 2>&1; then`,
    `    b=$(git -C "$p" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")`,
    `    [ "$b" = "HEAD" ] && b=$(git -C "$p" rev-parse --short HEAD 2>/dev/null || echo "HEAD")`,
    `    m=$(git -C "$p" status --porcelain 2>/dev/null | wc -l | tr -d " ")`,
    `    a=$(git -C "$p" rev-list @{u}..HEAD 2>/dev/null | wc -l | tr -d " " || echo 0)`,
    `    e=$(git -C "$p" rev-list HEAD..@{u} 2>/dev/null | wc -l | tr -d " " || echo 0)`,
    `    printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$p" "$b" "$m" "$a" "$e"`,
    `  else printf '%s\\t\\t0\\t0\\t0\\n' "$p"; fi`,
    `done`,
  ].join("\n")
  const out = await execCapture(containerId, ["bash", "-c", script])
  return out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [path, branch, m, a, e] = line.split("\t")
      return { path, branch: branch ?? "", modified: +m || 0, ahead: +a || 0, behind: +e || 0 }
    })
}

/** Reads /home/vscode/.mp-status.json from the container (setup progress). */
export async function getSetupStatus(containerId: string): Promise<unknown | null> {
  const out = await execCapture(containerId, ["cat", "/home/vscode/.mp-status.json"], 3000)
  return out.trim() ? JSON.parse(out.trim()) : null
}

/** Detects listening TCP ports inside the container (for the ports panel). */
export async function detectListeningPorts(containerId: string): Promise<number[]> {
  const script = `(ss -tlnH 2>/dev/null || netstat -tlnp 2>/dev/null) | grep -oE ':[0-9]+ ' | tr -d ': ' | sort -un`
  const out = await execCapture(containerId, ["bash", "-c", script], 4000)
  return [...new Set(out.trim().split("\n").map((n) => parseInt(n)).filter((n) => n > 0 && n < 65536))]
}

// ─── tmux session management (persistent multi-session terminals) ─────────────

export type TmuxSession = { name: string; windows: number; attached: boolean; command: string }

export async function listTmuxSessions(containerId: string): Promise<TmuxSession[]> {
  const fmt = "#{session_name}|#{session_windows}|#{session_attached}|#{pane_current_command}"
  const out = await execCapture(containerId, ["su", "vscode", "-c", `tmux list-sessions -F '${fmt}' 2>/dev/null || true`], 4000)
  return out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, windows, attached, command] = line.split("|")
      return { name, windows: parseInt(windows) || 1, attached: attached === "1", command: command || "" }
    })
}

export async function createTmuxSession(containerId: string, name: string): Promise<void> {
  const safe = name.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40) || "main"
  await execCapture(containerId, ["su", "vscode", "-c", `tmux new-session -d -s '${safe}' 2>&1 || true`], 4000)
}

export async function killTmuxSession(containerId: string, name: string): Promise<void> {
  const safe = name.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40)
  if (!safe) return
  await execCapture(containerId, ["su", "vscode", "-c", `tmux kill-session -t '${safe}' 2>&1 || true`], 4000)
}

// ─── Image build ──────────────────────────────────────────────────────────────

function buildTar(files: { name: string; content: Buffer }[]): Buffer {
  const blocks: Buffer[] = []
  for (const file of files) {
    const content = file.content
    const header = Buffer.alloc(512, 0)
    header.write(file.name.slice(0, 99), 0, "utf8")
    header.write("0100644\0", 100, "utf8")
    header.write("0000000\0", 108, "utf8")
    header.write("0000000\0", 116, "utf8")
    header.write(content.length.toString(8).padStart(11, "0") + "\0", 124, "utf8")
    header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0", 136, "utf8")
    header[156] = 0x30
    header.write("ustar\0", 257, "utf8")
    header.write("00", 263, "utf8")
    header.fill(0x20, 148, 156)
    let sum = 0
    for (let i = 0; i < 512; i++) sum += header[i]
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "utf8")
    blocks.push(header)
    const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512, 0)
    content.copy(padded)
    blocks.push(padded)
  }
  blocks.push(Buffer.alloc(1024, 0))
  return Buffer.concat(blocks)
}

export async function buildProjectImage(params: {
  baseImage: string
  buildScript: string
  imageRef: string
  onLog?: (chunk: string) => void
}): Promise<void> {
  const dockerfile = Buffer.from(
    [`FROM ${params.baseImage}`, "COPY script.sh /tmp/mp-build-script.sh", "RUN bash /tmp/mp-build-script.sh && rm -f /tmp/mp-build-script.sh"].join("\n"),
    "utf8",
  )
  const context = buildTar([
    { name: "Dockerfile", content: dockerfile },
    { name: "script.sh", content: Buffer.from(params.buildScript, "utf8") },
  ])
  const { Readable } = await import("node:stream")
  const contextStream = Readable.from(context)

  // Auth for the FROM base image if it lives in a private GCP registry.
  const registryconfig = await getRegistryConfigForImage(params.baseImage)

  let buildError: string | null = null
  await new Promise<void>((resolve, reject) => {
    docker.buildImage(
      contextStream as never,
      { t: params.imageRef, pull: "true", ...(registryconfig ? { registryconfig } : {}) } as never,
      (err, stream) => {
        if (err) return reject(err)
        if (!stream) return reject(new Error("No build stream returned"))
        docker.modem.followProgress(
          stream,
          (finalErr) => (finalErr || buildError ? reject(new Error(buildError ?? finalErr?.message ?? "Build failed")) : resolve()),
          (event: { stream?: string; status?: string; error?: string }) => {
            if (event.stream) params.onLog?.(event.stream)
            if (event.status) params.onLog?.(event.status + "\n")
            if (event.error) buildError = event.error
          },
        )
      },
    )
  })
}
