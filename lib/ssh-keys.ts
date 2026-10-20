import { readdirSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { HOST_SSH_DIR } from "./env"

const NON_KEY_FILES = new Set(["config", "known_hosts", "known_hosts.old", "authorized_keys", "environment"])

/** `encrypted`: protected by a passphrase — usable in a worker only through an agent (lib/ssh-agent.ts). */
export type HostKey = { name: string; hasPublic: boolean; encrypted: boolean }

/** Lists candidate private keys in the mounted host SSH dir. */
export function listHostKeys(): HostKey[] {
  if (!existsSync(HOST_SSH_DIR)) return []
  let entries: string[]
  try {
    entries = readdirSync(HOST_SSH_DIR)
  } catch {
    return []
  }
  const keys: HostKey[] = []
  for (const name of entries) {
    if (name.endsWith(".pub") || NON_KEY_FILES.has(name) || name.startsWith(".")) continue
    let pem: string
    try {
      pem = readFileSync(join(HOST_SSH_DIR, name), "utf8")
      if (!pem.slice(0, 40).includes("PRIVATE KEY")) continue
    } catch {
      continue
    }
    keys.push({ name, hasPublic: entries.includes(`${name}.pub`), encrypted: isEncryptedPrivateKey(pem) })
  }
  return keys.sort((a, b) => a.name.localeCompare(b.name))
}

/** Absolute path of a host key, or null for anything but a bare filename (path traversal guard). */
export function hostKeyPath(name: string | null | undefined): string | null {
  if (!name) return null
  if (name.includes("/") || name.includes("..")) return null
  return join(HOST_SSH_DIR, name)
}

/** Reads a host private key by relative filename. Returns null if missing/unreadable. */
export function readHostPrivateKey(name: string | null | undefined): string | null {
  const path = hostKeyPath(name)
  // A runtime path on the host mount: without the hint, Turbopack traces the whole project.
  if (!path || !existsSync(/*turbopackIgnore: true*/ path)) return null
  try {
    return readFileSync(/*turbopackIgnore: true*/ path, "utf8")
  } catch {
    return null
  }
}

// ─── Key format ───────────────────────────────────────────────────────────────

/** Reads the SSH wire-format `string` at `offset`: its bytes and where the next field starts. */
function readSshString(buf: Buffer, offset: number): { value: Buffer; next: number } | null {
  if (offset + 4 > buf.length) return null
  const len = buf.readUInt32BE(offset)
  if (offset + 4 + len > buf.length) return null
  return { value: buf.subarray(offset + 4, offset + 4 + len), next: offset + 4 + len }
}

const OPENSSH_MAGIC = Buffer.from("openssh-key-v1\0")

/**
 * The header of an OpenSSH-format private key (`-----BEGIN OPENSSH PRIVATE KEY-----`, what
 * `ssh-keygen` writes by default): cipher name and first public key blob. Both are stored in the
 * clear, even when the private part is encrypted.
 */
function parseOpenSshHeader(pem: string): { cipher: string; publicBlob: Buffer } | null {
  const m = pem.match(/-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/)
  if (!m) return null
  const buf = Buffer.from(m[1].replace(/\s+/g, ""), "base64")
  if (!buf.subarray(0, OPENSSH_MAGIC.length).equals(OPENSSH_MAGIC)) return null
  const cipher = readSshString(buf, OPENSSH_MAGIC.length)
  const kdf = cipher && readSshString(buf, cipher.next)
  const kdfOptions = kdf && readSshString(buf, kdf.next)
  if (!kdfOptions || kdfOptions.next + 4 > buf.length) return null
  const pub = readSshString(buf, kdfOptions.next + 4) // skip the uint32 key count
  if (!pub) return null
  return { cipher: cipher.value.toString(), publicBlob: pub.value }
}

/**
 * True when the private key needs a passphrase. Covers the three formats `ssh-keygen` can write:
 * OpenSSH (cipher ≠ "none"), legacy PEM (`Proc-Type: 4,ENCRYPTED`) and PKCS#8.
 */
export function isEncryptedPrivateKey(pem: string): boolean {
  const openssh = parseOpenSshHeader(pem)
  if (openssh) return openssh.cipher !== "none"
  return /Proc-Type:\s*4,ENCRYPTED/.test(pem) || pem.includes("BEGIN ENCRYPTED PRIVATE KEY")
}

/** The public key line of `<name>.pub`'s format (`ssh-ed25519 AAAA… comment`) built from a blob. */
export function publicKeyLine(blob: Buffer, comment = ""): string {
  const type = readSshString(blob, 0)?.value.toString() ?? "ssh-unknown"
  return `${type} ${blob.toString("base64")}${comment ? ` ${comment}` : ""}`
}

/**
 * Public key of a host key, without its passphrase: the `.pub` next to it when there is one, else
 * the clear-text header of an OpenSSH-format key. Null for a legacy PEM key with no `.pub` — its
 * public half is encrypted along with the rest.
 */
export function readHostPublicKey(name: string | null | undefined): { line: string; blob: Buffer } | null {
  const path = hostKeyPath(name)
  if (!path) return null
  try {
    const pub = readFileSync(`${path}.pub`, "utf8").trim()
    const [, b64] = pub.split(/\s+/)
    if (b64) return { line: pub, blob: Buffer.from(b64, "base64") }
  } catch {
    // No .pub — fall through to the private key's header.
  }
  const pem = readHostPrivateKey(name)
  const header = pem ? parseOpenSshHeader(pem) : null
  return header ? { line: publicKeyLine(header.publicBlob, name ?? ""), blob: header.publicBlob } : null
}
