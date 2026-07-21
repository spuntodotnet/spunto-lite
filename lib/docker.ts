import Docker from "dockerode"
import { existsSync } from "node:fs"
import { hostname } from "node:os"

// Docker operations, ported/simplified from apps/agent/src/docker.ts. The control
// plane talks straight to the local daemon — no remote agent, no registry auth
// (public images only), no OTLP telemetry network.

export const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET || "/var/run/docker.sock" })

export function workerNetworkName(workerId: string): string {
  return `mp-worker-${workerId}-net`
}
function containerName(workerId: string): string {
  return `mp-worker-${workerId}`
}

async function ensureWorkerNetwork(networkName: string): Promise<void> {
  const networks = await docker.listNetworks({ filters: { name: [networkName] } })
  if (networks.find((n) => n.Name === networkName)) return
  try {
    await docker.createNetwork({ Name: networkName, Driver: "bridge" })
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode !== 409) throw err
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
  image: string
  script: string
  env: string[]
  hasDinD: boolean
  labels: Record<string, string>
}

export async function spawnContainer(params: SpawnParams): Promise<{ containerId: string; isRestart: boolean }> {
  const name = containerName(params.workerId)

  // Restart path: container already exists (stopped worker).
  try {
    const existing = docker.getContainer(name)
    const info = await existing.inspect()
    if (!info.State.Running) await existing.start()
    return { containerId: info.Id, isRestart: true }
  } catch {
    // doesn't exist — create it
  }

  const workspaceVolume = `mp-worker-${params.workerId}-workspace`
  const existingVolumes = await docker.listVolumes({ filters: { name: [workspaceVolume] } })
  if (!existingVolumes.Volumes?.find((v) => v.Name === workspaceVolume)) {
    await docker.createVolume({ Name: workspaceVolume })
  }
  if (params.hasDinD) {
    for (const suffix of ["docker", "containerd"]) {
      const vol = `mp-worker-${params.workerId}-${suffix}`
      const ex = await docker.listVolumes({ filters: { name: [vol] } })
      if (!ex.Volumes?.find((v) => v.Name === vol)) await docker.createVolume({ Name: vol })
    }
  }

  // Pull base image if missing.
  const imageExists = await docker.getImage(params.image).inspect().then(() => true).catch(() => false)
  if (!imageExists) {
    await new Promise<void>((resolve, reject) => {
      docker.pull(params.image, {}, (err, stream) => {
        if (err) return reject(err)
        if (!stream) return reject(new Error(`docker pull returned no stream for ${params.image}`))
        docker.modem.followProgress(stream, (e) => (e ? reject(e) : resolve()))
      })
    })
  }

  const network = workerNetworkName(params.workerId)
  await ensureWorkerNetwork(network)

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
      ],
    },
  })

  await container.start()
  const info = await container.inspect()
  await connectSelfToNetwork(network)
  return { containerId: info.Id, isRestart: false }
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

export async function removeWorker(workerId: string, containerId: string | null): Promise<void> {
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
  for (const suffix of ["workspace", "docker", "containerd"]) {
    try {
      await docker.getVolume(`mp-worker-${workerId}-${suffix}`).remove()
    } catch {}
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

/** Resolves a worker container's IP on its network, for the reverse proxy. */
export async function resolveContainerIp(workerId: string): Promise<string | null> {
  const containers = await docker.listContainers({
    all: false,
    filters: JSON.stringify({ label: ["spunto.worker=true"] }),
  })
  const match = containers.find((c) => c.Labels["spunto.workerId"]?.toLowerCase() === workerId.toLowerCase())
  if (!match) return null
  const info = await docker.getContainer(match.Id).inspect()
  const ip = Object.values(info.NetworkSettings.Networks ?? {})
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

  let buildError: string | null = null
  await new Promise<void>((resolve, reject) => {
    docker.buildImage(contextStream as never, { t: params.imageRef, pull: "true" } as never, (err, stream) => {
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
    })
  })
}
