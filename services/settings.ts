import { eq } from "drizzle-orm"
import { db } from "../db/index"
import { settings, type Settings } from "../db/schema"
import { encrypt, decrypt } from "../lib/crypto"

const SINGLETON = "singleton"

// What the API/front is allowed to see: never the raw key, just whether one is set.
export type SettingsView = Omit<Settings, "gcpRegistryKey"> & { gcpRegistryConfigured: boolean }

export function getSettings(): Settings {
  const row = db.select().from(settings).where(eq(settings.id, SINGLETON)).get()
  if (row) return row
  const fresh: Settings = {
    id: SINGLETON,
    gitUserName: null,
    gitUserEmail: null,
    sshKeyPath: null,
    dotfilesRepo: null,
    gcpRegistryKey: null,
  }
  db.insert(settings).values(fresh).run()
  return fresh
}

/** Public projection — strips the encrypted key, exposes only a "configured" flag. */
export function getSettingsView(): SettingsView {
  const { gcpRegistryKey, ...rest } = getSettings()
  return { ...rest, gcpRegistryConfigured: !!gcpRegistryKey }
}

/**
 * Normalize a pasted GCP service-account key into canonical JSON, accepting either
 * raw JSON or base64-encoded JSON. Returns null when it is neither (invalid input).
 */
export function normalizeGcpKey(raw: string | null | undefined): string | null {
  const v = raw?.trim()
  if (!v) return null
  if (v.startsWith("{")) return v // raw JSON
  try {
    const decoded = Buffer.from(v, "base64").toString("utf8").trim()
    if (decoded.startsWith("{")) return decoded // base64-encoded JSON
  } catch {
    /* fall through */
  }
  return null
}

/** Decrypted SA key (canonical JSON) for the docker layer, or null if none is set. */
export function getGcpRegistryKey(): string | null {
  const enc = getSettings().gcpRegistryKey
  if (!enc) return null
  try {
    return decrypt(enc)
  } catch {
    return null
  }
}

type SettingsPatch = Partial<Omit<Settings, "id" | "gcpRegistryKey">> & {
  // Plaintext to (re)encrypt: undefined = leave unchanged, null/"" = clear,
  // non-empty = set (should already be validated with normalizeGcpKey).
  gcpRegistryKey?: string | null
}

export function updateSettings(patch: SettingsPatch): SettingsView {
  getSettings() // ensure the row exists
  const { gcpRegistryKey, ...rest } = patch
  const dbPatch: Partial<Settings> = { ...rest }
  if (gcpRegistryKey !== undefined) {
    const normalized = normalizeGcpKey(gcpRegistryKey)
    dbPatch.gcpRegistryKey = normalized ? encrypt(normalized) : null
  }
  db.update(settings).set(dbPatch).where(eq(settings.id, SINGLETON)).run()
  return getSettingsView()
}
