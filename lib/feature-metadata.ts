// What a devcontainer feature declares about the container it needs — read from its own metadata,
// not from a list of ids kept here. Lite has no Docker-in-Docker switch of its own: a feature that
// says `"privileged": true` in its devcontainer-feature.json (docker-in-docker does) is what makes
// a worker's container privileged, exactly as the devcontainer spec has it.
//
// The metadata comes from the feature's OCI manifest: `devcontainer features publish` copies the
// whole devcontainer-feature.json into its `dev.containers.metadata` annotation, so one manifest
// request answers without pulling the layer. Same anonymous token dance as the image build's own
// fetcher (`buildFeatureInstallScript` in @spunto/build/script), against the same refs.

/** The part of a devcontainer-feature.json Lite acts on. */
export type FeatureMetadata = { id?: string; version?: string; privileged?: boolean }

const OCI_REF_RE = /^([^/]+)\/(.+):([^:/]+)$/

/** Per ref, for the life of the process: a tag moves rarely, and the image label is what counts once built. */
const cache = new Map<string, Promise<FeatureMetadata>>()

async function fetchFeatureMetadata(ociRef: string): Promise<FeatureMetadata> {
  const match = ociRef.match(OCI_REF_RE)
  if (!match) throw new Error(`Invalid feature OCI ref: ${ociRef}`)
  const [, registry, repo, tag] = match
  const signal = AbortSignal.timeout(15_000)
  const tokenRes = await fetch(`https://${registry}/token?scope=repository:${repo}:pull`, { signal })
  const token = tokenRes.ok ? ((await tokenRes.json()) as { token?: string }).token : undefined
  const res = await fetch(`https://${registry}/v2/${repo}/manifests/${tag}`, {
    signal,
    headers: { Accept: "application/vnd.oci.image.manifest.v1+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  })
  if (!res.ok) throw new Error(`Feature ${ociRef}: manifest request answered ${res.status}`)
  const manifest = (await res.json()) as { annotations?: Record<string, string> }
  const raw = manifest.annotations?.["dev.containers.metadata"]
  // A feature published without the annotation declares nothing we can read: an ordinary container.
  if (!raw) return {}
  return JSON.parse(raw) as FeatureMetadata
}

export function featureMetadata(ociRef: string): Promise<FeatureMetadata> {
  let p = cache.get(ociRef)
  if (!p) {
    p = fetchFeatureMetadata(ociRef)
    // A failure is not remembered: the next build or spawn asks again.
    p.catch(() => cache.delete(ociRef))
    cache.set(ociRef, p)
  }
  return p
}

/**
 * Whether any of these features asks for a privileged container. Throws when one's metadata can't
 * be read: guessing "no" would hand docker-in-docker a container its daemon can't start in.
 * Features installed from a local script (no ref) declare nothing.
 */
export async function featuresNeedPrivileged(features: { ociRef?: string }[]): Promise<boolean> {
  const refs = [...new Set(features.flatMap((f) => (f.ociRef ? [f.ociRef] : [])))]
  const metadata = await Promise.all(refs.map(featureMetadata))
  return metadata.some((m) => m.privileged === true)
}
