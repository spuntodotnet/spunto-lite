import { createHash, randomBytes } from "node:crypto"
import { and, eq, lt } from "drizzle-orm"
import type { AgentMcpServer } from "@spunto/build/agent-runners"
import { db } from "../db/index"
import { mcpConnections, mcpGatewayTokens, mcpOauthStates, mcpServers, projectMcpSettings, type McpConnection, type McpServer } from "../db/schema"
import { decrypt, encrypt } from "../lib/crypto"
import { newId } from "../lib/id"
import * as oauth from "../lib/mcp-oauth"

/**
 * MCP servers (docs/serveurs-mcp.md) — Cloud's organization MCP servers (RFC 0049) for Lite's one
 * user: declared once, connected in OAuth from Settings, given to task sessions per project, and
 * reached through Lite's gateway (`app/api/mcp-gateway/[serverId]`). The worker never holds the
 * vendor's credential: it shows a per-task gateway token (`lmg_…`) and Lite relays with its own.
 */

export class McpServerError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 502 = 400,
  ) {
    super(message)
  }
}

/** A connection that can't give a token any more: the human has to Connect again. */
export class NotConnected extends Error {}

export type McpMode = "default" | "optional"

/** What the agent calls the server: `mcp__<name>__<tool>` in Claude, so a plain identifier. */
export const MCP_SERVER_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/

/** An authorization left unfinished this long is forgotten. */
const STATE_TTL_MS = 15 * 60_000

/** Refresh an access token this long before it expires, so a call never leaves with a dying one. */
const REFRESH_MARGIN_MS = 60_000

const GATEWAY_TOKEN_PREFIX = "lmg_"

export const gatewayPath = (serverId: string) => `/api/mcp-gateway/${serverId}`

/**
 * What discovery found, plus the redirect URI a dynamically registered client was registered
 * for: Lite may be opened from another origin later (localhost, then a local domain), and a
 * client registered for one redirect URI is refused on another — it is registered again then.
 */
type StoredOAuth = oauth.McpOAuthMetadata & { registeredRedirectUri?: string }

export function metadataOf(server: McpServer): StoredOAuth | null {
  return server.auth === "oauth" && server.oauth ? (server.oauth as unknown as StoredOAuth) : null
}

// ─── Servers ─────────────────────────────────────────────────────────────────

export function listServers(): McpServer[] {
  return db.select().from(mcpServers).orderBy(mcpServers.name).all()
}

export function getServer(id: string): McpServer | undefined {
  return db.select().from(mcpServers).where(eq(mcpServers.id, id)).get()
}

export function getConnection(serverId: string): McpConnection | undefined {
  return db.select().from(mcpConnections).where(eq(mcpConnections.serverId, serverId)).get()
}

/** What the UI is shown of a server: never a token, a secret or a header value. */
export type SerializedMcpServer = {
  id: string
  name: string
  url: string
  auth: "none" | "oauth" | "header"
  mode: McpMode
  headerName: string | null
  issuer: string | null
  scope: string | null
  /** Whether a client id was given at declaration rather than registered on Connect. */
  manualClient: boolean
  connection: { status: "ok" | "needs_reauth"; connectedAt: number; expiresAt: number | null; scope: string | null } | null
  createdAt: number
}

export function serializeServer(s: McpServer): SerializedMcpServer {
  const meta = metadataOf(s)
  const conn = s.auth === "oauth" ? getConnection(s.id) : undefined
  return {
    id: s.id,
    name: s.name,
    url: s.url,
    auth: s.auth,
    mode: s.mode,
    headerName: s.encryptedHeaderName ? decrypt(s.encryptedHeaderName) : null,
    issuer: meta?.issuer ?? null,
    scope: meta?.scope ?? null,
    manualClient: !!s.clientId && !meta?.registeredRedirectUri,
    connection: conn
      ? { status: conn.status, connectedAt: conn.connectedAt.getTime(), expiresAt: conn.expiresAt?.getTime() ?? null, scope: conn.scope }
      : null,
    createdAt: s.createdAt.getTime(),
  }
}

export type CreateServerInput = {
  name: string
  url: string
  mode?: McpMode
  headerName?: string
  headerValue?: string
  clientId?: string
  clientSecret?: string
}

function checkUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new McpServerError("Not a URL")
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new McpServerError("An MCP server is reached over HTTP(S)")
  if (url.hash) throw new McpServerError("A server URL has no fragment")
  return url.toString()
}

/**
 * Declare a server. With a header, that header is how it's reached. Without, the server is asked:
 * one that answers is open, one that challenges with OAuth metadata is `oauth`, and one that
 * challenges without any can only be reached with a header you have to give.
 */
export async function createServer(input: CreateServerInput): Promise<McpServer> {
  const name = input.name.trim().toLowerCase()
  if (!MCP_SERVER_NAME.test(name)) throw new McpServerError("A name is lowercase letters, digits and dashes (up to 40)")
  const url = checkUrl(input.url.trim())
  const taken = () => {
    if (db.select({ id: mcpServers.id }).from(mcpServers).where(eq(mcpServers.name, name)).get()) {
      throw new McpServerError(`A server named "${name}" already exists`, 409)
    }
  }
  taken()

  const base = { id: newId(), name, url, mode: input.mode ?? "default", createdAt: new Date() }

  if (input.headerName?.trim() || input.headerValue) {
    const headerName = input.headerName?.trim() ?? ""
    if (!/^[A-Za-z0-9-]+$/.test(headerName) || !input.headerValue) throw new McpServerError("A header needs a name and a value")
    return db
      .insert(mcpServers)
      .values({ ...base, auth: "header", encryptedHeaderName: encrypt(headerName), encryptedHeaderValue: encrypt(input.headerValue) })
      .returning()
      .get()
  }

  let probed: oauth.ProbeResult
  try {
    probed = await oauth.probe(url)
  } catch (err) {
    throw new McpServerError((err as Error).message, 502)
  }
  // The probe took a while: someone may have taken the name meanwhile.
  taken()
  if (probed.kind === "closed") {
    throw new McpServerError(
      `The server asks for credentials (${probed.status}) but advertises no OAuth: give the header it expects (e.g. Authorization: Bearer …)`,
    )
  }
  if (probed.kind === "open") return db.insert(mcpServers).values({ ...base, auth: "none" }).returning().get()
  return db
    .insert(mcpServers)
    .values({
      ...base,
      auth: "oauth",
      oauth: probed.metadata as unknown as Record<string, unknown>,
      clientId: input.clientId?.trim() || null,
      encryptedClientSecret: input.clientId?.trim() && input.clientSecret ? encrypt(input.clientSecret) : null,
    })
    .returning()
    .get()
}

export function setMode(id: string, mode: McpMode): McpServer | undefined {
  return db.update(mcpServers).set({ mode }).where(eq(mcpServers.id, id)).returning().get()
}

/** Its connection, project settings and pending authorizations go with it (cascade). */
export function deleteServer(id: string): boolean {
  return db.delete(mcpServers).where(eq(mcpServers.id, id)).returning({ id: mcpServers.id }).all().length > 0
}

// ─── Connecting ──────────────────────────────────────────────────────────────

function clientOf(server: McpServer): oauth.OAuthClient {
  if (!server.clientId) throw new McpServerError("The server has no OAuth client yet")
  return { clientId: server.clientId, ...(server.encryptedClientSecret ? { clientSecret: decrypt(server.encryptedClientSecret) } : {}) }
}

/**
 * Start an authorization: the URL to send the browser to. `origin` is Lite's origin as the browser
 * sees it — where the authorization server will send it back (`/api/mcp/oauth/callback`).
 */
export async function startConnect(serverId: string, origin: string): Promise<string> {
  let server = getServer(serverId)
  if (!server) throw new McpServerError("Not found", 404)
  const meta = metadataOf(server)
  if (!meta) throw new McpServerError("This server is not connected through OAuth")
  const redirectUri = oauth.redirectUriFor(origin)

  // Registered on first use and kept on the server row — and again if Lite is reached from
  // another origin than the one the client was registered for. A client given at declaration is
  // never replaced: its redirect URI is the human's business.
  const registered = !server.clientId || meta.registeredRedirectUri
  if (registered && meta.registeredRedirectUri !== redirectUri) {
    let client: oauth.OAuthClient
    try {
      client = await oauth.registerClient(meta, redirectUri)
    } catch (err) {
      throw new McpServerError((err as Error).message, 502)
    }
    server = db
      .update(mcpServers)
      .set({
        clientId: client.clientId,
        encryptedClientSecret: client.clientSecret ? encrypt(client.clientSecret) : null,
        oauth: { ...meta, registeredRedirectUri: redirectUri } as unknown as Record<string, unknown>,
      })
      .where(eq(mcpServers.id, server.id))
      .returning()
      .get()
  }

  const { verifier, challenge } = oauth.pkce()
  const state = randomBytes(24).toString("base64url")
  db.delete(mcpOauthStates).where(lt(mcpOauthStates.createdAt, new Date(Date.now() - STATE_TTL_MS))).run()
  db.insert(mcpOauthStates)
    .values({ state, serverId: server.id, encryptedCodeVerifier: encrypt(verifier), issuer: meta.issuer, redirectUri, createdAt: new Date() })
    .run()
  return oauth.authorizationUrl(meta, server.clientId!, redirectUri, state, challenge)
}

/** The server an authorization in progress is for — read before the state is spent. */
export function pendingServer(state: string): McpServer | undefined {
  const row = db.select({ serverId: mcpOauthStates.serverId }).from(mcpOauthStates).where(eq(mcpOauthStates.state, state)).get()
  return row ? getServer(row.serverId) : undefined
}

/** Finish an authorization the browser came back with. Spends the state, whatever happens. */
export async function finishConnect(params: { state: string; code?: string; iss?: string; error?: string }): Promise<McpServer> {
  const pending = db.delete(mcpOauthStates).where(eq(mcpOauthStates.state, params.state)).returning().get()
  if (!pending || pending.createdAt.getTime() < Date.now() - STATE_TTL_MS) throw new McpServerError("This authorization expired — connect again")
  const server = getServer(pending.serverId)
  const meta = server && metadataOf(server)
  if (!server || !meta) throw new McpServerError("The server is gone", 404)
  const issuerProblem = oauth.issuerError(meta, pending.issuer, params.iss)
  // On a mismatch, nothing the response says can be trusted — not even its error.
  if (issuerProblem) throw new McpServerError(issuerProblem)
  if (params.error) throw new McpServerError(`The authorization was not granted (${params.error})`)
  if (!params.code) throw new McpServerError("The authorization response carries no code")

  let tokens: oauth.TokenSet
  try {
    tokens = await oauth.exchangeCode(meta, clientOf(server), params.code, decrypt(pending.encryptedCodeVerifier), pending.redirectUri)
  } catch (err) {
    throw new McpServerError((err as Error).message, 502)
  }
  const values = {
    encryptedAccessToken: encrypt(tokens.accessToken),
    encryptedRefreshToken: tokens.refreshToken ? encrypt(tokens.refreshToken) : null,
    expiresAt: tokens.expiresAt === null ? null : new Date(tokens.expiresAt),
    scope: tokens.scope ?? null,
    status: "ok" as const,
    connectedAt: new Date(),
  }
  db.insert(mcpConnections)
    .values({ serverId: server.id, ...values })
    .onConflictDoUpdate({ target: mcpConnections.serverId, set: values })
    .run()
  return server
}

/** Effective at the gateway's next call. */
export function disconnect(serverId: string): boolean {
  return db.delete(mcpConnections).where(eq(mcpConnections.serverId, serverId)).returning({ id: mcpConnections.serverId }).all().length > 0
}

// ─── Using a connection ──────────────────────────────────────────────────────

/**
 * Refreshes in flight, per server. Refresh tokens are often single-use: two calls refreshing at
 * once would leave the connection holding the one that was just spent. Cloud holds a row lock
 * (`SELECT … FOR UPDATE`); Lite is one process, so a promise every concurrent caller joins does
 * the same job — the way it already serializes per-worker work with promise chains.
 */
const refreshing = new Map<string, Promise<string>>()

/**
 * A good access token for this server's connection, refreshed if it is about to expire — or if
 * the server just refused one (`refused`: the token it refused). A token refused while another
 * call already replaced it is not refreshed again: the new one is returned.
 */
export async function accessToken(serverId: string, opts: { refused?: string } = {}): Promise<string> {
  const inFlight = refreshing.get(serverId)
  if (inFlight) return inFlight
  const server = getServer(serverId)
  const meta = server && metadataOf(server)
  if (!server || !meta) throw new NotConnected("not an OAuth server")
  const conn = getConnection(serverId)
  if (!conn || conn.status !== "ok") throw new NotConnected("needs a new Connect")
  const current = decrypt(conn.encryptedAccessToken)
  const fresh = !conn.expiresAt || conn.expiresAt.getTime() - REFRESH_MARGIN_MS > Date.now()
  const force = opts.refused !== undefined
  if (force && opts.refused !== current) return current
  if (fresh && !force) return current

  const reauth = (why: string): never => {
    db.update(mcpConnections).set({ status: "needs_reauth" }).where(eq(mcpConnections.serverId, serverId)).run()
    throw new NotConnected(why)
  }
  const run = async (): Promise<string> => {
    if (!conn.encryptedRefreshToken) {
      // Nothing to refresh with: an unexpired token is still worth a try, a refused or expired one is not.
      return fresh && !force ? current : reauth("the token was refused, and the server gave no refresh token")
    }
    let tokens: oauth.TokenSet
    try {
      tokens = await oauth.refreshTokens(meta, clientOf(server), decrypt(conn.encryptedRefreshToken))
    } catch (err) {
      if (err instanceof oauth.TokenRefused) return reauth(err.message)
      throw err
    }
    db.update(mcpConnections)
      .set({
        encryptedAccessToken: encrypt(tokens.accessToken),
        // A server that doesn't rotate keeps the one it gave.
        ...(tokens.refreshToken ? { encryptedRefreshToken: encrypt(tokens.refreshToken) } : {}),
        expiresAt: tokens.expiresAt === null ? null : new Date(tokens.expiresAt),
        ...(tokens.scope ? { scope: tokens.scope } : {}),
      })
      .where(eq(mcpConnections.serverId, serverId))
      .run()
    return tokens.accessToken
  }
  const p = run().finally(() => refreshing.delete(serverId))
  refreshing.set(serverId, p)
  return p
}

/** The static header of a `header` server, as `[name, value]`. */
export function staticHeader(server: McpServer): [string, string] | null {
  return server.auth === "header" && server.encryptedHeaderName && server.encryptedHeaderValue
    ? [decrypt(server.encryptedHeaderName), decrypt(server.encryptedHeaderValue)]
    : null
}

// ─── Per project ─────────────────────────────────────────────────────────────

/** What decided whether a project gets a server: the server's mode, or the project's own setting. */
export type McpReason = "server-mode" | "project"

export type ProjectServerState = {
  server: McpServer
  enabled: boolean
  reason: McpReason
  /** What the server's mode alone says. */
  modeDefault: boolean
  /** The project's own setting, if any. */
  setting: boolean | null
}

function projectSettings(projectId: string): Map<string, boolean> {
  const rows = db.select().from(projectMcpSettings).where(eq(projectMcpSettings.projectId, projectId)).all()
  return new Map(rows.map((r) => [r.serverId, r.enabled]))
}

function serverState(server: Pick<McpServer, "mode">, setting: boolean | undefined) {
  const modeDefault = server.mode === "default"
  return setting === undefined
    ? { enabled: modeDefault, reason: "server-mode" as const, modeDefault, setting: null }
    : { enabled: setting, reason: "project" as const, modeDefault, setting }
}

/** Every server, and whether this project's tasks get it. */
export function projectServers(projectId: string): ProjectServerState[] {
  const settings = projectSettings(projectId)
  return listServers().map((server) => ({ server, ...serverState(server, settings.get(server.id)) }))
}

export function isEnabledForProject(server: McpServer, projectId: string): boolean {
  const row = db
    .select({ enabled: projectMcpSettings.enabled })
    .from(projectMcpSettings)
    .where(and(eq(projectMcpSettings.projectId, projectId), eq(projectMcpSettings.serverId, server.id)))
    .get()
  return serverState(server, row?.enabled).enabled
}

/**
 * Turn a server on or off for a project. Setting it to what the server's mode already says
 * removes the project's exception instead of recording a copy of the default, which would stop
 * following the mode.
 */
export function setProjectServer(projectId: string, server: McpServer, enabled: boolean): void {
  if (enabled === (server.mode === "default")) return clearProjectServer(projectId, server.id)
  const now = new Date()
  db.insert(projectMcpSettings)
    .values({ id: newId(), projectId, serverId: server.id, enabled, updatedAt: now })
    .onConflictDoUpdate({ target: [projectMcpSettings.projectId, projectMcpSettings.serverId], set: { enabled, updatedAt: now } })
    .run()
}

export function clearProjectServer(projectId: string, serverId: string): void {
  db.delete(projectMcpSettings).where(and(eq(projectMcpSettings.projectId, projectId), eq(projectMcpSettings.serverId, serverId))).run()
}

// ─── Task sessions ───────────────────────────────────────────────────────────

/**
 * The servers a task session of this project gets (`SPUNTO_AGENT_MCP`): every server the project
 * has on that can be called right now. An OAuth server without a valid connection is left out —
 * an `initialize` that fails makes the harness drop the server anyway, and the session is better
 * off without a broken tool than with one.
 */
export function taskMcpServers(projectId: string): AgentMcpServer[] {
  const out: AgentMcpServer[] = []
  for (const { server: s, enabled } of projectServers(projectId)) {
    if (!enabled) continue
    if (s.auth === "oauth" && getConnection(s.id)?.status !== "ok") continue
    out.push({ name: s.name, path: gatewayPath(s.id) })
  }
  return out
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex")

/**
 * The token a task session shows the gateway (`SPUNTO_WORKER_TOKEN`, as the runners read it).
 * Minted at every session start; the older ones of the task stay valid and die with its row.
 * Only the hash is stored.
 */
export function mintMcpGatewayToken(taskId: string, projectId: string): string {
  const token = `${GATEWAY_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`
  db.insert(mcpGatewayTokens).values({ tokenHash: sha256(token), taskId, projectId, createdAt: new Date() }).run()
  return token
}

/** The project a gateway token was minted for, or null for anything else. */
export function resolveGatewayToken(token: string | undefined): { taskId: string; projectId: string } | null {
  if (!token?.startsWith(GATEWAY_TOKEN_PREFIX)) return null
  const row = db
    .select({ taskId: mcpGatewayTokens.taskId, projectId: mcpGatewayTokens.projectId })
    .from(mcpGatewayTokens)
    .where(eq(mcpGatewayTokens.tokenHash, sha256(token)))
    .get()
  return row ?? null
}
