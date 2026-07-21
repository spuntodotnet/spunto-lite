import { readdirSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { HOST_SSH_DIR } from "./env"

const NON_KEY_FILES = new Set(["config", "known_hosts", "known_hosts.old", "authorized_keys", "environment"])

export type HostKey = { name: string; hasPublic: boolean }

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
    try {
      const head = readFileSync(join(HOST_SSH_DIR, name), "utf8").slice(0, 40)
      if (!head.includes("PRIVATE KEY")) continue
    } catch {
      continue
    }
    keys.push({ name, hasPublic: entries.includes(`${name}.pub`) })
  }
  return keys.sort((a, b) => a.name.localeCompare(b.name))
}

/** Reads a host private key by relative filename. Returns null if missing/unreadable. */
export function readHostPrivateKey(name: string | null | undefined): string | null {
  if (!name) return null
  // Guard against path traversal — only a bare filename in HOST_SSH_DIR is allowed.
  if (name.includes("/") || name.includes("..")) return null
  const path = join(HOST_SSH_DIR, name)
  if (!existsSync(path)) return null
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}
