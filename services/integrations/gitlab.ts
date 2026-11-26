import type { PullRequestState } from "../../lib/integrations"
import { forgeFetch, IntegrationError, type IntegrationDriver } from "./types"

const headers = (token: string) => ({ "private-token": token, "user-agent": "spunto-lite" })

type MergeRequest = {
  title: string
  state: "opened" | "closed" | "locked" | "merged"
  draft?: boolean
  work_in_progress?: boolean
  has_conflicts?: boolean
  /** GitLab 15.6+: why it can or cannot be merged — `not_approved`, `requested_changes`, `conflict`… */
  detailed_merge_status?: string
  head_pipeline?: { status: string } | null
}

/** A pipeline's status, as the tile says it. `canceled`, `skipped`, `manual`: nothing to say. */
const CHECKS: Record<string, PullRequestState["checks"]> = {
  success: "success",
  failed: "failure",
  running: "pending",
  pending: "pending",
  created: "pending",
  preparing: "pending",
  waiting_for_resource: "pending",
  scheduled: "pending",
}

export const gitlabDriver: IntegrationDriver = {
  kind: "gitlab",

  async whoami(origin, token) {
    const user = (await forgeFetch("GitLab", `${origin}/api/v4/user`, { headers: headers(token) })) as { username?: string }
    if (!user.username) throw new IntegrationError("GitLab answered without a username — is this the right host?", 502)
    return user.username
  },

  async pullRequest(ref, token) {
    const base = `${ref.origin}/api/v4/projects/${encodeURIComponent(ref.repo)}/merge_requests/${ref.number}`
    const mr = (await forgeFetch("GitLab", base, { headers: headers(token) })) as MergeRequest
    const state =
      mr.state === "merged" ? "merged" : mr.state === "opened" ? (mr.draft ?? mr.work_in_progress ? "draft" : "open") : "closed"
    // The approval rules are another call, and an instance without them (or a token not allowed
    // to read them) still has a state worth drawing: a failure here only drops the review badge.
    let review: PullRequestState["review"]
    if (mr.detailed_merge_status === "requested_changes") review = "changes_requested"
    else if (mr.detailed_merge_status === "not_approved") review = "required"
    else {
      const approvals = (await forgeFetch("GitLab", `${base}/approvals`, { headers: headers(token) }).catch(() => null)) as {
        approved?: boolean
        approved_by?: unknown[]
      } | null
      if (approvals?.approved && approvals.approved_by?.length) review = "approved"
    }
    return {
      title: mr.title,
      state,
      checks: mr.head_pipeline ? CHECKS[mr.head_pipeline.status] : undefined,
      review,
      conflicts: mr.has_conflicts || mr.detailed_merge_status === "conflict" || undefined,
    }
  },
}
