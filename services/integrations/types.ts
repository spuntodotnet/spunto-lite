import type { IntegrationKind, PullRequestRef, PullRequestState } from "../../lib/integrations"

/**
 * The server half of an integration (lib/integrations/types.ts for the other one): what can be
 * asked of the forge, with the token of a connection. Only `whoami` is required — it is how a
 * token is checked when it is saved; every capability after it is optional, and a forge whose
 * driver lacks one is simply not asked.
 */
export type IntegrationDriver = {
  kind: IntegrationKind
  /** The login the token belongs to. Throws `IntegrationError` when the forge refuses it. */
  whoami(origin: string, token: string): Promise<string>
  /** Where a pull request stands: state, checks, review. */
  pullRequest?(ref: PullRequestRef, token: string): Promise<PullRequestState>
}

export class IntegrationError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 502 = 400,
  ) {
    super(message)
  }
}

/**
 * A call to a forge: bounded in time, never following a redirect (the token would go with it),
 * and an error that says which forge refused what, instead of a bare `fetch failed`.
 */
export async function forgeFetch(label: string, url: string, init: RequestInit = {}): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(6_000) })
  } catch (err) {
    throw new IntegrationError(`${label} did not answer (${(err as Error).message})`, 502)
  }
  if (res.status === 401) throw new IntegrationError(`${label} refused the token`)
  if (res.status === 403) throw new IntegrationError(`${label} denied access with this token (403)`)
  if (res.status === 404) throw new IntegrationError(`${label} answered 404 — not found, or not visible to this token`, 404)
  if (!res.ok) throw new IntegrationError(`${label} answered ${res.status}`, 502)
  try {
    return await res.json()
  } catch {
    throw new IntegrationError(`${label} answered something that is not JSON — is this the right host?`, 502)
  }
}
