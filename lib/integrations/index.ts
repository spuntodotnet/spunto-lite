import { bitbucket } from "./bitbucket"
import { github } from "./github"
import { gitlab } from "./gitlab"
import type { IntegrationDefinition, IntegrationKind, PullRequestRef } from "./types"

export type { IntegrationDefinition, IntegrationKind, PullRequestRef, PullRequestState } from "./types"

/**
 * Every forge Lite knows, in the order a URL is tried against them: GitLab's `/-/` route cannot be
 * mistaken for another, while GitHub's `/<owner>/<repo>/pull/<n>` is read on any host (Enterprise).
 * Adding a forge is a definition here, and a driver in `services/integrations/` if it is to be asked.
 */
export const definitions: IntegrationDefinition[] = [gitlab, github, bitbucket]

export function definitionOf(kind: IntegrationKind): IntegrationDefinition {
  return definitions.find((d) => d.kind === kind)!
}

/** `gitlab.example.com`, `https://gitlab.example.com/` or `http://10.0.0.2:8080` → its origin. Null if not one. */
export function normalizeOrigin(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`)
    if (u.protocol !== "https:" && u.protocol !== "http:") return null
    if (u.pathname !== "/" || u.search || u.hash || u.username) return null
    return u.origin
  } catch {
    return null
  }
}

/**
 * The pull request a URL points at, or null. Pure; no forge is asked anything. The URL keeps its
 * host as written; `origin`, the key a connection is found by, drops a `www.`.
 */
export function parsePullRequestUrl(url: string): PullRequestRef | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null
  const origin = `${u.protocol}//${u.host.replace(/^www\./, "")}`
  for (const d of definitions) {
    const pr = d.parsePullRequestPath(u.pathname)
    if (pr) return { kind: d.kind, origin, ...pr, url: `${u.origin}${d.pullRequestPath(pr.repo, pr.number)}` }
  }
  return null
}
