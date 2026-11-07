// What was **passed around** in a conversation — the links either side wrote, gathered into one
// thread (docs/taches.md § « Ce qui a circulé dans la conversation »). Pure: the reads live in
// `services/task-shared.ts`. Spunto Cloud's `task-shared.ts`, unchanged in what it decides.
//
// Derived from the messages at read time, never stored: the timeline already holds every word, so
// a second copy would only be one more thing to keep in step with a resumed task or an adapter fix
// replayed over history.

/** One link of the thread, deduplicated on its URL. */
export type SharedLink = {
  url: string
  /** The text of a `[label](url)` the first time it carried one; null for a bare URL. */
  label: string | null
  /** Who wrote it first. */
  role: "user" | "assistant"
  /** Where it first appeared (`task_events.seq`) and when. */
  seq: number
  ts: string
  /** How many times it was written — an agent repeats the PR it opened at the end of every turn. */
  count: number
  /** The last time it was written. What the thread is sorted on, newest first. */
  lastSeq: number
  lastTs: string
}

/** A `message` event, as the reads hand it over. */
export type MessageEvent = { seq: number; ts: string; role: unknown; text: unknown }

/** A thread longer than this is a conversation pasting a link list, not one sharing links. */
export const MAX_SHARED_LINKS = 200

// Same tokens as the timeline's markdown (`agent-markdown.tsx` in the design system), so what the
// thread collects is what a reader could have clicked: a `[label](url)` or a bare http(s) URL.
// Inline code is kept — "open `https://…`" is still a link someone was handed —, fenced blocks are
// not: a curl example against `localhost:3000` is code, not something shared.
const FENCE = /^\s*(```|~~~)/
const TOKEN = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|https?:\/\/[^\s<>()\[\]`"']+/gi

/** Sentence punctuation after a bare URL is not part of it ("… see https://x.dev/y."). */
function trimTrailing(url: string): string {
  return url.replace(/[.,;:!?*_~]+$/, "")
}

/** The links one message carries, in order, with the label a markdown link gave them. */
export function extractLinks(text: string): { url: string; label: string | null }[] {
  const out: { url: string; label: string | null }[] = []
  let fenced = false
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    for (const m of line.matchAll(TOKEN)) {
      const url = trimTrailing(m[2] ?? m[0])
      if (!isHttpUrl(url)) continue
      const label = m[1]?.replace(/[*_`]/g, "").trim() || null
      out.push({ url, label: label && label !== url ? label : null })
    }
  }
  return out
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname.length > 0
  } catch {
    return false
  }
}

/**
 * Fold a conversation's messages (oldest first) into its link thread, **newest first**: the link
 * someone is looking for is usually the one just mentioned, and a link mentioned again moves back
 * to the top — the same rule as the list of conversations.
 */
export function linkThread(messages: MessageEvent[], max = MAX_SHARED_LINKS): SharedLink[] {
  const byUrl = new Map<string, SharedLink>()
  // Where in its last message each link sits: one message giving a PR, a preview and a ticket
  // keeps that reading order rather than the order the URLs were first seen in.
  const position = new Map<string, number>()
  for (const m of messages) {
    if (typeof m.text !== "string") continue
    const role = m.role === "user" ? "user" : "assistant"
    extractLinks(m.text).forEach(({ url, label }, i) => {
      const seen = byUrl.get(url)
      if (seen) {
        if (seen.lastSeq !== m.seq) position.set(url, i)
        seen.count++
        seen.lastSeq = m.seq
        seen.lastTs = m.ts
        seen.label ??= label
        return
      }
      position.set(url, i)
      byUrl.set(url, { url, label, role, seq: m.seq, ts: m.ts, count: 1, lastSeq: m.seq, lastTs: m.ts })
    })
  }
  return [...byUrl.values()]
    .sort((a, b) => b.lastSeq - a.lastSeq || position.get(a.url)! - position.get(b.url)!)
    .slice(0, max)
}

// ── Pull requests among the links ─────────────────────────────────────────────────────────────

/** A shared link that is a pull (or merge) request on a forge — recognised by its URL alone. */
export type PullRequestLink = {
  url: string
  /** `github.com` */
  host: string
  /** `owner/repo` — for GitLab, the whole group path. */
  repo: string
  number: number
  /** `#12` on GitHub and Bitbucket, `!12` on GitLab: what each forge calls it. */
  label: string
  /** The link's own text, when it was a markdown link — usually the PR's title. */
  title: string | null
  role: "user" | "assistant"
  lastTs: string
}

// GitHub (and GitHub Enterprise: any host), GitLab (`/-/merge_requests/`), Bitbucket
// (`/pull-requests/`). Anything after the number — `/files`, `#discussion_r1` — is the same PR.
const GITHUB_PR = /^\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#]|$)/
const GITLAB_MR = /^\/(.+?)\/-\/merge_requests\/(\d+)(?:[/?#]|$)/
const BITBUCKET_PR = /^\/([^/]+\/[^/]+)\/pull-requests\/(\d+)(?:[/?#]|$)/

/** The pull request a URL points at, or null. Pure; no forge is asked anything. */
export function parsePullRequestUrl(url: string): Omit<PullRequestLink, "title" | "role" | "lastTs"> | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null
  const host = u.host.replace(/^www\./, "")
  // The canonical URL, without the tab or the anchor the link happened to carry.
  const pr = (m: RegExpExecArray, path: string, mark: string) => ({
    url: `${u.origin}/${m[1]}/${path}/${m[2]}`,
    host,
    repo: m[1],
    number: Number(m[2]),
    label: `${mark}${m[2]}`,
  })
  const gitlab = GITLAB_MR.exec(u.pathname)
  if (gitlab) return pr(gitlab, "-/merge_requests", "!")
  const github = GITHUB_PR.exec(u.pathname)
  if (github) return pr(github, "pull", "#")
  const bitbucket = BITBUCKET_PR.exec(u.pathname)
  if (bitbucket) return pr(bitbucket, "pull-requests", "#")
  return null
}

/**
 * The pull requests the thread talked about, newest first, one per PR: `…/pull/9` and
 * `…/pull/9/files` are the same one, and the first label either carried is kept.
 */
export function pullRequests(links: SharedLink[]): PullRequestLink[] {
  const byKey = new Map<string, PullRequestLink>()
  for (const link of links) {
    const pr = parsePullRequestUrl(link.url)
    if (!pr) continue
    const key = `${pr.host}/${pr.repo}/${pr.number}`
    const seen = byKey.get(key)
    if (seen) {
      seen.title ??= link.label
      continue
    }
    byKey.set(key, { ...pr, title: link.label, role: link.role, lastTs: link.lastTs })
  }
  return [...byKey.values()]
}
