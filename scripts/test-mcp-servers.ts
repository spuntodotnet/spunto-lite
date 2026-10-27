/**
 * End-to-end check of MCP servers (docs/serveurs-mcp.md) against a fake vendor — an MCP server and
 * its authorization server — served in this process. No Docker, no Next: the route handlers are
 * called as functions, on a throwaway SQLite database. Cloud's `mcp-servers.integration.test.ts`,
 * for Lite.
 *
 *   npx tsx scripts/test-mcp-servers.ts
 *
 * What is checked is the boundary: the session only shows its `lmg_` token, the vendor only ever
 * sees the token its authorization server issued; a refused token is refreshed once (once, even
 * for concurrent calls); a refused refresh puts the connection in `needs_reauth` and the agent
 * reads why; the gateway streams an SSE answer as it comes.
 */
import { createServer, type Server } from "node:http"
import { createHash } from "node:crypto"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AddressInfo } from "node:net"

const dataDir = mkdtempSync(join(tmpdir(), "spunto-lite-mcp-test-"))
process.env.DATA_DIR = dataDir
process.env.DB_PATH = join(dataDir, "test.db")

// Imported after the environment is set: lib/env reads it at import.
const { db, runMigrations, schema } = await import("../db/index")
const { eq } = await import("drizzle-orm")
const mcp = await import("../services/mcp-servers")
const serversRoute = await import("../app/api/mcp-servers/route")
const serverRoute = await import("../app/api/mcp-servers/[id]/route")
const connectRoute = await import("../app/api/mcp-servers/[id]/connect/route")
const disconnectRoute = await import("../app/api/mcp-servers/[id]/disconnect/route")
const callbackRoute = await import("../app/api/mcp/oauth/callback/route")
const projectRoute = await import("../app/api/projects/[id]/mcp-servers/route")
const projectServerRoute = await import("../app/api/projects/[id]/mcp-servers/[serverId]/route")
const gatewayRoute = await import("../app/api/mcp-gateway/[serverId]/route")

// ── The database ─────────────────────────────────────────────────────────────

/**
 * The migrations, when one of them creates the MCP tables; else the schema itself (the migration
 * is generated with the next `npm run db:generate`).
 */
const migrated = readdirSync("drizzle").some((f) => f.endsWith(".sql") && readFileSync(join("drizzle", f), "utf8").includes("`mcp_servers`"))
if (migrated) {
  runMigrations()
} else {
  const { generateSQLiteDrizzleJson, generateSQLiteMigration } = await import("drizzle-kit/api")
  const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
  for (const s of statements) db.run(s)
  console.log("  (no migration creates mcp_servers yet: tables created from db/schema.ts)")
}

// ── The fake vendor ──────────────────────────────────────────────────────────

let base = ""
const seen: { authorization?: string; sessionId?: string; apiKey?: string }[] = []
const vendor = {
  codes: new Map<string, { challenge: string; redirectUri: string }>(),
  access: new Set<string>(),
  refresh: new Set<string>(),
  issued: 0,
  refuseRefresh: false,
  registeredRedirect: "",
}

function issue() {
  const n = ++vendor.issued
  vendor.access.add(`vendor-access-${n}`)
  vendor.refresh.add(`vendor-refresh-${n}`)
  return { access_token: `vendor-access-${n}`, refresh_token: `vendor-refresh-${n}`, token_type: "Bearer", expires_in: 3600 }
}

function startVendor(): Promise<Server> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = Buffer.concat(chunks).toString()
    const send = (status: number, json: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers })
      res.end(JSON.stringify(json))
    }
    const url = new URL(req.url!, base)
    if (url.pathname === "/open") return send(200, { jsonrpc: "2.0", id: 0, result: {} })
    if (url.pathname === "/keyed") {
      seen.push({ apiKey: req.headers["x-api-key"] as string | undefined, authorization: req.headers.authorization })
      if (req.headers["x-api-key"] !== "k-123") return send(401, { error: "no key" })
      return send(200, { jsonrpc: "2.0", id: JSON.parse(body).id, result: { ok: true } })
    }
    if (url.pathname === "/mcp") {
      seen.push({ authorization: req.headers.authorization, sessionId: req.headers["mcp-session-id"] as string | undefined })
      const token = req.headers.authorization?.replace(/^Bearer /, "")
      if (!token || !vendor.access.has(token)) {
        return send(401, { error: "unauthorized" }, {
          "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="read write"`,
        })
      }
      const rpc = JSON.parse(body)
      if (rpc.method === "stream") {
        // An SSE answer whose second event only comes once the first has been read.
        res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "sess-1" })
        res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })}\n\n`)
        await streamGate
        res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: {} })}\n\n`)
        return
      }
      return send(200, { jsonrpc: "2.0", id: rpc.id, result: { tools: [{ name: "search" }] } }, { "mcp-session-id": "sess-1" })
    }
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return send(200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["read"] })
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return send(200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
        scopes_supported: ["read", "write", "offline_access"],
      })
    }
    if (url.pathname === "/register") {
      vendor.registeredRedirect = JSON.parse(body).redirect_uris[0]
      return send(201, { client_id: "dcr-client-1" })
    }
    if (url.pathname === "/token") {
      const p = new URLSearchParams(body)
      if (p.get("resource") !== `${base}/mcp`) return send(400, { error: "invalid_target" })
      if (p.get("grant_type") === "authorization_code") {
        const code = vendor.codes.get(p.get("code")!)
        const verifier = p.get("code_verifier")!
        if (!code || createHash("sha256").update(verifier).digest("base64url") !== code.challenge) return send(400, { error: "invalid_grant" })
        if (p.get("redirect_uri") !== code.redirectUri) return send(400, { error: "invalid_grant", error_description: "redirect_uri" })
        vendor.codes.delete(p.get("code")!)
        return send(200, issue())
      }
      if (p.get("grant_type") === "refresh_token") {
        const old = p.get("refresh_token")!
        if (vendor.refuseRefresh || !vendor.refresh.has(old)) return send(400, { error: "invalid_grant" })
        vendor.refresh.delete(old) // rotated: a refresh token is good once
        await new Promise((r) => setTimeout(r, 50)) // long enough for concurrent calls to pile up
        return send(200, issue())
      }
    }
    send(404, { error: "not found" })
  })
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)))
}

let releaseStream = () => {}
const streamGate = new Promise<void>((r) => (releaseStream = r))

/** What the vendor's consent page does: remember the challenge, hand back a code. */
function consent(authorizeUrl: string): { state: string; code: string } {
  const u = new URL(authorizeUrl)
  const code = `code-${Math.random().toString(36).slice(2)}`
  vendor.codes.set(code, { challenge: u.searchParams.get("code_challenge")!, redirectUri: u.searchParams.get("redirect_uri")! })
  return { state: u.searchParams.get("state")!, code }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const LITE = "http://lite.test:8080"
const p = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) })
const jsonReq = (path: string, method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`${LITE}${path}`, {
    method,
    headers: { "content-type": "application/json", host: "lite.test:8080", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

async function gatewayCall(token: string, serverId: string, method = "tools/list") {
  const res = await gatewayRoute.POST(
    jsonReq(`/api/mcp-gateway/${serverId}`, "POST", { jsonrpc: "2.0", id: 7, method }, {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "mcp-session-id": "sess-1",
    }),
    p({ serverId }),
  )
  return res
}
async function gatewayJson(token: string, serverId: string) {
  const res = await gatewayCall(token, serverId)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: (await res.json()) as any, session: res.headers.get("mcp-session-id") }
}

let fails = 0
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    console.log(`  \x1b[32m✓\x1b[0m ${name}`)
  } catch (err) {
    fails++
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${(err as Error).message}`)
  }
}
function expect(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message)
}
const eqJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// ── Setup ────────────────────────────────────────────────────────────────────

const vendorServer = await startVendor()
base = `http://127.0.0.1:${(vendorServer.address() as AddressInfo).port}`

const PROJECT = "mcptestproj1"
const OTHER_PROJECT = "mcptestproj2"
const TASK = "mcptesttask1"
const now = new Date()
db.insert(schema.projects).values([
  { id: PROJECT, name: "p", image: "node:24" },
  { id: OTHER_PROJECT, name: "q", image: "node:24" },
]).run()
db.insert(schema.tasks).values({ id: TASK, projectId: PROJECT, title: "t", prompt: "p", branch: "task/t", lastActivityAt: now, createdAt: now }).run()
const token = mcp.mintMcpGatewayToken(TASK, PROJECT)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let server: any

console.log("MCP servers — OAuth, gateway, per project")

await check("an OAuth server is discovered from its URL alone", async () => {
  const res = await serversRoute.POST(jsonReq("/api/mcp-servers", "POST", { name: "Vendor", url: `${base}/mcp` }))
  expect(res.status === 201, `status ${res.status}: ${await res.clone().text()}`)
  server = await res.json()
  expect(server.name === "vendor" && server.auth === "oauth", JSON.stringify(server))
  expect(server.issuer === base && server.scope === "read write offline_access", JSON.stringify(server))
  const row = mcp.getServer(server.id)!
  expect(mcp.metadataOf(row)?.resource === `${base}/mcp` && mcp.metadataOf(row)?.issParameterSupported, JSON.stringify(row.oauth))
})

await check("a duplicate name is refused (409), an open server is `none`, a header server is `header`", async () => {
  const dup = await serversRoute.POST(jsonReq("/api/mcp-servers", "POST", { name: "vendor", url: `${base}/mcp` }))
  expect(dup.status === 409, `dup ${dup.status}`)
  const open = await (await serversRoute.POST(jsonReq("/api/mcp-servers", "POST", { name: "open", url: `${base}/open`, mode: "optional" }))).json()
  expect(open.auth === "none" && open.mode === "optional", JSON.stringify(open))
  const keyed = await (
    await serversRoute.POST(jsonReq("/api/mcp-servers", "POST", { name: "keyed", url: `${base}/keyed`, headerName: "X-Api-Key", headerValue: "k-123" }))
  ).json()
  expect(keyed.auth === "header" && keyed.headerName === "X-Api-Key" && !JSON.stringify(keyed).includes("k-123"), JSON.stringify(keyed))
})

await check("an unconnected OAuth server is not given to a task, and the gateway says how to fix it", async () => {
  expect(!mcp.taskMcpServers(PROJECT).some((s) => s.name === "vendor"), JSON.stringify(mcp.taskMcpServers(PROJECT)))
  const res = await gatewayJson(token, server.id)
  expect(res.status === 200 && res.body.id === 7 && /vendor is not connected \(Settings → MCP servers → vendor → Connect\)/.test(res.body.error?.message), JSON.stringify(res.body))
})

await check("the gateway refuses anything but a task's token with 403", async () => {
  for (const t of ["nope", "lmg_forged", "spw_x"]) {
    const res = await gatewayCall(t, server.id)
    expect(res.status === 403, `${t}: ${res.status}`)
  }
})

let authorizeUrl = ""
await check("Connect registers a client for the request's origin, with PKCE S256 and the resource", async () => {
  const res = await connectRoute.POST(jsonReq(`/api/mcp-servers/${server.id}/connect`, "POST"), p({ id: server.id }))
  expect(res.status === 200, `status ${res.status}: ${await res.clone().text()}`)
  authorizeUrl = ((await res.json()) as { url: string }).url
  const u = new URL(authorizeUrl)
  expect(u.searchParams.get("client_id") === "dcr-client-1", u.toString())
  expect(u.searchParams.get("code_challenge_method") === "S256", u.toString())
  expect(u.searchParams.get("resource") === `${base}/mcp`, u.toString())
  expect(u.searchParams.get("redirect_uri") === `${LITE}/api/mcp/oauth/callback`, u.toString())
  expect(vendor.registeredRedirect === `${LITE}/api/mcp/oauth/callback`, vendor.registeredRedirect)
})

const callback = async (params: Record<string, string>) => {
  const res = await callbackRoute.GET(new Request(`${LITE}/api/mcp/oauth/callback?${new URLSearchParams(params)}`))
  return { status: res.status, location: new URL(res.headers.get("location")!, LITE) }
}

await check("the callback refuses another issuer, a missing promised issuer, and an unknown state", async () => {
  const a = consent(authorizeUrl)
  const r1 = await callback({ ...a, iss: "https://evil.example" })
  expect(r1.status === 302 && /another issuer/.test(r1.location.searchParams.get("mcpError") ?? ""), r1.location.toString())
  const b = consent(((await (await connectRoute.POST(jsonReq(`/x`, "POST"), p({ id: server.id }))).json()) as { url: string }).url)
  const r2 = await callback({ ...b })
  expect(/no issuer/.test(r2.location.searchParams.get("mcpError") ?? ""), r2.location.toString())
  const r3 = await callback({ state: "nope", code: "x" })
  expect(/unknown or expired/.test(r3.location.searchParams.get("mcpError") ?? ""), r3.location.toString())
  // A spent state can't be replayed.
  const r4 = await callback({ ...a, iss: base })
  expect(/unknown or expired/.test(r4.location.searchParams.get("mcpError") ?? ""), r4.location.toString())
})

await check("connects, back to Settings with ?mcpConnected=, and a task gets the gateway — not the vendor", async () => {
  const url = ((await (await connectRoute.POST(jsonReq(`/x`, "POST"), p({ id: server.id }))).json()) as { url: string }).url
  const { state, code } = consent(url)
  const r = await callback({ state, code, iss: base })
  expect(r.status === 302 && r.location.pathname === "/settings" && r.location.searchParams.get("mcpConnected") === "vendor", r.location.toString())
  const listed = mcp.taskMcpServers(PROJECT)
  expect(eqJson(listed, [{ name: "keyed", path: `/api/mcp-gateway/${mcp.listServers().find((s) => s.name === "keyed")!.id}` }, { name: "vendor", path: `/api/mcp-gateway/${server.id}` }]), JSON.stringify(listed))
  const s = await (await serversRoute.GET()).json()
  const v = s.find((x: { name: string }) => x.name === "vendor")
  expect(v.connection?.status === "ok" && !JSON.stringify(s).includes("vendor-access"), JSON.stringify(s))
})

await check("the gateway relays with the vendor's token, never the task's, and passes the session through", async () => {
  seen.length = 0
  const res = await gatewayJson(token, server.id)
  expect(res.status === 200 && res.body.result?.tools?.[0]?.name === "search", JSON.stringify(res.body))
  expect(res.session === "sess-1", `session ${res.session}`)
  expect(seen.length === 1 && seen[0].authorization === "Bearer vendor-access-1" && seen[0].sessionId === "sess-1", JSON.stringify(seen))
})

await check("a header server gets its header, not the task's token", async () => {
  seen.length = 0
  const keyed = mcp.listServers().find((s) => s.name === "keyed")!
  const res = await gatewayJson(token, keyed.id)
  expect(res.body.result?.ok === true, JSON.stringify(res.body))
  expect(seen[0].apiKey === "k-123" && seen[0].authorization === undefined, JSON.stringify(seen))
})

await check("an SSE answer is streamed as it comes, not buffered", async () => {
  const res = await gatewayCall(token, server.id, "stream")
  expect(res.headers.get("content-type") === "text/event-stream", `${res.headers.get("content-type")}`)
  const reader = res.body!.getReader()
  const first = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), 2000))])
  expect(first && !first.done && new TextDecoder().decode(first.value).includes("notifications/progress"), "first event did not arrive before the stream ended")
  releaseStream()
  let rest = ""
  for (let c = await reader.read(); !c.done; c = await reader.read()) rest += new TextDecoder().decode(c.value)
  expect(rest.includes('"id":7'), rest)
})

await check("a token the vendor refuses is refreshed once and the call retried — once for concurrent calls", async () => {
  vendor.access.clear()
  const before = vendor.issued
  const results = await Promise.all([gatewayJson(token, server.id), gatewayJson(token, server.id), gatewayJson(token, server.id)])
  for (const r of results) expect(r.body.result?.tools, JSON.stringify(r.body))
  expect(vendor.issued === before + 1, `${vendor.issued - before} refreshes`)
})

await check("an optional server is off until the project turns it on; back to the mode removes the row", async () => {
  const open = mcp.listServers().find((s) => s.name === "open")!
  expect((await gatewayCall(token, open.id)).status === 404, "optional server reachable")
  let r = await projectRoute.PUT(jsonReq("/x", "PUT", { serverId: open.id, enabled: true }), p({ id: PROJECT }))
  expect(r.status === 204, `PUT ${r.status}`)
  expect(mcp.taskMcpServers(PROJECT).some((s) => s.name === "open"), "not given after turning on")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const list = (await (await projectRoute.GET(jsonReq("/x", "GET"), p({ id: PROJECT }))).json()) as any[]
  const st = list.find((x) => x.server.name === "open")
  expect(st.enabled && st.reason === "project" && st.setting === true && st.modeDefault === false, JSON.stringify(st))
  r = await projectRoute.PUT(jsonReq("/x", "PUT", { serverId: open.id, enabled: false }), p({ id: PROJECT }))
  expect(db.select().from(schema.projectMcpSettings).all().length === 0, "a copy of the mode was stored")
  // Turning a default server off, then DELETE.
  await projectRoute.PUT(jsonReq("/x", "PUT", { serverId: server.id, enabled: false }), p({ id: PROJECT }))
  expect((await gatewayCall(token, server.id)).status === 404, "disabled server reachable")
  expect(!mcp.taskMcpServers(PROJECT).some((s) => s.name === "vendor"), "disabled server given")
  r = await projectServerRoute.DELETE(jsonReq("/x", "DELETE"), p({ id: PROJECT, serverId: server.id }))
  expect(r.status === 204 && (await gatewayJson(token, server.id)).body.result, "not back after DELETE")
})

await check("another project's token doesn't reach a server only this project turned on", async () => {
  const open = mcp.listServers().find((s) => s.name === "open")!
  await projectRoute.PUT(jsonReq("/x", "PUT", { serverId: open.id, enabled: true }), p({ id: PROJECT }))
  db.insert(schema.tasks).values({ id: "mcptesttask2", projectId: OTHER_PROJECT, title: "t", prompt: "p", branch: "task/u", lastActivityAt: now, createdAt: now }).run()
  const other = mcp.mintMcpGatewayToken("mcptesttask2", OTHER_PROJECT)
  expect((await gatewayCall(other, open.id)).status === 404, "reachable from the other project")
  expect((await gatewayCall(token, open.id)).status === 200, "not reachable from its project")
})

await check("a refused refresh marks the connection needs_reauth, and the agent reads why", async () => {
  vendor.access.clear()
  vendor.refuseRefresh = true
  const res = await gatewayJson(token, server.id)
  expect(/vendor needs to be connected again \(Settings → MCP servers → vendor → Connect\)/.test(res.body.error?.message), JSON.stringify(res.body))
  expect(mcp.getConnection(server.id)?.status === "needs_reauth", "status not needs_reauth")
  expect(!mcp.taskMcpServers(PROJECT).some((s) => s.name === "vendor"), "still given to tasks")
  vendor.refuseRefresh = false
})

await check("mode switch, disconnect and delete", async () => {
  let r = await serverRoute.PATCH(jsonReq("/x", "PATCH", { mode: "optional" }), p({ id: server.id }))
  expect(r.status === 200 && ((await r.json()) as { mode: string }).mode === "optional", "PATCH")
  r = await disconnectRoute.POST(jsonReq("/x", "POST"), p({ id: server.id }))
  expect(r.status === 204 && !mcp.getConnection(server.id), "disconnect")
  r = await serverRoute.DELETE(jsonReq("/x", "DELETE"), p({ id: server.id }))
  expect(r.status === 204 && !mcp.getServer(server.id), "delete")
  expect((await gatewayCall(token, server.id)).status === 404, "deleted server reachable")
})

await check("a task's tokens die with it", async () => {
  const open = mcp.listServers().find((s) => s.name === "open")!
  db.delete(schema.tasks).where(eq(schema.tasks.id, TASK)).run()
  expect((await gatewayCall(token, open.id)).status === 403, "token of a deleted task accepted")
})

vendorServer.close()
rmSync(dataDir, { recursive: true, force: true })
console.log(fails ? `\n${fails} failed` : "\nall passed")
process.exit(fails ? 1 : 0)
