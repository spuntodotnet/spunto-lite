import { readFileSync } from "node:fs"
import { arch, cpus, platform, totalmem } from "node:os"
import { sql } from "drizzle-orm"
import { db } from "../db/index"
import { projects, services, tasks, workers } from "../db/schema"
import { docker } from "../lib/docker"
import { startTelemetry, TELEMETRY_ENABLED, track } from "../lib/telemetry"

/**
 * What the opt-in telemetry (lib/telemetry.ts) says about this install on its own, beside the
 * requests server.ts reports: one `lite.started` per boot — version and the machine Docker runs
 * on — and a `lite.heartbeat` every HEARTBEAT_INTERVAL_MS with how much is on it.
 */

const HEARTBEAT_INTERVAL_MS = 5 * 60_000

/** The image's revision when built by CI (Dockerfile's SPUNTO_LITE_VERSION), else package.json's. */
function liteVersion(): string {
  if (process.env.SPUNTO_LITE_VERSION) return process.env.SPUNTO_LITE_VERSION
  try {
    return (JSON.parse(readFileSync("package.json", "utf8")) as { version?: string }).version ?? "unknown"
  } catch {
    return "unknown"
  }
}

/** Rows per state, as `<prefix>_<state>` attributes, plus the total. */
function countByState(table: typeof workers | typeof services | typeof tasks, prefix: string) {
  const rows = db
    .select({ state: table.state, n: sql<number>`count(*)` })
    .from(table)
    .groupBy(table.state)
    .all()
  const out: Record<string, number> = { [prefix]: 0 }
  for (const r of rows) {
    out[`${prefix}_${r.state.replace(/[^a-z0-9]/gi, "_")}`] = Number(r.n)
    out[prefix] += Number(r.n)
  }
  return out
}

function heartbeat() {
  try {
    track("lite.heartbeat", {
      uptime_s: Math.round(process.uptime()),
      projects: db.select({ n: sql<number>`count(*)` }).from(projects).get()?.n ?? 0,
      ...countByState(workers, "workers"),
      ...countByState(services, "services"),
      ...countByState(tasks, "tasks"),
    })
  } catch (err) {
    console.warn(`[telemetry] heartbeat failed: ${err}`)
  }
}

export function startUsageTelemetry(): void {
  if (!TELEMETRY_ENABLED) return
  const version = liteVersion()
  startTelemetry({ "service.version": version })
  void docker
    .info()
    .catch(() => null)
    .then((info: Record<string, unknown> | null) => {
      track("lite.started", {
        version,
        node: process.version,
        platform: platform(),
        arch: arch(),
        cpus: cpus().length,
        mem_mb: Math.round(totalmem() / 1024 / 1024),
        // The daemon's machine — Docker Desktop's VM on a Mac, not the container Lite runs in.
        docker_version: (info?.ServerVersion as string) ?? null,
        docker_os: (info?.OperatingSystem as string) ?? null,
        docker_cpus: (info?.NCPU as number) ?? null,
        docker_mem_mb: typeof info?.MemTotal === "number" ? Math.round(info.MemTotal / 1024 / 1024) : null,
        docker_driver: (info?.Driver as string) ?? null,
      })
      heartbeat()
    })
  setInterval(heartbeat, HEARTBEAT_INTERVAL_MS).unref?.()
}
