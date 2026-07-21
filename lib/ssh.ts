import { generateKeyPairSync, randomBytes } from "node:crypto"

// Ported from apps/api/src/lib/ssh.ts — ed25519 key generation + public-key
// derivation in OpenSSH format (Node's crypto can't emit OpenSSH ed25519 private
// keys, and can't re-read them, so we hand-encode/decode the binary format).

function encodeUInt32BE(n: number): Buffer {
  const buf = Buffer.allocUnsafe(4)
  buf.writeUInt32BE(n, 0)
  return buf
}

function encodeSSHString(s: string): Buffer {
  const buf = Buffer.from(s)
  return Buffer.concat([encodeUInt32BE(buf.length), buf])
}

function encodeSSHBytes(b: Buffer): Buffer {
  return Buffer.concat([encodeUInt32BE(b.length), b])
}

function buildOpenSSHPrivateKey(seed: Buffer, pub: Buffer): string {
  const BLOCK_SIZE = 8
  const pubBlob = Buffer.concat([encodeSSHString("ssh-ed25519"), encodeSSHBytes(pub)])
  const check = randomBytes(4)
  const privKey64 = Buffer.concat([seed, pub])

  const privSection = Buffer.concat([
    check,
    check,
    encodeSSHString("ssh-ed25519"),
    encodeSSHBytes(pub),
    encodeSSHBytes(privKey64),
    encodeUInt32BE(0),
  ])

  const mod = privSection.length % BLOCK_SIZE
  const padLen = mod === 0 ? 0 : BLOCK_SIZE - mod
  const padding = Buffer.from(Array.from({ length: padLen }, (_, i) => (i + 1) & 0xff))
  const paddedPrivSection = Buffer.concat([privSection, padding])

  const blob = Buffer.concat([
    Buffer.from("openssh-key-v1\0"),
    encodeSSHString("none"),
    encodeSSHString("none"),
    encodeSSHBytes(Buffer.alloc(0)),
    encodeUInt32BE(1),
    encodeSSHBytes(pubBlob),
    encodeSSHBytes(paddedPrivSection),
  ])

  const lines = blob.toString("base64").match(/.{1,70}/g) || []
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`
}

export function generateSSHKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey: pub, privateKey: priv } = generateKeyPairSync("ed25519")
  const jwk = pub.export({ format: "jwk" }) as { x: string }
  const rawPub = Buffer.from(jwk.x, "base64url")
  const pkcs8Der = priv.export({ type: "pkcs8", format: "der" }) as Buffer
  const rawSeed = pkcs8Der.subarray(-32)

  const pubBlob = Buffer.concat([encodeSSHString("ssh-ed25519"), encodeSSHBytes(rawPub)])
  const publicKey = `ssh-ed25519 ${pubBlob.toString("base64")} spunto-lite`
  const privateKey = buildOpenSSHPrivateKey(rawSeed, rawPub)
  return { publicKey, privateKey }
}

/** Derive the OpenSSH public key from a stored OpenSSH private key (binary parse). */
export function derivePublicKey(privateKeyOpenSSH: string): string {
  const b64 = privateKeyOpenSSH
    .replace(/-----BEGIN OPENSSH PRIVATE KEY-----/, "")
    .replace(/-----END OPENSSH PRIVATE KEY-----/, "")
    .replace(/\s+/g, "")
  const buf = Buffer.from(b64, "base64")
  const pubBlobLen = buf.readUInt32BE(39)
  const pubBlob = buf.subarray(43, 43 + pubBlobLen)
  return `ssh-ed25519 ${pubBlob.toString("base64")} spunto-lite`
}
