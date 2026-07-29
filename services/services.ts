import { eq, desc } from "drizzle-orm"
import { db } from "../db/index"
import { services, type Service } from "../db/schema"
import { newId } from "../lib/id"
import {
  spawnServiceContainer,
  removeServiceContainer,
  removeService as removeServiceDocker,
  stopContainer,
  inspectServiceContainer,
} from "../lib/docker"
import { getUserSecretValue } from "./secrets"
import type { CreateServiceInput, UpdateServiceInput } from "../lib/validation"

// Shared services — the local counterpart of Spunto's "Ship" pillar. One
// Elasticsearch, one Postgres, one MinIO for *all* the workers of *all* the
// projects, instead of each project booting its own. Deliberately global (no
// projectId) and with a lifecycle of its own: a service outlives the worker, and
// the project, that happened to need it.
//
// Reachability is the point: every service container sits on `mp-shared-net` under
// a DNS alias equal to its slug, and every worker joins that network at spawn (see
// lib/docker.ts) — so `curl http://elasticsearch:9200` works from any worker with
// no port published on the host.

// ─── Reads ────────────────────────────────────────────────────────────────────

export function listServiceRows(): Service[] {
  return db.select().from(services).orderBy(desc(services.createdAt)).all()
}

export function getServiceRow(id: string): Service | undefined {
  return db.select().from(services).where(eq(services.id, id)).get()
}

export function getServiceBySlug(slug: string): Service | undefined {
  return db.select().from(services).where(eq(services.slug, slug)).get()
}

/**
 * The port a service is "at" when nothing else is said: its HTTP port if it has
 * one, else the first port it declares. Null for a service that publishes nothing
 * (rare, but legal — a sidecar reachable only by other means).
 */
export function servicePrimaryPort(s: Service): number | null {
  return s.httpPort ?? s.ports[0]?.container ?? null
}

/**
 * In-cluster address of a service, as injected into workers. A full `http://` URL
 * when the service declares an HTTP port (`http://elasticsearch:9200`); a bare
 * `host:port` otherwise, because pretending Postgres speaks HTTP would be a lie.
 */
export function serviceAddress(s: Service): string {
  if (s.httpPort) return `http://${s.slug}:${s.httpPort}`
  const port = servicePrimaryPort(s)
  return port ? `${s.slug}:${port}` : s.slug
}

/** `elastic-search` → `ELASTIC_SEARCH`, the env-var-safe form of a slug. */
function envSuffix(slug: string): string {
  return slug.toUpperCase().replace(/-/g, "_")
}

/**
 * Environment variables describing the shared services, injected into every worker
 * at spawn so a project never hard-codes an URL:
 *
 *   SPUNTO_SERVICES=elasticsearch,postgres
 *   SPUNTO_SVC_ELASTICSEARCH=http://elasticsearch:9200
 *   SPUNTO_SVC_ELASTICSEARCH_HOST=elasticsearch
 *   SPUNTO_SVC_ELASTICSEARCH_PORT=9200
 *
 * Read straight from SQLite (no Docker round-trip, so the spawn path stays sync)
 * and limited to services meant to be up: a stopped or failed one has nothing
 * listening, so advertising it would only produce confusing connection errors.
 * A worker picks up services added later on its next rebuild.
 */
export function serviceEnvForWorkers(): string[] {
  const active = listServiceRows().filter((s) => s.state !== "stopped" && s.state !== "error")
  if (active.length === 0) return []
  const env = [`SPUNTO_SERVICES=${active.map((s) => s.slug).join(",")}`]
  for (const s of active) {
    const key = envSuffix(s.slug)
    env.push(`SPUNTO_SVC_${key}=${serviceAddress(s)}`)
    env.push(`SPUNTO_SVC_${key}_HOST=${s.slug}`)
    const port = servicePrimaryPort(s)
    if (port) env.push(`SPUNTO_SVC_${key}_PORT=${port}`)
  }
  return env
}

/**
 * Splits a command line into argv the way a shell would *quote* it — nothing more.
 * `server /data --console-address ":9001"` → 4 tokens. No pipes, no globbing, no
 * variable expansion: the string overrides the image's CMD, it isn't run by a shell.
 */
export function tokenizeCommand(command: string | null): string[] {
  if (!command?.trim()) return []
  const out: string[] = []
  let current = ""
  let quote: '"' | "'" | null = null
  let started = false
  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (/\s/.test(ch)) {
      if (current || started) out.push(current)
      current = ""
      started = false
      continue
    }
    current += ch
  }
  if (current || started) out.push(current)
  return out
}

// ─── Container env ────────────────────────────────────────────────────────────

/**
 * Resolves a service's env into Docker's `KEY=value` form. A `secretName` entry is
 * looked up in the global secrets and decrypted here — the plaintext exists only
 * for the length of this call and the `createContainer` that follows. A reference
 * to a secret that no longer exists is dropped with a warning rather than
 * injecting the empty string, which would silently mean "no password".
 */
function resolveServiceEnv(s: Service): string[] {
  const out: string[] = []
  for (const entry of s.env) {
    if (entry.secretName) {
      const value = getUserSecretValue(entry.secretName)
      if (value === null) {
        console.warn(`[service ${s.slug}] env ${entry.name}: unknown global secret "${entry.secretName}" — skipped`)
        continue
      }
      out.push(`${entry.name}=${value}`)
    } else {
      out.push(`${entry.name}=${entry.value ?? ""}`)
    }
  }
  return out
}

// ─── Start pipeline ───────────────────────────────────────────────────────────

function setState(id: string, state: string, error: string | null = null) {
  db.update(services).set({ state, error }).where(eq(services.id, id)).run()
}

/** Fire-and-forget: pull the image if needed, create/start the container. */
async function runStartPipeline(id: string) {
  const s = getServiceRow(id)
  if (!s) return
  try {
    setState(id, "starting")
    const containerId = await spawnServiceContainer({
      serviceId: s.id,
      slug: s.slug,
      image: s.image,
      command: tokenizeCommand(s.command),
      env: resolveServiceEnv(s),
      ports: s.ports,
      volumes: s.volumes,
      restartPolicy: s.restartPolicy,
    })
    db.update(services).set({ containerId, state: "ready", error: null }).where(eq(services.id, id)).run()
  } catch (err) {
    console.error(`[service ${id}] start failed:`, err)
    setState(id, "error", (err as Error).message)
  }
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export function createService(input: CreateServiceInput): Service {
  if (getServiceBySlug(input.slug)) throw new Error(`A service with the slug "${input.slug}" already exists`)
  const row: Service = {
    id: newId(),
    slug: input.slug,
    description: input.description?.trim() || null,
    image: input.image,
    command: input.command?.trim() || null,
    env: input.env,
    ports: input.ports,
    volumes: input.volumes,
    httpPort: input.httpPort ?? null,
    restartPolicy: input.restartPolicy,
    containerId: null,
    state: input.start ? "pending" : "stopped",
    error: null,
    createdAt: new Date(),
  }
  db.insert(services).values(row).run()
  if (input.start) void runStartPipeline(row.id)
  return row
}

/**
 * Applies a spec change. Everything here — image, env, ports, volumes, restart
 * policy, DNS alias — is baked into the container at creation time, so a running
 * service is **recreated** to pick it up (its named volumes, and therefore its
 * data, are kept). A stopped service is left stopped: the new spec applies on its
 * next start.
 */
export async function updateService(id: string, input: UpdateServiceInput): Promise<Service | undefined> {
  const current = getServiceRow(id)
  if (!current) return undefined
  if (input.slug && input.slug !== current.slug) {
    const clash = getServiceBySlug(input.slug)
    if (clash && clash.id !== id) throw new Error(`A service with the slug "${input.slug}" already exists`)
  }

  const patch: Partial<Service> = {}
  if (input.slug !== undefined) patch.slug = input.slug
  if (input.description !== undefined) patch.description = input.description?.trim() || null
  if (input.image !== undefined) patch.image = input.image
  if (input.command !== undefined) patch.command = input.command?.trim() || null
  if (input.env !== undefined) patch.env = input.env
  if (input.ports !== undefined) patch.ports = input.ports
  if (input.volumes !== undefined) patch.volumes = input.volumes
  if (input.httpPort !== undefined) patch.httpPort = input.httpPort
  if (input.restartPolicy !== undefined) patch.restartPolicy = input.restartPolicy
  if (Object.keys(patch).length > 0) db.update(services).set(patch).where(eq(services.id, id)).run()

  const wasUp = current.state === "ready" || current.state === "starting"
  await removeServiceContainer(id, current.containerId).catch(() => {})
  db.update(services)
    .set({ containerId: null, state: wasUp ? "pending" : "stopped", error: null })
    .where(eq(services.id, id))
    .run()
  if (wasUp) void runStartPipeline(id)
  return getServiceRow(id)
}

/** Removes the container **and** the service's volumes — the data is gone for good. */
export async function deleteService(id: string): Promise<void> {
  const s = getServiceRow(id)
  if (s) await removeServiceDocker(s.id, s.containerId, s.volumes.map((v) => v.name)).catch(() => {})
  db.delete(services).where(eq(services.id, id)).run()
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

export function startService(id: string): Service | undefined {
  const s = getServiceRow(id)
  if (!s) return undefined
  setState(id, "pending")
  void runStartPipeline(id)
  return getServiceRow(id)
}

export async function stopService(id: string): Promise<Service | undefined> {
  const s = getServiceRow(id)
  if (!s) return undefined
  // Written *before* the container goes down so `refreshService` reads a
  // user-requested stop as "stopped" and not as a crash (see below).
  setState(id, "stopped")
  if (s.containerId) await stopContainer(s.containerId).catch(() => {})
  return getServiceRow(id)
}

export async function restartService(id: string): Promise<Service | undefined> {
  const s = getServiceRow(id)
  if (!s) return undefined
  await stopService(id)
  return startService(id)
}

// ─── Live state ───────────────────────────────────────────────────────────────

/**
 * Reconciles a service's stored state with its container. A stopped container is
 * only reported as an error when the service was *supposed* to be up — a
 * user-requested stop writes "stopped" first, so a non-zero exit code there is the
 * SIGTERM the image chose to report, not a failure.
 */
export async function refreshService(s: Service): Promise<Service> {
  // No container yet: either never started, or a start pipeline is in flight —
  // nothing to reconcile against, and clobbering "pending" would fight it.
  if (!s.containerId) return s

  const live = await inspectServiceContainer(s.containerId)
  if (live.state === "error") return s

  if (live.state === "not_found") {
    if (s.state === "error") return s
    db.update(services).set({ state: "stopped", containerId: null }).where(eq(services.id, s.id)).run()
    return { ...s, state: "stopped", containerId: null }
  }

  if (live.state === "running") {
    if (s.state === "ready") return s
    db.update(services).set({ state: "ready", error: null }).where(eq(services.id, s.id)).run()
    return { ...s, state: "ready", error: null }
  }

  // stopped
  if (s.state === "stopped" || s.state === "error") return s
  const crashed = live.exitCode !== 0
  const error = crashed ? (live.error ?? `Container exited with code ${live.exitCode} — see the logs`) : null
  const state = crashed ? "error" : "stopped"
  db.update(services).set({ state, error }).where(eq(services.id, s.id)).run()
  return { ...s, state, error }
}

export async function listServicesLive(): Promise<Service[]> {
  const rows = listServiceRows()
  return Promise.all(rows.map((s) => refreshService(s).catch(() => s)))
}

export async function getServiceLive(id: string): Promise<Service | undefined> {
  const s = getServiceRow(id)
  if (!s) return undefined
  return refreshService(s).catch(() => s)
}
