import type { IntegrationDefinition } from "./types"

/**
 * Bitbucket: recognised in links (`/<workspace>/<repo>/pull-requests/<n>`), never asked — no
 * driver yet, so no token to give it either.
 */
const PR_PATH = /^\/([^/]+\/[^/]+)\/pull-requests\/(\d+)(?:[/?#]|$)/

export const bitbucket: IntegrationDefinition = {
  kind: "bitbucket",
  label: "Bitbucket",
  defaultHost: "bitbucket.org",
  shortLabel: "PR",
  numberMark: "#",
  parsePullRequestPath(pathname) {
    const m = PR_PATH.exec(pathname)
    return m ? { repo: m[1], number: Number(m[2]) } : null
  },
  pullRequestPath: (repo, number) => `/${repo}/pull-requests/${number}`,
}
