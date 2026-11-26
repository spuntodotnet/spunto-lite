/**
 * The integrations' shared vocabulary (docs/integrations.md). Two halves per forge, as in t3code's
 * `source-control-*` packages: a **definition**, pure and importable by the browser — how its
 * URLs read, what it calls a pull request, where its API and its token page are — and a
 * **driver** (`services/integrations/`), server-only, which asks the forge, with every capability
 * optional. A forge with a definition and no driver is still recognised in links; it is only
 * never asked anything.
 *
 * A repository still names no forge (lib/types.ts, `Repository`): which integration a link or a
 * remote belongs to is read from its **host**, against the connections of Settings → Integrations.
 */

export type IntegrationKind = "github" | "gitlab" | "bitbucket"

/** A pull (or merge) request as its URL names it. */
export type PullRequestRef = {
  kind: IntegrationKind
  /** `https://github.com` — scheme and host, without `www.`: the key a connection is found by. */
  origin: string
  /** `owner/repo` — for GitLab, the whole group path. */
  repo: string
  number: number
  /** The canonical URL, without the tab or the anchor the link carried. */
  url: string
}

export type IntegrationDefinition = {
  kind: IntegrationKind
  label: string
  /** The public instance: where a connection without a host goes, and the env token applies. */
  defaultHost: string
  /** `PR` / `MR`. */
  shortLabel: string
  /** `#12` on GitHub and Bitbucket, `!12` on GitLab. */
  numberMark: string
  /** `{ repo, number }` out of a URL's path, or null: this forge's route for a pull request. */
  parsePullRequestPath(pathname: string): { repo: string; number: number } | null
  /** The canonical path of a pull request, under the origin. */
  pullRequestPath(repo: string, number: number): string
  /** Where to make a token, with the scopes preselected when the forge allows it. Absent: no driver. */
  newTokenUrl?(origin: string): string
  /** What the token needs, said to a human. */
  tokenScopes?: string
  /** The variable of the control plane's environment read as the public instance's token. */
  tokenEnvVar?: string
}

/** Where a pull request stands, as a driver read it. Each field the forge did not say is absent. */
export type PullRequestState = {
  title: string
  state: "open" | "draft" | "merged" | "closed"
  /** The head commit's checks, rolled up. */
  checks?: "success" | "failure" | "pending"
  review?: "approved" | "changes_requested" | "required"
  /** Conflicts with its base: it cannot be merged as is. */
  conflicts?: boolean
}
