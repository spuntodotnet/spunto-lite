/**
 * A fake Spunto Cloud for Lite Connect (docs/lite-connect.md): the OAuth endpoints a Lite pairs
 * through and the tunnel it opens, nothing else — after Cloud's `lite.registry.ts` and
 * `oauth.service.ts` (coderhammer/spunto#873), small enough to read in one go.
 *
 * - `POST /api/oauth/register` → a public client for the `lite` scope;
 * - `GET /api/oauth/authorize` → the consent, **allowed at once**: straight back to the redirect
 *   URI with a code (Cloud shows its consent page there and waits for the member's click);
 * - `POST /api/oauth/token` → `spo_` (1 h) + `spr_` (turned at every use), PKCE S256 checked;
 * - `GET /api/lite/connect` (WebSocket) → `hello` checked, `welcome`; 4401 on a bad token.
 *
 * Imported by the integration test (services/lite-tunnel.test.ts), or run on its own to try a real
 * Lite against it:
 *
 *   npx tsx scripts/fake-spunto-cloud.ts --port 4999
 *
 * then set Settings → Connect to Spunto → Spunto URL to `http://localhost:4999`, and drive it:
 *
 *   curl localhost:4999/_fake/state                                   # hellos, events, tunnels
 *   curl -XPOST localhost:4999/_fake/relay -d '{"method":"GET","path":"/api/tasks"}'
 *   curl -XPOST localhost:4999/_fake/close -d '{"code":4403}'         # « disconnected in Spunto »
 */
import { createHash, randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { WebSocketServer, type WebSocket } from "ws"

export type Hello = { token: string; name: string; version: string; capabilities: string[]; connectionId: string | null }
export type Relayed = { status: number; contentType?: string; body: Buffer; json?: unknown }

const rand = (n = 18) => randomBytes(n).toString("base64url")

export class FakeSpuntoCloud {
  readonly clients = new Map<string, { name: string; redirectUris: string[] }>()
  readonly codes = new Map<string, { clientId: string; redirectUri: string; challenge: string }>()
  readonly accessTokens = new Set<string>()
  readonly refreshTokens = new Map<string, string>() // token → clientId
  readonly hellos: Hello[] = []
  readonly events: Record<string, unknown>[] = []
  /** Refuse every refresh (`invalid_grant`), as for a revoked or expired grant. */
  refuseRefresh = false
  refreshCount = 0
  private sockets = new Set<WebSocket>()
  private welcomed = new WeakSet<WebSocket>()
  private pending = new Map<string, (r: Relayed) => void>()
  private server: Server
  private wss = new WebSocketServer({ noServer: true })
  private connectionIds = new Map<string, string>() // clientId → lc_

  constructor() {
    this.server = createServer((req, res) => {
      void this.http(req).then(
        ({ status, body, headers }) => {
          res.writeHead(status, { "content-type": "application/json", ...headers })
          res.end(body === undefined ? "" : JSON.stringify(body))
        },
        (err) => {
          res.writeHead(500)
          res.end(String(err))
        },
      )
    })
    this.server.on("upgrade", (req, socket, head) => {
      if (req.url?.split("?")[0] !== "/api/lite/connect") return socket.destroy()
      this.wss.handleUpgrade(req, socket, head, (ws) => this.tunnel(ws))
    })
  }

  async listen(port = 0): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(port, "0.0.0.0", resolve))
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  async close(): Promise<void> {
    for (const ws of this.sockets) ws.terminate()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  get online(): number {
    return [...this.sockets].filter((ws) => ws.readyState === ws.OPEN && this.welcomed.has(ws)).length
  }

  /** What Cloud's relay does for a phone: a request down the tunnel, its response back. */
  relay(req: { method: string; path: string; query?: string; contentType?: string; body?: string }, timeoutMs = 10_000): Promise<Relayed> {
    const ws = [...this.sockets].find((s) => this.welcomed.has(s) && s.readyState === s.OPEN)
    if (!ws) return Promise.reject(new Error("lite_offline"))
    const id = rand(9)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs)
      this.pending.set(id, (r) => {
        clearTimeout(timer)
        resolve(r)
      })
      ws.send(JSON.stringify({ type: "request", id, query: "", ...req }))
    })
  }

  /** Closes every tunnel with a code: 4403 (disconnected in Spunto), 4409 (replaced), 1012 (a redeploy)… */
  closeTunnels(code: number, reason = ""): void {
    for (const ws of this.sockets) ws.close(code, reason)
  }

  /** Cuts every tunnel without a close frame — a network drop. */
  dropTunnels(): void {
    for (const ws of this.sockets) ws.terminate()
  }

  /** Every access token stops being accepted (as an hour later). Refresh tokens still work. */
  expireAccessTokens(): void {
    this.accessTokens.clear()
  }

  private tunnel(ws: WebSocket): void {
    this.sockets.add(ws)
    ws.on("close", () => this.sockets.delete(ws))
    const timer = setTimeout(() => ws.close(4401, "no hello"), 10_000)
    ws.once("message", (data) => {
      clearTimeout(timer)
      let hello: Record<string, unknown>
      try {
        hello = JSON.parse(data.toString())
      } catch {
        return ws.close(4400, "unreadable")
      }
      const token = typeof hello.token === "string" ? hello.token : ""
      const record: Hello = {
        token,
        name: String(hello.name ?? ""),
        version: String(hello.version ?? ""),
        capabilities: Array.isArray(hello.capabilities) ? hello.capabilities.map(String) : [],
        connectionId: null,
      }
      this.hellos.push(record)
      if (hello.type !== "hello" || !this.accessTokens.has(token)) return ws.close(4401, "invalid token")
      const clientId = [...this.clients.keys()][0] ?? "none"
      const connectionId = this.connectionIds.get(clientId) ?? `lc_${rand(10)}`
      this.connectionIds.set(clientId, connectionId)
      record.connectionId = connectionId
      // One tunnel per connection: the newest wins, the others are closed in 4409.
      for (const other of this.sockets) if (other !== ws && this.welcomed.has(other)) other.close(4409, "replaced by a newer connection")
      this.welcomed.add(ws)
      ws.send(JSON.stringify({ type: "welcome", connectionId }))
      ws.on("message", (raw) => {
        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(raw.toString())
        } catch {
          return
        }
        if (msg.type === "event") this.events.push(msg)
        if (msg.type === "response" && typeof msg.id === "string") {
          const settle = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          const body = Buffer.from(typeof msg.body === "string" ? msg.body : "", "base64")
          let json: unknown
          try {
            json = JSON.parse(body.toString())
          } catch {}
          settle?.({ status: Number(msg.status), contentType: msg.contentType as string | undefined, body, json })
        }
      })
    })
  }

  private async http(req: IncomingMessage): Promise<{ status: number; body?: unknown; headers?: Record<string, string> }> {
    const url = new URL(req.url ?? "/", "http://fake")
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const raw = Buffer.concat(chunks).toString()

    if (req.method === "POST" && url.pathname === "/api/oauth/register") {
      const body = JSON.parse(raw || "{}")
      if (body.scope !== "lite") return { status: 400, body: { error: "invalid_client_metadata", error_description: "lite only here" } }
      const uris: string[] = body.redirect_uris ?? []
      const ok = uris.every((u) => {
        const p = new URL(u)
        return p.protocol === "https:" || (p.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(p.hostname))
      })
      if (!uris.length || !ok) return { status: 400, body: { error: "invalid_redirect_uri", error_description: "https or loopback http only" } }
      const clientId = `mcp_${rand(12)}`
      this.clients.set(clientId, { name: body.client_name, redirectUris: uris })
      return { status: 201, body: { client_id: clientId, redirect_uris: uris } }
    }

    if (req.method === "GET" && url.pathname === "/api/oauth/authorize") {
      const q = Object.fromEntries(url.searchParams)
      const client = this.clients.get(q.client_id)
      if (!client || !client.redirectUris.includes(q.redirect_uri)) return { status: 400, body: { error: "invalid_request" } }
      if (q.scope !== "lite" || q.code_challenge_method !== "S256" || q.response_type !== "code") return { status: 400, body: { error: "invalid_request" } }
      const code = rand()
      this.codes.set(code, { clientId: q.client_id, redirectUri: q.redirect_uri, challenge: q.code_challenge })
      const back = new URL(q.redirect_uri)
      back.searchParams.set("code", code)
      if (q.state) back.searchParams.set("state", q.state)
      return { status: 302, headers: { Location: back.toString() } }
    }

    if (req.method === "POST" && url.pathname === "/api/oauth/token") {
      const p = Object.fromEntries(new URLSearchParams(raw))
      const grant = (clientId: string) => {
        const access = `spo_${rand()}`
        const refresh = `spr_${rand()}`
        this.accessTokens.add(access)
        this.refreshTokens.set(refresh, clientId)
        return { status: 200, body: { access_token: access, token_type: "Bearer", expires_in: 3600, scope: "lite", refresh_token: refresh } }
      }
      if (p.grant_type === "authorization_code") {
        const code = this.codes.get(p.code)
        this.codes.delete(p.code)
        if (!code || code.clientId !== p.client_id || code.redirectUri !== p.redirect_uri) return { status: 400, body: { error: "invalid_grant" } }
        if (createHash("sha256").update(p.code_verifier ?? "").digest("base64url") !== code.challenge) {
          return { status: 400, body: { error: "invalid_grant", error_description: "PKCE verification failed" } }
        }
        return grant(code.clientId)
      }
      if (p.grant_type === "refresh_token") {
        this.refreshCount++
        const clientId = this.refreshTokens.get(p.refresh_token)
        // Turned at every use: the one just presented is dead either way.
        this.refreshTokens.delete(p.refresh_token)
        if (this.refuseRefresh || !clientId || clientId !== p.client_id) {
          return { status: 400, body: { error: "invalid_grant", error_description: "Unknown, expired or already used refresh token" } }
        }
        return grant(clientId)
      }
      return { status: 400, body: { error: "unsupported_grant_type" } }
    }

    // The CLI's handles (not Cloud's): look at what happened, relay a request, close the tunnels.
    if (url.pathname === "/_fake/state") {
      return {
        status: 200,
        body: { online: this.online, clients: [...this.clients.keys()], hellos: this.hellos.map((h) => ({ ...h, token: `${h.token.slice(0, 8)}…` })), events: this.events },
      }
    }
    if (req.method === "POST" && url.pathname === "/_fake/relay") {
      const r = await this.relay(JSON.parse(raw)).catch((err: Error) => ({ status: 503, body: Buffer.from(JSON.stringify({ error: err.message })) }) as Relayed)
      return { status: 200, body: { status: r.status, contentType: r.contentType, body: r.body.toString().slice(0, 4000) } }
    }
    if (req.method === "POST" && url.pathname === "/_fake/close") {
      this.closeTunnels(JSON.parse(raw || "{}").code ?? 1012)
      return { status: 204 }
    }
    return { status: 404, body: { error: "not found" } }
  }
}

if (process.argv[1]?.endsWith("fake-spunto-cloud.ts")) {
  const i = process.argv.indexOf("--port")
  const port = i > 0 ? Number(process.argv[i + 1]) : 4999
  const fake = new FakeSpuntoCloud()
  void fake.listen(port).then(() => console.log(`fake Spunto Cloud on http://localhost:${port} (consent allowed at once)`))
}
