import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import { DATA_ENCRYPTION_KEY } from "./env"

// Ported from apps/api/src/lib/crypto.ts (AES-256-GCM). Key is derived from
// DATA_ENCRYPTION_KEY instead of AUTH_SECRET.

function getKey(): Buffer {
  return createHash("sha256").update(DATA_ENCRYPTION_KEY).digest()
}

export function encrypt(text: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv)
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()])
  const authTag = cipher.getAuthTag()
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`
}

export function decrypt(encoded: string): string {
  const [ivHex, authTagHex, ciphertextHex] = encoded.split(":")
  const decipher = createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivHex, "hex"))
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"))
  return decipher.update(Buffer.from(ciphertextHex, "hex")).toString("utf8") + decipher.final("utf8")
}
