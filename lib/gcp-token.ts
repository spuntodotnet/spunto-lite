import { SignJWT, importPKCS8 } from "jose"
import { createHash } from "node:crypto"

// Mint a short-lived Google OAuth2 access token from a pasted GCP credential, so we
// can authenticate `docker pull` / `docker build` against private Artifact Registry
// / GCR as username `oauth2accesstoken` — exactly what `docker-credential-gcloud`
// does on the host. Supports both credential shapes gcloud produces:
//   • service_account key  → signed-JWT bearer grant
//   • authorized_user ADC  → refresh-token grant (gcloud auth application-default login)

const TOKEN_URI = "https://oauth2.googleapis.com/token"
// Artifact Registry / GCR read is covered by cloud-platform. Only used for the SA
// JWT; refresh-token grants reuse whatever scopes the user's ADC already carries.
const SA_SCOPE = "https://www.googleapis.com/auth/cloud-platform"

type AuthorizedUser = { type: "authorized_user"; client_id: string; client_secret: string; refresh_token: string }
type ServiceAccountKey = { type: "service_account"; client_email: string; private_key: string; token_uri?: string }

const nowSec = () => Math.floor(Date.now() / 1000)

// Cache tokens by credential hash so a pull immediately followed by a build (or
// several projects on the same key) don't each hit the token endpoint.
const cache = new Map<string, { token: string; expSec: number }>()

export async function gcpAccessTokenFromCredential(credJson: string): Promise<string> {
  const cacheKey = createHash("sha256").update(credJson).digest("hex")
  const hit = cache.get(cacheKey)
  if (hit && hit.expSec > nowSec() + 60) return hit.token

  const cred = JSON.parse(credJson) as { type?: string }
  let minted: { token: string; expiresIn: number }
  if (cred.type === "authorized_user") {
    minted = await refreshUserToken(cred as AuthorizedUser)
  } else if (cred.type === "service_account") {
    minted = await jwtBearerToken(cred as ServiceAccountKey)
  } else {
    throw new Error(
      `Unsupported GCP credential type "${cred.type ?? "unknown"}" — expected a service-account key or a gcloud user (authorized_user) credential`,
    )
  }
  cache.set(cacheKey, { token: minted.token, expSec: nowSec() + minted.expiresIn })
  return minted.token
}

async function refreshUserToken(c: AuthorizedUser): Promise<{ token: string; expiresIn: number }> {
  const resp = await fetch(TOKEN_URI, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: c.client_id,
      client_secret: c.client_secret,
      refresh_token: c.refresh_token,
    }),
  })
  if (!resp.ok) {
    throw new Error(`GCP token refresh failed: ${resp.status} ${await resp.text().catch(() => "")}`)
  }
  const json = (await resp.json()) as { access_token: string; expires_in: number }
  return { token: json.access_token, expiresIn: json.expires_in }
}

async function jwtBearerToken(key: ServiceAccountKey): Promise<{ token: string; expiresIn: number }> {
  const tokenUri = key.token_uri ?? TOKEN_URI
  const privateKey = await importPKCS8(key.private_key, "RS256")
  const iat = nowSec()
  const assertion = await new SignJWT({ scope: SA_SCOPE })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(key.client_email)
    .setSubject(key.client_email)
    .setAudience(tokenUri)
    .setIssuedAt(iat)
    .setExpirationTime(iat + 3600)
    .sign(privateKey)

  const resp = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  })
  if (!resp.ok) {
    throw new Error(`GCP token exchange failed: ${resp.status} ${await resp.text().catch(() => "")}`)
  }
  const json = (await resp.json()) as { access_token: string; expires_in: number }
  return { token: json.access_token, expiresIn: json.expires_in }
}
