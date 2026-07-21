import { eq, and } from "drizzle-orm"
import { db } from "../db/index"
import { projectSecrets, userSecrets } from "../db/schema"
import { newId } from "../lib/id"
import { encrypt, decrypt } from "../lib/crypto"

export type SecretMeta = { id: string; name: string }

// ─── Project-scoped secrets ───────────────────────────────────────────────────

export function listProjectSecrets(projectId: string): SecretMeta[] {
  return db
    .select({ id: projectSecrets.id, name: projectSecrets.name })
    .from(projectSecrets)
    .where(eq(projectSecrets.projectId, projectId))
    .all()
}

/** Upsert by (projectId, name) — adding an existing name replaces it. */
export function setProjectSecret(projectId: string, name: string, value: string) {
  const existing = db
    .select()
    .from(projectSecrets)
    .where(and(eq(projectSecrets.projectId, projectId), eq(projectSecrets.name, name)))
    .get()
  if (existing) {
    db.update(projectSecrets).set({ encryptedValue: encrypt(value) }).where(eq(projectSecrets.id, existing.id)).run()
  } else {
    db.insert(projectSecrets).values({ id: newId(), projectId, name, encryptedValue: encrypt(value) }).run()
  }
}

export function deleteProjectSecret(projectId: string, secretId: string) {
  db.delete(projectSecrets).where(and(eq(projectSecrets.id, secretId), eq(projectSecrets.projectId, projectId))).run()
}

// ─── Global (user) secrets ────────────────────────────────────────────────────

export function listUserSecrets(): SecretMeta[] {
  return db.select({ id: userSecrets.id, name: userSecrets.name }).from(userSecrets).all()
}

export function setUserSecret(name: string, value: string) {
  const existing = db.select().from(userSecrets).where(eq(userSecrets.name, name)).get()
  if (existing) {
    db.update(userSecrets).set({ encryptedValue: encrypt(value) }).where(eq(userSecrets.id, existing.id)).run()
  } else {
    db.insert(userSecrets).values({ id: newId(), name, encryptedValue: encrypt(value) }).run()
  }
}

export function deleteUserSecret(id: string) {
  db.delete(userSecrets).where(eq(userSecrets.id, id)).run()
}

/**
 * Merges secrets for a worker spawn, in precedence order (last wins):
 *   global < project.
 * Returns a plain { NAME: value } map of decrypted values.
 */
export function resolveSecretsForSpawn(projectId: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const s of db.select().from(userSecrets).all()) out[s.name] = decrypt(s.encryptedValue)
  for (const s of db.select().from(projectSecrets).where(eq(projectSecrets.projectId, projectId)).all()) {
    out[s.name] = decrypt(s.encryptedValue)
  }
  return out
}
