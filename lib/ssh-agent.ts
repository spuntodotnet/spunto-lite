import { spawn, type ChildProcess } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import net from "node:net"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { getSettings } from "../services/settings"
import { docker } from "./docker"
import { HOST_SSH_AUTH_SOCK, SSH_AGENT_DIR } from "./env"
import type { SshAgentStatus } from "./types"
import { hostKeyPath, isEncryptedPrivateKey, publicKeyLine, readHostPrivateKey, readHostPublicKey } from "./ssh-keys"

// SSH agent for workers — what makes a passphrase-protected key usable in a worker.
//
// Every worker mounts SSH_AGENT_DIR (a named volume) and gets `SSH_AUTH_SOCK=<dir>/agent.sock`.
// That socket is a proxy served by this process, which forwards each connection to one of:
//
//   1. our own `ssh-agent`, once the user has typed the key's passphrase in Settings. The
//      passphrase goes from the request body to ssh-add's askpass over a pipe and is dropped:
//      never written to disk, never logged, never kept in memory. Only the decrypted key lives
//      on, inside ssh-agent — gone when Spunto Lite restarts, so the passphrase is asked again.
//   2. the host's own agent, when it is mounted at HOST_SSH_AUTH_SOCK (agent forwarding).
//   3. nobody: the proxy then answers as an agent holding no key, so ssh falls back to the key
//      file silently instead of printing an agent error on every `git push`.
//
// Why a proxy rather than handing workers a socket directly: ssh-agent refuses any client whose
// uid differs from its own (the worker's `vscode` is not our root), the host agent's path is only
// known inside this container, and an upstream chosen per connection means unlocking a key reaches
// workers that are already running — no rebuild.
//
// Next bundles route handlers apart from server.ts, so this module can be loaded twice in one
// process: the state lives on globalThis to stay one agent, one proxy.

/** Path of the proxy socket, as seen by workers (same path on both sides of the mount). */
export const WORKER_AGENT_SOCK = join(SSH_AGENT_DIR, "agent.sock")

const PRIVATE_DIR = join(tmpdir(), "spunto-lite-agent")
const INTERNAL_SOCK = join(PRIVATE_DIR, "agent.sock")
const ASKPASS = join(PRIVATE_DIR, "askpass.sh")

type AgentState = {
  agent: ChildProcess | null
  /** The key loaded in our agent: name in HOST_SSH_DIR and its public line (for the workers' `.pub`). */
  unlocked: { keyName: string; publicLine: string } | null
  proxy: net.Server | null
  /** `HostConfig.Binds` entry exposing the proxy dir to workers, once resolved. */
  workerBind: string | null | undefined
}
const g = globalThis as { __spuntoSshAgent?: AgentState }
const state: AgentState = (g.__spuntoSshAgent ??= { agent: null, unlocked: null, proxy: null, workerBind: undefined })

// ─── Agent protocol (the two messages we need) ─────────────────────────────────

const SSH_AGENT_FAILURE = 5
const SSH_AGENTC_REQUEST_IDENTITIES = 11
const SSH_AGENT_IDENTITIES_ANSWER = 12

function frame(type: number, body: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(5)
  head.writeUInt32BE(body.length + 1, 0)
  head[4] = type
  return Buffer.concat([head, body])
}

/** Answers like an agent that holds no key: an empty identity list, and FAILURE to anything else. */
function serveEmptyAgent(client: net.Socket) {
  let buf = Buffer.alloc(0)
  client.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk])
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0)
      if (len > 256 * 1024) return client.destroy()
      if (buf.length < 4 + len) break
      const type = buf[4]
      buf = buf.subarray(4 + len)
      client.write(
        type === SSH_AGENTC_REQUEST_IDENTITIES ? frame(SSH_AGENT_IDENTITIES_ANSWER, Buffer.alloc(4)) : frame(SSH_AGENT_FAILURE),
      )
    }
  })
  client.on("error", () => {})
}

/** Public key blobs an agent holds, or null when it can't be reached. */
export function listAgentIdentities(sockPath: string, timeoutMs = 2000): Promise<Buffer[] | null> {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0)
    const sock = net.connect(sockPath)
    const done = (v: Buffer[] | null) => {
      sock.destroy()
      resolve(v)
    }
    sock.setTimeout(timeoutMs, () => done(null))
    sock.on("error", () => done(null))
    sock.on("connect", () => sock.write(frame(SSH_AGENTC_REQUEST_IDENTITIES)))
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk])
      if (buf.length < 4 || buf.length < 4 + buf.readUInt32BE(0)) return
      if (buf[4] !== SSH_AGENT_IDENTITIES_ANSWER) return done(null)
      const blobs: Buffer[] = []
      let off = 9
      for (let i = 0, n = buf.readUInt32BE(5); i < n; i++) {
        const len = buf.readUInt32BE(off)
        blobs.push(Buffer.from(buf.subarray(off + 4, off + 4 + len)))
        off += 4 + len
        off += 4 + buf.readUInt32BE(off) // comment
      }
      done(blobs)
    })
  })
}

function isSocket(path: string): boolean {
  try {
    return statSync(path).isSocket()
  } catch {
    return false
  }
}

// ─── Proxy ────────────────────────────────────────────────────────────────────

/** Our agent holds the key Settings has selected (not one selected before a change of mind). */
function servesSelectedKey(): boolean {
  return !!state.unlocked && state.unlocked.keyName === getSettings().sshKeyPath && isSocket(INTERNAL_SOCK)
}

function upstreamSocket(): string | null {
  if (servesSelectedKey()) return INTERNAL_SOCK
  if (isSocket(HOST_SSH_AUTH_SOCK)) return HOST_SSH_AUTH_SOCK
  return null
}

function handleClient(client: net.Socket) {
  const target = upstreamSocket()
  if (!target) return serveEmptyAgent(client)
  client.pause()
  let connected = false
  const upstream = net.connect(target)
  upstream.once("connect", () => {
    connected = true
    client.pipe(upstream).pipe(client)
    client.resume()
  })
  upstream.on("error", () => {
    if (connected) client.destroy()
    else serveEmptyAgent(client.resume())
  })
  upstream.on("close", () => connected && client.destroy())
  client.on("error", () => upstream.destroy())
  client.on("close", () => upstream.destroy())
}

/**
 * Starts the proxy every worker talks to. Called once at boot (server.ts). Never throws: without
 * it, workers just get no agent — keys without a passphrase keep working exactly as before.
 */
export function startSshAgentProxy(): void {
  if (state.proxy) return
  try {
    mkdirSync(SSH_AGENT_DIR, { recursive: true })
    rmSync(WORKER_AGENT_SOCK, { force: true })
  } catch (err) {
    console.warn(`[ssh-agent] ${SSH_AGENT_DIR} is not usable, workers get no SSH agent:`, (err as Error).message)
    return
  }
  const server = net.createServer(handleClient)
  server.on("error", (err) => {
    console.warn("[ssh-agent] proxy error:", err.message)
    state.proxy = null
  })
  server.listen(WORKER_AGENT_SOCK, () => {
    // Workers connect as their own user (`vscode`), not as us.
    chmodSync(WORKER_AGENT_SOCK, 0o666)
    console.log(`[ssh-agent] serving workers at ${WORKER_AGENT_SOCK}`)
  })
  state.proxy = server
}

/**
 * The `Binds` entry that mounts the proxy dir into a worker, or null when workers can't reach it.
 * In a container, the dir must be a mount of ours (the compose file's named volume): we find its
 * source by inspecting ourselves. Outside Docker (`npm run dev` on the host) it is a plain path.
 */
export async function workerAgentBind(): Promise<string | null> {
  if (!state.proxy) return null
  if (state.workerBind !== undefined) return state.workerBind
  if (!existsSync("/.dockerenv")) return (state.workerBind = `${SSH_AGENT_DIR}:${SSH_AGENT_DIR}:ro`)
  try {
    const info = await docker.getContainer(hostname()).inspect()
    const mount = info.Mounts.find((m) => m.Destination === SSH_AGENT_DIR)
    const source = mount ? (mount.Type === "volume" ? mount.Name : mount.Source) : null
    if (!source) console.warn(`[ssh-agent] ${SSH_AGENT_DIR} is not a mount — workers get no SSH agent (see README).`)
    return (state.workerBind = source ? `${source}:${SSH_AGENT_DIR}:ro` : null)
  } catch (err) {
    // Not cached: a transient Docker error shouldn't disable the agent for good.
    console.warn("[ssh-agent] could not inspect our own container:", (err as Error).message)
    return null
  }
}

// ─── Our own ssh-agent ────────────────────────────────────────────────────────

function run(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number } = {}) {
  return new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(cmd, args, { env: opts.env ?? process.env, stdio: ["pipe", "ignore", "pipe"] })
    let stderr = ""
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 15_000)
    child.stderr.on("data", (d) => (stderr += d))
    child.on("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, stderr: stderr.trim() })
    })
    child.stdin.on("error", () => {})
    child.stdin.end(opts.input ?? "")
  })
}

async function ensureAgent(): Promise<void> {
  if (state.agent && state.agent.exitCode === null && isSocket(INTERNAL_SOCK)) return
  mkdirSync(PRIVATE_DIR, { recursive: true, mode: 0o700 })
  rmSync(INTERNAL_SOCK, { force: true })
  // ssh-add reads the passphrase from its askpass program, which inherits ssh-add's stdin: the
  // passphrase travels over that pipe, one line. A wrong one makes ssh-add ask again, gets EOF,
  // and gives up — no retry loop on a bad passphrase.
  writeFileSync(ASKPASS, "#!/bin/sh\nexec head -n 1\n", { mode: 0o700 })
  const agent = spawn("ssh-agent", ["-D", "-a", INTERNAL_SOCK], { stdio: "ignore" })
  agent.on("exit", () => {
    if (state.agent === agent) {
      state.agent = null
      state.unlocked = null
    }
  })
  await new Promise<void>((resolve, reject) => {
    agent.once("error", (err) =>
      reject(new Error((err as NodeJS.ErrnoException).code === "ENOENT" ? "ssh-agent is not installed in this image" : err.message)),
    )
    const started = Date.now()
    const poll = () => {
      if (isSocket(INTERNAL_SOCK)) return resolve()
      if (agent.exitCode !== null || Date.now() - started > 5000) return reject(new Error("ssh-agent did not start"))
      setTimeout(poll, 50)
    }
    poll()
  })
  state.agent = agent
}

function agentEnv(): NodeJS.ProcessEnv {
  // A clean env: nothing of ours (DATA_ENCRYPTION_KEY…) leaks to ssh-add or its askpass.
  return { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH, SSH_AUTH_SOCK: INTERNAL_SOCK, SSH_ASKPASS: ASKPASS, SSH_ASKPASS_REQUIRE: "force" }
}

export class UnlockError extends Error {}

/** Decrypts the selected key into our agent with `passphrase`. Throws UnlockError on a user error. */
export async function unlockSelectedKey(passphrase: string): Promise<void> {
  const keyName = getSettings().sshKeyPath
  const path = hostKeyPath(keyName)
  const pem = readHostPrivateKey(keyName)
  if (!keyName || !path || !pem) throw new UnlockError("No SSH key selected")
  if (!isEncryptedPrivateKey(pem)) throw new UnlockError("This key has no passphrase — nothing to unlock")
  if (passphrase.includes("\n")) throw new UnlockError("Wrong passphrase")
  await ensureAgent()
  // One key at a time: the agent holds exactly what Settings has selected.
  await run("ssh-add", ["-D"], { env: agentEnv() })
  state.unlocked = null
  const { code, stderr } = await run("ssh-add", [path], { env: agentEnv(), input: `${passphrase}\n` })
  if (code !== 0) {
    // ssh-add's stderr never echoes the passphrase; surfacing it explains a permissions problem.
    if (/bad passphrase|incorrect passphrase/i.test(stderr) || stderr === "") throw new UnlockError("Wrong passphrase")
    throw new UnlockError(stderr.split("\n").pop() || "ssh-add failed")
  }
  const [blob] = (await listAgentIdentities(INTERNAL_SOCK)) ?? []
  state.unlocked = { keyName, publicLine: blob ? publicKeyLine(blob, keyName) : (readHostPublicKey(keyName)?.line ?? "") }
}

/** Forgets the decrypted key. */
export async function lockKey(): Promise<void> {
  state.unlocked = null
  if (state.agent && isSocket(INTERNAL_SOCK)) await run("ssh-add", ["-D"], { env: agentEnv() }).catch(() => {})
}

// ─── Status ───────────────────────────────────────────────────────────────────

export async function getSshAgentStatus(): Promise<SshAgentStatus> {
  const name = getSettings().sshKeyPath
  const pem = readHostPrivateKey(name)
  const key = name && pem ? { name, encrypted: isEncryptedPrivateKey(pem) } : null
  const pubBlob = key ? readHostPublicKey(key.name)?.blob : undefined
  const holds = (blobs: Buffer[] | null) => !!pubBlob && !!blobs?.some((b) => b.equals(pubBlob))

  const hostBlobs = isSocket(HOST_SSH_AUTH_SOCK) ? await listAgentIdentities(HOST_SSH_AUTH_SOCK) : null
  const internalBlobs = state.unlocked && isSocket(INTERNAL_SOCK) ? await listAgentIdentities(INTERNAL_SOCK) : null
  // A legacy PEM key without `.pub` has no readable public half: trust our own bookkeeping then.
  const unlocked = !!key && state.unlocked?.keyName === key.name && (pubBlob ? holds(internalBlobs) : !!internalBlobs?.length)
  // Same gap on the host side: with no public key to compare, an agent holding anything is the best guess.
  const hostHasKey = !!key && (pubBlob ? holds(hostBlobs) : !!hostBlobs?.length)
  const workerSocket = (await workerAgentBind()) !== null

  return {
    key,
    workerSocket,
    hostAgent: { path: HOST_SSH_AUTH_SOCK, reachable: hostBlobs !== null, identities: hostBlobs?.length ?? 0, hasKey: hostHasKey },
    unlocked,
    usable: !!key && (!key.encrypted || (workerSocket && (unlocked || hostHasKey))),
  }
}

/**
 * Public key line to write next to the worker's copy of the key (`mp_user_key.pub`). ssh, told
 * `IdentitiesOnly yes` + `IdentityFile mp_user_key`, only uses the agent key matching that file —
 * and for an encrypted legacy PEM key it can only tell which one it is from the `.pub`.
 */
export function workerPublicKeyLine(keyName: string | null | undefined): string | null {
  return readHostPublicKey(keyName)?.line ?? (state.unlocked?.keyName === keyName ? state.unlocked?.publicLine || null : null)
}
