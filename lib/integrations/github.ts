import type { IntegrationDefinition } from "./types"

/**
 * GitHub, and GitHub Enterprise on any host: `/<owner>/<repo>/pull/<n>`. Anything after the number
 * — `/files`, `#discussion_r1` — is the same PR.
 */
const PR_PATH = /^\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#]|$)/

export const github: IntegrationDefinition = {
  kind: "github",
  label: "GitHub",
  defaultHost: "github.com",
  shortLabel: "PR",
  numberMark: "#",
  parsePullRequestPath(pathname) {
    const m = PR_PATH.exec(pathname)
    return m ? { repo: m[1], number: Number(m[2]) } : null
  },
  pullRequestPath: (repo, number) => `/${repo}/pull/${number}`,
  newTokenUrl: (origin) =>
    `${origin}/settings/personal-access-tokens/new?name=Spunto+Lite&description=Pull+request+status+in+Spunto+Lite`,
  tokenScopes:
    "Contents (read and write, to clone and push), and Pull requests, Commit statuses, Checks (read) — fine-grained; repo — classic",
  tokenEnvVar: "GH_TOKEN",
  gitUsername: "x-access-token",
}

/** The REST and GraphQL root of an origin: `api.github.com` for the public one, `/api/v3` on Enterprise. */
export function githubApiBase(origin: string): { rest: string; graphql: string } {
  const host = new URL(origin).host
  if (host === "github.com") return { rest: "https://api.github.com", graphql: "https://api.github.com/graphql" }
  return { rest: `${origin}/api/v3`, graphql: `${origin}/api/graphql` }
}
