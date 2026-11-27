import { eq } from "drizzle-orm"
import { db } from "../../db/index"
import { integrationConnections, type IntegrationConnection } from "../../db/schema"
import { decrypt, encrypt } from "../../lib/crypto"
import { newId } from "../../lib/id"
import { definitionOf, definitions, normalizeOrigin, type IntegrationKind, type PullRequestRef, type PullRequestState } from "../../lib/integrations"
import { githubDriver } from "./github"
import { gitlabDriver } from "./gitlab"
import { IntegrationError, type IntegrationDriver } from "./types"

export { IntegrationError }

/**
 * Integrations (docs/integrations.md): forge accounts connected by token, asked what a task's pull
 * requests stand at. The drivers are here; what a forge's URLs look like is in lib/integrations.
 *
 * A token comes from one of two places, tried in this order for an origin:
 *  1. a connection of Settings → Integrations (`integration_connections`), encrypted;
 *  2. for the public instance only (github.com, gitlab.com), the variable its definition names
 *     (`GH_TOKEN`, `GITLAB_TOKEN`) in the control plane's own environment.
 * Neither ever reaches a worker.
 */

const drivers: Partial<Record<IntegrationKind, IntegrationDriver>> = {
  github: githubDriver,
  gitlab: gitlabDriver,
}

export const driverOf = (kind: IntegrationKind): IntegrationDriver | undefined => drivers[kind]

/** A connection as the dashboard sees it — never its token. */
export type IntegrationConnectionView = {
  id: string
  kind: IntegrationKind
  origin: string
  account: string | null
  /** `settings`: saved here, removable. `env`: the variable named by `envVar`, removable only there. */
  source: "settings" | "env"
  envVar?: string
  createdAt: string | null
}

/** The integrations Lite can connect: a definition with a driver. */
export type IntegrationOffer = {
  kind: IntegrationKind
  label: string
  defaultHost: string
  shortLabel: string
  tokenScopes: string | null
  tokenEnvVar: string | null
  /** For the public instance; a self-hosted one swaps the origin in (`newTokenUrl`, lib/integrations). */
  newTokenUrl: string | null
}

export function integrationOffers(): IntegrationOffer[] {
  return definitions
    .filter((d) => drivers[d.kind])
    .map((d) => ({
      kind: d.kind,
      label: d.label,
      defaultHost: d.defaultHost,
      shortLabel: d.shortLabel,
      tokenScopes: d.tokenScopes ?? null,
      tokenEnvVar: d.tokenEnvVar ?? null,
      newTokenUrl: d.newTokenUrl?.(`https://${d.defaultHost}`) ?? null,
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

function storedConnections(): IntegrationConnection[] {
  return db.select().from(integrationConnections).orderBy(integrationConnections.origin).all()
}

/** The public instances whose token is in the environment, and not overridden by a saved one. */
function envConnections(stored: IntegrationConnection[]): IntegrationConnectionView[] {
  return integrationOffers().flatMap((o) => {
    const origin = `https://${o.defaultHost}`
    if (!o.tokenEnvVar || !process.env[o.tokenEnvVar]?.trim()) return []
    if (stored.some((c) => c.origin === origin)) return []
    return [{ id: `env:${o.kind}`, kind: o.kind, origin, account: null, source: "env" as const, envVar: o.tokenEnvVar, createdAt: null }]
  })
}

export function listConnections(): IntegrationConnectionView[] {
  const stored = storedConnections()
  return [
    ...stored.map((c) => ({
      id: c.id,
      kind: c.kind,
      origin: c.origin,
      account: c.account,
      source: "settings" as const,
      createdAt: c.createdAt.toISOString(),
    })),
    ...envConnections(stored),
  ]
}

/** The token for a forge at `origin`, if one is known for that kind of forge. */
function tokenFor(kind: IntegrationKind, origin: string): string | null {
  const row = db.select().from(integrationConnections).where(eq(integrationConnections.origin, origin)).get()
  if (row) return row.kind === kind ? decrypt(row.encryptedToken) : null
  const def = definitionOf(kind)
  if (origin !== `https://${def.defaultHost}` || !def.tokenEnvVar) return null
  return process.env[def.tokenEnvVar]?.trim() || null
}

/**
 * Saves a token for a forge, after asking the forge whose it is: a token it refuses is not
 * saved. A second token for the same origin replaces the first.
 */
export async function connect(input: { kind: IntegrationKind; host?: string; token: string }): Promise<IntegrationConnectionView> {
  const driver = drivers[input.kind]
  if (!driver) throw new IntegrationError(`No ${input.kind} integration to connect`)
  const def = definitionOf(input.kind)
  const origin = normalizeOrigin(input.host?.trim() || def.defaultHost)
  if (!origin) throw new IntegrationError(`Not a host: ${input.host} — give it as gitlab.example.com or https://gitlab.example.com`)
  const token = input.token.trim()
  if (!token) throw new IntegrationError("The token is empty")
  const account = await driver.whoami(origin, token)

  const existing = db.select().from(integrationConnections).where(eq(integrationConnections.origin, origin)).get()
  const row = { kind: input.kind, origin, encryptedToken: encrypt(token), account }
  if (existing) db.update(integrationConnections).set(row).where(eq(integrationConnections.id, existing.id)).run()
  else db.insert(integrationConnections).values({ id: newId(), ...row, createdAt: new Date() }).run()
  forgetPullRequests(origin)
  repositoriesCache = null
  return listConnections().find((c) => c.origin === origin && c.source === "settings")!
}

export function disconnect(id: string): boolean {
  const row = db.select().from(integrationConnections).where(eq(integrationConnections.id, id)).get()
  if (!row) return false
  db.delete(integrationConnections).where(eq(integrationConnections.id, id)).run()
  forgetPullRequests(row.origin)
  repositoriesCache = null
  return true
}

// ── Pull requests ─────────────────────────────────────────────────────────────────────────────

/**
 * What each pull request was last read at. A task's details re-read their tiles every 10 s while
 * it runs, and a conversation can carry a dozen PRs: without this, that is a forge call per PR
 * every 10 s — enough to meet GitHub's rate limit on a busy afternoon. A failure is kept as long,
 * so a PR the token cannot see is not asked again on every poll.
 */
const TTL_MS = 30_000
const cache = new Map<string, { at: number; value: Promise<PullRequestState | null> }>()

function forgetPullRequests(origin: string) {
  for (const key of cache.keys()) if (key.startsWith(`${origin}/`)) cache.delete(key)
}

/**
 * Where a pull request stands, or null when nothing can say: no driver for its forge, no token for
 * its host, or the forge refused. Never throws — a tile without a state is still its link.
 */
export function pullRequestState(ref: PullRequestRef): Promise<PullRequestState | null> {
  const key = `${ref.origin}/${ref.repo}/${ref.number}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value
  const read = drivers[ref.kind]?.pullRequest
  const token = read ? tokenFor(ref.kind, ref.origin) : null
  const value = read && token ? read(ref, token).catch(() => null) : Promise.resolve(null)
  cache.set(key, { at: Date.now(), value })
  // Bounded by what the conversations name; dropping the stale entries keeps it so.
  if (cache.size > 500) for (const [k, v] of cache) if (Date.now() - v.at >= TTL_MS) cache.delete(k)
  return value
}

// ── Repositories ──────────────────────────────────────────────────────────────────────────────

/** A connection that can list its repositories, as the project form offers it. */
export type RepositorySource = {
  /** The connection's id — what a picked row's `provider` holds until it becomes a clone URL. */
  id: string
  kind: IntegrationKind
  origin: string
  account: string | null
  /** Why it listed nothing, when the forge refused: the form says it rather than an empty list. */
  error?: string
}

export type RepositoryChoice = {
  /** `RepositorySource.id`. */
  source: string
  fullName: string
  /** What the project will store: the HTTPS URL, cloned and pushed with the connection's token. */
  cloneUrl: string
  private: boolean
}

/**
 * Listing is a few pages per forge: kept a couple of minutes, so opening the form twice does not
 * list twice, and dropped when a connection changes.
 */
const REPOSITORIES_TTL_MS = 2 * 60_000
let repositoriesCache: { at: number; value: Promise<{ sources: RepositorySource[]; repositories: RepositoryChoice[] }> } | null = null

/** The repositories every connection reaches, for the project form's picker. Never throws. */
export function listRepositories(): Promise<{ sources: RepositorySource[]; repositories: RepositoryChoice[] }> {
  if (repositoriesCache && Date.now() - repositoriesCache.at < REPOSITORIES_TTL_MS) return repositoriesCache.value
  const value = (async () => {
    const listed = await Promise.all(
      listConnections().map(async (c) => {
        const list = drivers[c.kind]?.listRepositories
        const token = list ? tokenFor(c.kind, c.origin) : null
        if (!list || !token) return null
        const source: RepositorySource = { id: c.id, kind: c.kind, origin: c.origin, account: c.account }
        try {
          const repos = await list(c.origin, token)
          return { source, repos: repos.map((r) => ({ source: c.id, fullName: r.fullName, cloneUrl: r.httpsUrl, private: r.private })) }
        } catch (err) {
          return { source: { ...source, error: (err as Error).message }, repos: [] }
        }
      }),
    )
    const ok = listed.filter((l) => l !== null)
    return { sources: ok.map((l) => l.source), repositories: ok.flatMap((l) => l.repos) }
  })()
  repositoriesCache = { at: Date.now(), value }
  // A refusal is worth asking again on the next open, not two minutes later.
  void value.then((v) => {
    if (v.sources.some((s) => s.error) && repositoriesCache?.value === value) repositoriesCache = null
  })
  return value
}

// ── Git over HTTPS ────────────────────────────────────────────────────────────────────────────

/**
 * The credential git sends to `origin`, for a worker's helper (lib/git-credential.ts): the
 * connection's token under the user name its forge expects. Null when no connection is for that
 * exact origin, or its forge does not clone with a token — the helper then stays silent.
 */
export function gitCredentialFor(origin: string): { username: string; password: string } | null {
  const row = db.select().from(integrationConnections).where(eq(integrationConnections.origin, origin)).get()
  const kind = row?.kind ?? envConnections([]).find((c) => c.origin === origin)?.kind
  if (!kind) return null
  const username = definitionOf(kind).gitUsername
  const password = tokenFor(kind, origin)
  return username && password ? { username, password } : null
}
