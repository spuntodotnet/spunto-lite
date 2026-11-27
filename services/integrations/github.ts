import { githubApiBase } from "../../lib/integrations/github"
import type { PullRequestState } from "../../lib/integrations"
import { forgeFetch, IntegrationError, REPOSITORY_PAGES, type ForgeRepository, type IntegrationDriver } from "./types"

const headers = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "spunto-lite",
})

/** One GraphQL round trip for everything the tile shows — REST would take three. */
const PULL_REQUEST_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      title state isDraft mergeable reviewDecision
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    }
  }
}`

type GraphQlPullRequest = {
  title: string
  state: "OPEN" | "CLOSED" | "MERGED"
  isDraft: boolean
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN"
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] }
}

const CHECKS: Record<string, PullRequestState["checks"]> = {
  SUCCESS: "success",
  FAILURE: "failure",
  ERROR: "failure",
  PENDING: "pending",
  EXPECTED: "pending",
}

const REVIEW: Record<string, PullRequestState["review"]> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  REVIEW_REQUIRED: "required",
}

export const githubDriver: IntegrationDriver = {
  kind: "github",

  async whoami(origin, token) {
    const user = (await forgeFetch("GitHub", `${githubApiBase(origin).rest}/user`, { headers: headers(token) })) as { login?: string }
    if (!user.login) throw new IntegrationError("GitHub answered without a login — is this the right host?", 502)
    return user.login
  },

  async pullRequest(ref, token) {
    const [owner, name] = ref.repo.split("/")
    const body = (await forgeFetch("GitHub", githubApiBase(ref.origin).graphql, {
      method: "POST",
      headers: { ...headers(token), "content-type": "application/json" },
      body: JSON.stringify({ query: PULL_REQUEST_QUERY, variables: { owner, name, number: ref.number } }),
    })) as { data?: { repository: { pullRequest: GraphQlPullRequest | null } | null }; errors?: { message: string }[] }
    const pr = body.data?.repository?.pullRequest
    if (!pr) throw new IntegrationError(body.errors?.[0]?.message ?? `GitHub knows no ${ref.repo}#${ref.number}`, 404)
    const state = pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.isDraft ? "draft" : "open"
    const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup?.state
    return {
      title: pr.title,
      state,
      checks: rollup ? CHECKS[rollup] : undefined,
      review: pr.reviewDecision ? REVIEW[pr.reviewDecision] : undefined,
      conflicts: pr.mergeable === "CONFLICTING" || undefined,
    }
  },

  /** Owned, collaborated on and through an organization — what a fine-grained token was granted. */
  async listRepositories(origin, token) {
    const repos: ForgeRepository[] = []
    for (let page = 1; page <= REPOSITORY_PAGES; page++) {
      const batch = (await forgeFetch(
        "GitHub",
        `${githubApiBase(origin).rest}/user/repos?per_page=100&sort=pushed&page=${page}`,
        { headers: headers(token) },
      )) as { full_name: string; clone_url: string; private: boolean }[]
      repos.push(...batch.map((r) => ({ fullName: r.full_name, httpsUrl: r.clone_url, private: r.private })))
      if (batch.length < 100) break
    }
    return repos
  },
}
