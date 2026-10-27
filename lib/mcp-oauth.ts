import { createHash, randomBytes } from "node:crypto"

/**
 * Lite as an **MCP OAuth client** — Cloud's `mcp-oauth.ts` (RFC 0049 § 3.1), following the MCP
 * authorization spec (revision 2026-07-28): you paste a URL, everything else is discovered.
 *
 *   401 + WWW-Authenticate resource_metadata ─► Protected Resource Metadata (RFC 9728)
 *     ─► authorization server metadata (RFC 8414 / OIDC Discovery)
 *     ─► client id: Dynamic Client Registration (RFC 7591), else the one given at declaration
 *     ─► authorization code + PKCE S256 + `resource` (RFC 8707), `iss` checked on return (RFC 9207)
 *
 * No vendor-specific code: what a server needs is what its documents say.
 *
 * Two things of Cloud's are left out on purpose (docs/serveurs-mcp.md):
 *  - **Client ID Metadata Documents.** The authorization server would have to fetch our document
 *    from a public HTTPS URL; Lite lives on localhost and has none.
 *  - **The public-address restriction** on every fetch (Cloud's `assertPublicUrl`). Cloud guards
 *    against SSRF because its API shares a network with its database and internal apps, and the
 *    URL comes from any org. Lite is a local tool for one person who declares their own servers:
 *    an MCP server on the LAN or on localhost is a legitimate thing to point it at.
 */

/** What discovery found, kept on the server row (`mcp_servers.oauth`). */
export type McpOAuthMetadata = {
  /** The `resource` sent on every authorization and token request — the server's canonical URI. */
  resource: string
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint?: string
  /** RFC 9207: the server promises `iss` on its responses, so an answer without it is refused. */
  issParameterSupported: boolean
  tokenEndpointAuthMethods: string[]
  /** Space-separated scopes to ask for: the challenge's, else the resource's `scopes_supported`. */
  scope?: string
}

export type ProbeResult =
  | { kind: "open" }
  | { kind: "oauth"; metadata: McpOAuthMetadata }
  /** Credentials required, but no OAuth advertised: only a static header can reach it. */
  | { kind: "closed"; status: number }

export type OAuthClient = { clientId: string; clientSecret?: string }

export class McpOAuthError extends Error {}

const TIMEOUT_MS = 10_000

/**
 * Every outgoing call of the feature. No redirect is followed: a discovery document or a token
 * endpoint that moves is not one we were told about. (No address check — see the note above.)
 */
export function mcpFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, redirect: "error" })
}

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Spunto Lite", version: "1" } },
})

/* eslint-disable @typescript-eslint/no-explicit-any -- discovery documents are untyped JSON */
async function getJson(url: string): Promise<Record<string, any> | null> {
  try {
    const res = await mcpFetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) return null
    const body = await res.json()
    return body && typeof body === "object" ? body : null
  } catch {
    return null
  }
}

/** `Bearer resource_metadata="…", scope="a b"` → its parameters, lower-cased names. */
export function parseWwwAuthenticate(header: string | null): Record<string, string> {
  const params: Record<string, string> = {}
  if (!header || !/^\s*bearer\b/i.test(header)) return params
  for (const m of header.matchAll(/([a-zA-Z_][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g)) {
    params[m[1].toLowerCase()] = m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : m[3]
  }
  return params
}

/** RFC 9728 § 3.1: the well-known document is inserted between the host and the resource's path. */
export function protectedResourceCandidates(serverUrl: string): string[] {
  const u = new URL(serverUrl)
  const path = u.pathname.replace(/\/$/, "")
  const base = `${u.origin}/.well-known/oauth-protected-resource`
  return path ? [`${base}${path}`, base] : [base]
}

/** RFC 8414 § 3.1 and OIDC Discovery, in the order the MCP spec gives. */
export function authorizationServerCandidates(issuer: string): string[] {
  const u = new URL(issuer)
  const path = u.pathname.replace(/\/$/, "")
  if (!path) return [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`]
  return [
    `${u.origin}/.well-known/oauth-authorization-server${path}`,
    `${u.origin}/.well-known/openid-configuration${path}`,
    `${u.origin}${path}/.well-known/openid-configuration`,
  ]
}

const sameIssuer = (a: string, b: string) => a.replace(/\/$/, "") === b.replace(/\/$/, "")

/** Read what a server answers an unauthenticated `initialize` with, and discover its OAuth if it has one. */
export async function probe(serverUrl: string): Promise<ProbeResult> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  let res: Response
  try {
    res = await mcpFetch(serverUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: INITIALIZE,
      signal: ctrl.signal,
    })
  } catch (err) {
    throw new McpOAuthError(`Could not reach ${serverUrl}: ${(err as Error).message}`)
  } finally {
    clearTimeout(timer)
  }
  // The answer may be an open event stream: the status and headers are all we read.
  ctrl.abort()
  if (res.ok) return { kind: "open" }
  if (res.status !== 401 && res.status !== 403) throw new McpOAuthError(`${serverUrl} answered ${res.status} to an MCP initialize`)

  const challenge = parseWwwAuthenticate(res.headers.get("www-authenticate"))
  const candidates = challenge.resource_metadata ? [challenge.resource_metadata] : protectedResourceCandidates(serverUrl)
  for (const url of candidates) {
    const prm = await getJson(url)
    if (prm && Array.isArray(prm.authorization_servers) && prm.authorization_servers.length > 0) {
      return { kind: "oauth", metadata: await discover(serverUrl, prm, challenge.scope) }
    }
  }
  return { kind: "closed", status: res.status }
}

async function discover(serverUrl: string, prm: Record<string, any>, challengeScope?: string): Promise<McpOAuthMetadata> {
  const issuer = String(prm.authorization_servers[0])
  let as: Record<string, any> | null = null
  for (const url of authorizationServerCandidates(issuer)) {
    as = await getJson(url)
    if (as?.authorization_endpoint && as?.token_endpoint) break
    as = null
  }
  if (!as) throw new McpOAuthError(`No authorization server metadata found for ${issuer}`)
  // The issuer recorded for RFC 9207 must come from a validated document, not from what we asked for.
  if (typeof as.issuer === "string" && !sameIssuer(as.issuer, issuer)) {
    throw new McpOAuthError(`Authorization server metadata names issuer ${as.issuer}, expected ${issuer}`)
  }
  const methods: string[] = Array.isArray(as.code_challenge_methods_supported) ? as.code_challenge_methods_supported : []
  if (methods.length > 0 && !methods.includes("S256")) throw new McpOAuthError(`${issuer} does not support PKCE S256`)

  let scope = challengeScope || (Array.isArray(prm.scopes_supported) ? prm.scopes_supported.join(" ") : "")
  // A refresh token is what lets a task run past the first hour; ask for one where it's a scope.
  if (Array.isArray(as.scopes_supported) && as.scopes_supported.includes("offline_access") && !scope.split(" ").includes("offline_access")) {
    scope = `${scope} offline_access`.trim()
  }
  return {
    resource: typeof prm.resource === "string" && prm.resource ? prm.resource : serverUrl,
    issuer: typeof as.issuer === "string" ? as.issuer : issuer,
    authorizationEndpoint: as.authorization_endpoint,
    tokenEndpoint: as.token_endpoint,
    ...(as.registration_endpoint ? { registrationEndpoint: as.registration_endpoint } : {}),
    issParameterSupported: as.authorization_response_iss_parameter_supported === true,
    tokenEndpointAuthMethods: Array.isArray(as.token_endpoint_auth_methods_supported) ? as.token_endpoint_auth_methods_supported : [],
    ...(scope ? { scope } : {}),
  }
}

// ── The client ────────────────────────────────────────────────────────────────

/** Where an authorization server sends the browser back: Lite's own origin, as the browser sees it. */
export const redirectUriFor = (origin: string) => `${origin.replace(/\/$/, "")}/api/mcp/oauth/callback`

/**
 * A client id for this server, registered dynamically (RFC 7591) for the redirect URI the browser
 * will come back to. A server without registration needs a client id given at declaration.
 */
export async function registerClient(meta: McpOAuthMetadata, redirectUri: string): Promise<OAuthClient> {
  if (!meta.registrationEndpoint) {
    throw new McpOAuthError(
      `${meta.issuer} offers no dynamic client registration — register an OAuth client there (redirect URI ${redirectUri}) and declare the server again with its client id`,
    )
  }
  const res = await mcpFetch(meta.registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "Spunto Lite",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((err) => {
    throw new McpOAuthError(`Dynamic client registration failed: ${err.message}`)
  })
  const body = (await res.json().catch(() => ({}))) as Record<string, any>
  if (!res.ok || typeof body.client_id !== "string") {
    throw new McpOAuthError(`Dynamic client registration refused (${res.status}): ${body.error_description ?? body.error ?? "no client_id"}`)
  }
  return { clientId: body.client_id, ...(typeof body.client_secret === "string" ? { clientSecret: body.client_secret } : {}) }
}

export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url")
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") }
}

export function authorizationUrl(meta: McpOAuthMetadata, clientId: string, redirectUri: string, state: string, challenge: string): string {
  const url = new URL(meta.authorizationEndpoint)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", clientId)
  url.searchParams.set("redirect_uri", redirectUri)
  url.searchParams.set("state", state)
  url.searchParams.set("code_challenge", challenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("resource", meta.resource)
  if (meta.scope) url.searchParams.set("scope", meta.scope)
  return url.toString()
}

/**
 * RFC 9207 § 2.4, as the MCP spec tabulates it: a present `iss` must be the recorded issuer, and
 * a server that promised one may not leave it out.
 */
export function issuerError(meta: Pick<McpOAuthMetadata, "issParameterSupported">, expected: string | null, iss: string | undefined): string | null {
  if (iss !== undefined) return iss === expected ? null : "The authorization response came from another issuer"
  return meta.issParameterSupported ? "The authorization response carries no issuer" : null
}

/** `expiresAt` in epoch milliseconds, null when the server gave no `expires_in`. */
export type TokenSet = { accessToken: string; refreshToken?: string; expiresAt: number | null; scope?: string }

/** The authorization server said no (`invalid_grant`…): only a new Connect helps. */
export class TokenRefused extends McpOAuthError {}

async function tokenRequest(meta: McpOAuthMetadata, client: OAuthClient, params: Record<string, string>): Promise<TokenSet> {
  const body = new URLSearchParams({ ...params, client_id: client.clientId, resource: meta.resource })
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }
  if (client.clientSecret) {
    const methods = meta.tokenEndpointAuthMethods
    if (methods.includes("client_secret_post") && !methods.includes("client_secret_basic")) {
      body.set("client_secret", client.clientSecret)
    } else {
      const id = encodeURIComponent(client.clientId)
      const secret = encodeURIComponent(client.clientSecret)
      headers.Authorization = `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`
    }
  }
  const res = await mcpFetch(meta.tokenEndpoint, { method: "POST", headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch((err) => {
    throw new McpOAuthError(`Token endpoint unreachable: ${err.message}`)
  })
  const json = (await res.json().catch(() => ({}))) as Record<string, any>
  if (!res.ok || typeof json.access_token !== "string") {
    const reason = `${json.error ?? res.status}${json.error_description ? `: ${json.error_description}` : ""}`
    if (res.status === 400 || res.status === 401) throw new TokenRefused(`Token request refused (${reason})`)
    throw new McpOAuthError(`Token request failed (${reason})`)
  }
  const expiresIn = Number(json.expires_in)
  return {
    accessToken: json.access_token,
    ...(typeof json.refresh_token === "string" ? { refreshToken: json.refresh_token } : {}),
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : null,
    ...(typeof json.scope === "string" ? { scope: json.scope } : {}),
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function exchangeCode(meta: McpOAuthMetadata, client: OAuthClient, code: string, verifier: string, redirectUri: string) {
  return tokenRequest(meta, client, { grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier })
}

export function refreshTokens(meta: McpOAuthMetadata, client: OAuthClient, refreshToken: string) {
  return tokenRequest(meta, client, { grant_type: "refresh_token", refresh_token: refreshToken })
}
