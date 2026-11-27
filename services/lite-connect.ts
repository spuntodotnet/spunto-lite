import { hostname } from "node:os"
import { randomBytes } from "node:crypto"
import { eq } from "drizzle-orm"
import { db } from "../db/index"
import { liteConnect, type LiteConnect } from "../db/schema"
import { decrypt, encrypt } from "../lib/crypto"
import { pkce } from "../lib/mcp-oauth"
import { normalizeCapabilities, type LiteCapability } from "../lib/lite-relay"
import { liteTunnel, type LiteTunnelStatus } from "../lib/lite-connect-hooks"

/**
 * Lite Connect (docs/lite-connect.md): this Lite paired with a Spunto Cloud account, as a public
 * OAuth client of Spunto's authorization server registered for the `lite` scope — the way an MCP
 * client is. What lives here: the row, the pairing (register, authorize, callback) and the tokens.
 * The tunnel itself is services/lite-tunnel.ts.
 *
 * Nothing here ever logs a token, and no route returns one.
 */

export const DEFAULT_SPUNTO_URL = "https://spunto.net"
const SINGLETON = "singleton"
/** How long the browser has to come back from the consent page. */
const PENDING_TTL_MS = 15 * 60_000
/** An access token with less than this left is refreshed before a `hello`. */
const REFRESH_MARGIN_MS = 5 * 60_000
const TIMEOUT_MS = 10_000

export class LiteConnectError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

/** Spunto said no to the refresh token: only a new Connect helps. The row is already cleared. */
export class LiteRefreshRefused extends LiteConnectError {}

export function getLiteConnect(): LiteConnect {
  const row = db.select().from(liteConnect).where(eq(liteConnect.id, SINGLETON)).get()
  if (row) return row
  return db.insert(liteConnect).values({ id: SINGLETON }).returning().get()
}

function update(patch: Partial<LiteConnect>): LiteConnect {
  getLiteConnect()
  return db.update(liteConnect).set(patch).where(eq(liteConnect.id, SINGLETON)).returning().get()
}

export const isConnected = (row: LiteConnect = getLiteConnect()) => !!row.encryptedRefreshToken

/**
 * The name when none is given: the machine's hostname — except in Docker (the image's usual
 * home), where it is the container's id, which says nothing on a phone.
 */
export function defaultMachineName(): string {
  const name = hostname()
  return /^[0-9a-f]{12}$/.test(name) ? "Spunto Lite" : name
}

/** What Cloud lists this machine as. */
export const machineNameOf = (row: LiteConnect) => row.machineName?.trim() || defaultMachineName()

export function capabilitiesOf(row: LiteConnect): LiteCapability[] {
  return normalizeCapabilities(row.capabilities)
}

/** The settings card's view: never a token, never the client's pending verifier. */
export type LiteConnectView = {
  spuntoUrl: string
  machineName: string | null
  defaultMachineName: string
  capabilities: LiteCapability[]
  connected: boolean
  connectedAt: string | null
  connectionId: string | null
  lastError: string | null
  tunnel: LiteTunnelStatus
}

export function getLiteConnectView(): LiteConnectView {
  const row = getLiteConnect()
  return {
    spuntoUrl: row.spuntoUrl,
    machineName: row.machineName,
    defaultMachineName: defaultMachineName(),
    capabilities: capabilitiesOf(row),
    connected: isConnected(row),
    connectedAt: row.connectedAt?.toISOString() ?? null,
    connectionId: row.connectionId,
    lastError: row.lastError,
    tunnel: liteTunnel()?.status() ?? { state: "off", error: null, nextRetryAt: null },
  }
}

/** `https://spunto.net/` → `https://spunto.net`. Only http(s), only an origin. */
export function normalizeSpuntoUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new LiteConnectError("Spunto URL: not a URL")
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new LiteConnectError("Spunto URL: http or https only")
  return url.origin
}

/**
 * Settings → Connect to Spunto. The URL only changes while disconnected (the tokens are that
 * Spunto's). A change of capabilities while connected takes a new `hello`, so the tunnel redials —
 * Cloud takes them again at each one. The name is Cloud's from the first `hello` on (it can be
 * renamed there): a new one counts for the next pairing.
 */
export function updateLiteConnect(input: { spuntoUrl?: string; machineName?: string | null; capabilities?: string[] }): LiteConnectView {
  const row = getLiteConnect()
  const patch: Partial<LiteConnect> = {}
  if (input.spuntoUrl !== undefined) {
    const url = normalizeSpuntoUrl(input.spuntoUrl)
    if (url !== row.spuntoUrl) {
      if (isConnected(row)) throw new LiteConnectError("Disconnect before changing the Spunto URL", 409)
      patch.spuntoUrl = url
    }
  }
  if (input.machineName !== undefined) patch.machineName = input.machineName?.trim().slice(0, 100) || null
  if (input.capabilities !== undefined) patch.capabilities = normalizeCapabilities(input.capabilities)
  const before = JSON.stringify(capabilitiesOf(row))
  const after = update(patch)
  if (isConnected(after) && JSON.stringify(capabilitiesOf(after)) !== before) liteTunnel()?.restart()
  return getLiteConnectView()
}

// ─── OAuth ───────────────────────────────────────────────────────────────────

/** Every call to Spunto's authorization server: bounded, and no redirect followed. */
function spuntoFetch(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) }).catch((err) => {
    throw new LiteConnectError(`Spunto is unreachable at ${new URL(url).origin}: ${(err as Error).message}`, 502)
  })
}

export const redirectUriFor = (origin: string) => `${origin.replace(/\/$/, "")}/api/lite-connect/callback`

/** `POST /api/oauth/register`, for the `lite` scope only: a public client, no secret. */
async function registerClient(spuntoUrl: string, redirectUri: string, name: string): Promise<string> {
  const res = await spuntoFetch(`${spuntoUrl}/api/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "lite",
    }),
  })
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok || typeof body.client_id !== "string") {
    const why = body.error_description ?? body.error ?? `HTTP ${res.status}`
    throw new LiteConnectError(`Spunto refused to register this Lite: ${why}`, 502)
  }
  return body.client_id
}

/**
 * Starts the pairing: the consent page's URL, to send the browser to. `origin` is Lite's origin as
 * the browser sees it — where Spunto sends it back. The client registration is kept and reused,
 * and done again only for another Spunto or another redirect URI (Lite opened from elsewhere) —
 * the previous client's refresh token, if still held, is then revoked and forgotten.
 */
export async function startLiteConnect(origin: string): Promise<string> {
  let row = getLiteConnect()
  const redirectUri = redirectUriFor(origin)
  if (!row.clientId || row.clientSpuntoUrl !== row.spuntoUrl || row.clientRedirectUri !== redirectUri) {
    // The tokens in hand are the old client's, of no use with the new one: give them back first.
    if (isConnected(row)) await giveBackTokens(row)
    const clientId = await registerClient(row.spuntoUrl, redirectUri, machineNameOf(row))
    row = update({ clientId, clientSpuntoUrl: row.spuntoUrl, clientRedirectUri: redirectUri })
  }
  const { verifier, challenge } = pkce()
  const state = randomBytes(24).toString("base64url")
  update({ pendingState: state, encryptedPendingVerifier: encrypt(verifier), pendingRedirectUri: redirectUri, pendingAt: new Date() })

  const url = new URL(`${row.spuntoUrl}/api/oauth/authorize`)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", row.clientId!)
  url.searchParams.set("redirect_uri", redirectUri)
  url.searchParams.set("scope", "lite")
  url.searchParams.set("code_challenge", challenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", state)
  return url.toString()
}

type TokenSet = { accessToken: string; refreshToken: string; expiresAt: Date }

async function tokenRequest(row: LiteConnect, params: Record<string, string>): Promise<TokenSet> {
  const res = await spuntoFetch(`${row.spuntoUrl}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ ...params, client_id: row.clientId ?? "" }),
  })
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok || typeof body.access_token !== "string" || typeof body.refresh_token !== "string") {
    const why = String(body.error_description ?? body.error ?? `HTTP ${res.status}`)
    // 4xx is Spunto's answer about the grant; 5xx is Spunto having a bad moment.
    if (res.status >= 400 && res.status < 500) throw new LiteRefreshRefused(why, 401)
    throw new LiteConnectError(`Spunto's token endpoint failed: ${why}`, 502)
  }
  const ttl = typeof body.expires_in === "number" ? body.expires_in : 3600
  return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: new Date(Date.now() + ttl * 1000) }
}

function storeTokens(tokens: TokenSet): void {
  update({
    encryptedAccessToken: encrypt(tokens.accessToken),
    encryptedRefreshToken: encrypt(tokens.refreshToken),
    accessExpiresAt: tokens.expiresAt,
  })
}

/** The browser came back from the consent page. Spends the pending authorization, whatever happens. */
export async function finishLiteConnect(params: { state?: string; code?: string; error?: string; errorDescription?: string }): Promise<void> {
  const row = getLiteConnect()
  update({ pendingState: null, encryptedPendingVerifier: null, pendingRedirectUri: null, pendingAt: null })
  if (!params.state || !row.pendingState || params.state !== row.pendingState || !row.pendingAt || row.pendingAt.getTime() < Date.now() - PENDING_TTL_MS) {
    throw new LiteConnectError("This authorization is unknown or expired — connect again")
  }
  if (params.error) {
    throw new LiteConnectError(params.error === "access_denied" ? "Spunto: access was not allowed" : `Spunto: ${params.errorDescription ?? params.error}`)
  }
  if (!params.code) throw new LiteConnectError("Spunto's answer carries no code")
  let tokens: TokenSet
  try {
    tokens = await tokenRequest(row, {
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: row.pendingRedirectUri!,
      code_verifier: decrypt(row.encryptedPendingVerifier!),
    })
  } catch (err) {
    throw new LiteConnectError(`Spunto refused the code: ${(err as Error).message}`, 502)
  }
  storeTokens(tokens)
  update({ connectedAt: new Date(), lastError: null, connectionId: null })
  liteTunnel()?.restart()
}

/**
 * Forgets the tokens (and the link's id), keeps the client registration and the settings. From
 * Disconnect (after giving the token back, `disconnectLiteConnect`), or because Spunto ended it
 * (4403, a refused refresh). `reason` is what the card shows under « Disconnected ».
 */
export function forgetLiteConnect(reason: string | null): void {
  update({ encryptedAccessToken: null, accessExpiresAt: null, encryptedRefreshToken: null, connectedAt: null, connectionId: null, lastError: reason })
}

/**
 * `POST /api/oauth/revoke` (RFC 7009): gives this refresh token back to the Spunto that issued it.
 * Spunto drops the client's whole consent with it — its tokens, its machine in the member's list,
 * its open tunnel (closed in 4403). 200 also when Spunto no longer knows the token; 401
 * `invalid_client` when it no longer knows the client: nothing is left there either way. Anything
 * else (unreachable, 5xx, a Spunto without the route) → the reason, for the card: the machine may
 * still be listed there.
 */
async function revokeToken(spuntoUrl: string, clientId: string, refreshToken: string): Promise<string | null> {
  let res: Response
  try {
    res = await spuntoFetch(`${spuntoUrl}/api/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ token: refreshToken, client_id: clientId }),
    })
  } catch (err) {
    return (err as Error).message
  }
  if (res.ok) return null
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (res.status === 401 && body.error === "invalid_client") return null
  return `Spunto's revocation endpoint failed: ${String(body.error_description ?? body.error ?? `HTTP ${res.status}`)}`
}

/** Said under « Disconnected » when Spunto could not be told. */
const notRevoked = (why: string) =>
  `Disconnected here, but Spunto could not be told (${why}): this machine may still be listed there — remove it in Account Settings → Connected apps`

/**
 * Gives the stored refresh token back to its Spunto (the one its client was registered with), then
 * forgets the tokens and closes the tunnel — whether Spunto answered or not. The tunnel stays open
 * during the call: the 4403 Spunto closes it with is the revocation's echo, not news
 * (`revoking`). Null when revoked (or nothing to revoke), else why not.
 */
async function giveBackTokens(row: LiteConnect): Promise<string | null> {
  let why: string | null = null
  if (row.encryptedRefreshToken && row.clientId) {
    liteTunnel()?.revoking()
    why = await revokeToken(row.clientSpuntoUrl ?? row.spuntoUrl, row.clientId, decrypt(row.encryptedRefreshToken))
  }
  forgetLiteConnect(why && notRevoked(why))
  liteTunnel()?.stop()
  return why
}

export type LiteDisconnectResult = LiteConnectView & { revoked: boolean }

/** Settings → Disconnect. `revoked: false`: forgotten here, but Spunto may still list the machine (`lastError` says so). */
export async function disconnectLiteConnect(): Promise<LiteDisconnectResult> {
  const why = await giveBackTokens(getLiteConnect())
  return { ...getLiteConnectView(), revoked: why === null }
}

/**
 * The access token for the next `hello`: the stored one while it has more than a few minutes left,
 * else a refresh — whose new refresh token is kept at once (Spunto turns it at every use; the old
 * one is dead). `force` refreshes anyway: Spunto just refused the token (4401). Only the tunnel
 * calls this, one call at a time, so two refreshes never race for the same refresh token.
 */
export async function freshAccessToken(opts: { force?: boolean } = {}): Promise<string> {
  const row = getLiteConnect()
  if (!row.encryptedRefreshToken) throw new LiteRefreshRefused("Not connected", 401)
  const valid = row.encryptedAccessToken && row.accessExpiresAt && row.accessExpiresAt.getTime() - REFRESH_MARGIN_MS > Date.now()
  if (valid && !opts.force) return decrypt(row.encryptedAccessToken!)
  let tokens: TokenSet
  try {
    tokens = await tokenRequest(row, { grant_type: "refresh_token", refresh_token: decrypt(row.encryptedRefreshToken) })
  } catch (err) {
    if (err instanceof LiteRefreshRefused) {
      forgetLiteConnect(`Spunto refused to renew the connection (${err.message}) — connect again`)
    }
    throw err
  }
  storeTokens(tokens)
  return tokens.accessToken
}

export function recordWelcome(connectionId: string): void {
  update({ connectionId, lastError: null })
}
