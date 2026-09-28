/**
 * Reading what a task changed — the diff against its base branch.
 *
 * **Still no forge.** The platform does not ask GitHub what a branch contains; it asks the
 * machine it started. Every fact below comes from `git` in the worker, which is the same thing
 * the reviewer would run if they opened a terminal there — and it works for a project whose
 * remote is a Gitea on a laptop, or no remote at all.
 *
 * Two consequences worth naming, because they are the whole shape of this module:
 *
 *  - **The working tree counts.** The diff is taken from the merge base to *what is on disk*, not
 *    to `HEAD`. An agent that edited ten files and committed none has changed ten files, and a
 *    reviewer who is shown "nothing" would be shown a lie. Untracked files are picked up
 *    separately (git cannot diff what it has never heard of) and marked as such.
 *  - **A stopped machine has no diff.** Review mode `stop` parks the worker; nothing here can be
 *    answered until it is back. That is reported as a state, not as an error — see the service.
 *
 * Pure functions only: build a script, parse what it printed. No worker, no database.
 */

import { shellQuote } from "./shell"

/** How a file got into the diff. `untracked` is ours: git has no status letter for it here. */
export const DIFF_STATUSES = [
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "type-changed",
  "untracked",
  "unknown",
] as const
export type DiffStatus = (typeof DIFF_STATUSES)[number]

export type DiffFile = {
  path: string
  /** Where it came from, for a rename or a copy. */
  oldPath: string | null
  status: DiffStatus
  /** `null` for a binary file — git counts no lines in one, and neither do we. */
  additions: number | null
  deletions: number | null
  binary: boolean
}

export type RepoDiff = {
  /** The repository's directory in the worker, as the reader would `cd` to it. */
  cwd: string
  /** Its label in the UI — the project's `workspacePath`, or the bare workspace. */
  name: string
  /** The base branch this was compared against, as git finally resolved it. */
  base: string
  /** Short shas, when there is something to point at. */
  mergeBase: string | null
  head: string | null
  branch: string | null
  files: DiffFile[]
  additions: number
  deletions: number
  /** Why there is no comparison to show — a missing base, a directory that is not a repository. */
  error: string | null
}

/**
 * The separator between the script's sections.
 *
 * Wrapped in SOH (`\u0001`) rather than being merely improbable: the output it delimits contains
 * arbitrary file paths, and a repository is free to hold a file called `SPUNTO-DIFF numstat`. A
 * control byte cannot appear in a path at all — git rejects it — so this is the one form of the
 * marker that a repository cannot forge. Built with a char code so no control byte ever has to
 * sit, invisible, in this file.
 */
const SOH = String.fromCharCode(1)
const MARK = `${SOH}SPUNTO-DIFF${SOH}`

/**
 * Resolving "no base branch was asked for", exactly as the branch setup does it.
 *
 * Copied in shape rather than shared as a string, because the two run at different times against
 * different repository states and the day one has to change is not the day the other does. The
 * subtleties (`refs/remotes/origin/HEAD` is often absent; `|| true` under `set -e`) are explained
 * in `branchSetupScript`.
 */
function resolveBase(baseBranch: string | null): string {
  if (baseBranch) return `base=${shellQuote(baseBranch)}`
  return `base=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||' || true)
if [ -z "$base" ]; then
  base=$(git ls-remote --symref origin HEAD 2>/dev/null | awk '$1=="ref:"{sub("refs/heads/","",$2); print $2; exit}' || true)
fi
base=\${base:-main}`
}

/**
 * The shell that describes the whole diff of one repository.
 *
 * `merge-base` and not the tip of the base branch: a reviewer wants what *this task* did, not the
 * twelve commits someone else landed on `main` in the meantime. `origin/<base>` is refreshed
 * first — a worker recycled from the pool can be days behind, and comparing against a stale
 * remote ref invents changes the task never made — but under a `timeout`, because a remote that
 * needs credentials nobody gave it hangs rather than failing, and the panel would hang with it.
 *
 * Everything is `-z`: paths come back NUL-delimited, so a rename is two plain fields instead of
 * git's `dir/{old => new}` compaction, and a filename containing a space, a quote or a newline
 * costs nothing. The text form is for humans; this is the one that is specified for parsing.
 */
export function diffSummaryScript(baseBranch: string | null): string {
  return `set -uo pipefail
${resolveBase(baseBranch)}
timeout 20 git fetch origin "$base" --quiet 2>/dev/null || true
if git rev-parse --verify --quiet "origin/$base" >/dev/null; then
  ref="origin/$base"
else
  ref="$base"
fi
merge_base=$(git merge-base "$ref" HEAD 2>/dev/null || echo "")
printf '%s base\\n%s\\n' '${MARK}' "$base"
printf '%s refs\\n%s\\n%s\\n%s\\n' '${MARK}' "$merge_base" "$(git rev-parse --short HEAD 2>/dev/null || echo '')" "$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
printf '%s numstat\\n' '${MARK}'
[ -n "$merge_base" ] && git -c core.quotePath=false diff --numstat -M -z "$merge_base" || true
printf '\\n%s namestatus\\n' '${MARK}'
[ -n "$merge_base" ] && git -c core.quotePath=false diff --name-status -M -z "$merge_base" || true
printf '\\n%s untracked\\n' '${MARK}'
git -c core.quotePath=false ls-files --others --exclude-standard -z | head -c 65536`
}

/**
 * The unified patch of a single file, as git writes it.
 *
 * `oldPath` is passed for a rename, and it is not decoration: rename detection only pairs two
 * paths that are *both* in the diff's scope, so limiting the diff to the new name alone makes git
 * render a 400-line move as 400 added lines. Measured on a scratch repo before it was here.
 */
export function filePatchScript(
  baseBranch: string | null,
  path: string,
  opts: { untracked?: boolean; oldPath?: string | null } = {},
): string {
  const { untracked = false, oldPath = null } = opts
  const quoted = oldPath && oldPath !== path ? `${shellQuote(oldPath)} ${shellQuote(path)}` : shellQuote(path)
  // An untracked file is not in any tree, so `git diff <rev> -- path` has nothing to say about
  // it. `--no-index` against /dev/null is the read-only way to render it as the new file it is —
  // the alternative, `add --intent-to-add`, would write to the index of a machine someone is
  // still working in.
  const body = untracked
    ? `git -c core.quotePath=false diff --no-color --no-index -- /dev/null ${quoted} || true`
    : `[ -n "$merge_base" ] && git -c core.quotePath=false diff --no-color -M "$merge_base" -- ${quoted} || true`
  return `set -uo pipefail
${resolveBase(baseBranch)}
if git rev-parse --verify --quiet "origin/$base" >/dev/null; then
  ref="origin/$base"
else
  ref="$base"
fi
merge_base=$(git merge-base "$ref" HEAD 2>/dev/null || echo "")
${body}`
}

/** Split the script's output into its sections, in the order they were printed. */
function sections(stdout: string): Record<string, string> {
  const out: Record<string, string> = {}
  const parts = stdout.split(MARK)
  for (const part of parts.slice(1)) {
    const newline = part.indexOf("\n")
    if (newline === -1) continue
    out[part.slice(0, newline).trim()] = part.slice(newline + 1)
  }
  return out
}

/**
 * NUL-separated fields.
 *
 * Blank ones are dropped rather than parsed: git leaves a trailing NUL, and the newline this
 * script prints before the next marker lands at the end of the section — neither is a path, and
 * both would otherwise become a file with an empty name in the list.
 */
function fields(section: string | undefined): string[] {
  if (!section) return []
  return section.split("\0").filter((f) => f.trim() !== "")
}

const STATUS_LETTERS: Record<string, DiffStatus> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type-changed",
}

/**
 * Turn what the script printed into the file list.
 *
 * `--numstat` and `--name-status` are two readings of the *same* diff, run with the same
 * rename detection, so they come back in the same order — they are zipped by position, and the
 * status falls back to `unknown` rather than guessing if one of them ever comes up short.
 */
export function parseDiffSummary(stdout: string, ctx: { cwd: string; name: string }): RepoDiff {
  const parsed = sections(stdout)
  const base = (parsed.base ?? "").split("\n")[0]?.trim() ?? ""
  // One ref per line, never one line of three: a missing merge base used to shift the other two
  // along and hand back a sha as a branch name. An empty line is a fact, and this keeps it.
  const [mergeBase = "", head = "", branch = ""] = (parsed.refs ?? "").split("\n").map((l) => l.trim())

  // numstat -z: "adds\tdels\tpath\0", or "adds\tdels\t\0old\0new\0" for a rename.
  const counts: { additions: number | null; deletions: number | null; binary: boolean; path: string; oldPath: string | null }[] = []
  const numstat = fields(parsed.numstat)
  for (let i = 0; i < numstat.length; i++) {
    const entry = numstat[i]
    if (!entry.trim()) continue
    const [adds, dels, inline] = entry.split("\t")
    const binary = adds === "-" || dels === "-"
    let path = inline ?? ""
    let oldPath: string | null = null
    if (path === "") {
      oldPath = numstat[++i] ?? ""
      path = numstat[++i] ?? ""
    }
    counts.push({
      additions: binary ? null : Number(adds) || 0,
      deletions: binary ? null : Number(dels) || 0,
      binary,
      path,
      oldPath,
    })
  }

  // name-status -z: "M\0path\0", or "R097\0old\0new\0" — a rename carries one field more.
  const statuses: DiffStatus[] = []
  const nameStatus = fields(parsed.namestatus)
  for (let i = 0; i < nameStatus.length; ) {
    const status = STATUS_LETTERS[nameStatus[i]?.[0] ?? ""] ?? "unknown"
    statuses.push(status)
    i += status === "renamed" || status === "copied" ? 3 : 2
  }

  const files: DiffFile[] = counts.map((count, i) => ({
    path: count.path,
    oldPath: count.oldPath,
    status: statuses[i] ?? "unknown",
    additions: count.additions,
    deletions: count.deletions,
    binary: count.binary,
  }))

  const tracked = new Set(files.map((f) => f.path))
  for (const path of fields(parsed.untracked)) {
    if (!path.trim() || tracked.has(path)) continue
    // No counts: getting them would mean one `git diff --no-index` per file, on a read path, for
    // a number the reader can see the moment they open the file.
    files.push({ path, oldPath: null, status: "untracked", additions: null, deletions: null, binary: false })
  }

  return {
    cwd: ctx.cwd,
    name: ctx.name,
    base,
    mergeBase: mergeBase || null,
    head: head || null,
    branch: branch || null,
    files,
    additions: files.reduce((sum, f) => sum + (f.additions ?? 0), 0),
    deletions: files.reduce((sum, f) => sum + (f.deletions ?? 0), 0),
    // No merge base, no comparison. Saying so matters more than it looks: without it the answer
    // is an empty file list, which reads as "this task changed nothing" — the one thing a review
    // panel must never say when it simply could not look.
    error: mergeBase
      ? null
      : `Nothing to compare against: "${base || "the base branch"}" was not found in this checkout, so git has no common ancestor to diff from.`,
  }
}

export type PatchLine = {
  kind: "context" | "add" | "del"
  /** Line number on the base side, when the line exists there. */
  old: number | null
  /** Line number on the task's side. */
  new: number | null
  text: string
}

export type PatchHunk = {
  /** `@@ -12,7 +12,9 @@`, kept verbatim. */
  header: string
  /** What git puts after the `@@` — usually the enclosing function. */
  context: string
  lines: PatchLine[]
}

export type FilePatch = {
  path: string
  hunks: PatchHunk[]
  binary: boolean
  /** True when the file was cut at the byte ceiling: the reader is told, never quietly shortened. */
  truncated: boolean
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

/**
 * Parse a unified patch into numbered lines.
 *
 * Done here rather than in the browser for one reason: this is where there are tests. The parser
 * is the part that quietly breaks — a `\ No newline at end of file`, a line that starts with
 * `--` inside a hunk — and a broken one is invisible until someone reviews the wrong code.
 */
export function parsePatch(text: string, opts: { truncated?: boolean } = {}): FilePatch {
  const lines = text.split("\n")
  const hunks: PatchHunk[] = []
  let binary = false
  let current: PatchHunk | null = null
  let oldNumber = 0
  let newNumber = 0
  let path = ""

  for (const line of lines) {
    // Inside a hunk every line is prefixed — ' ', '+', '-' or '\\' — so a header is only a header
    // *between* hunks. This is the trap: a deleted line whose content starts with `--` arrives as
    // `--- foo` and is indistinguishable from a file header on its own. SQL comments and YAML
    // documents hit it constantly, and the symptom is a missing line, which nobody notices.
    if (line.startsWith("diff --git")) {
      current = null
      continue
    }
    if (!current) {
      if (line.startsWith("+++ ")) {
        const target = line.slice(4).trim()
        if (target !== "/dev/null") path = target.replace(/^b\//, "")
        continue
      }
      if (line.startsWith("--- ")) continue
      if (/^(index |old mode|new mode|new file mode|deleted file mode|similarity index|dissimilarity index|rename |copy |index)/.test(line)) {
        continue
      }
    }
    if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) {
      binary = true
      continue
    }
    const header = HUNK_HEADER.exec(line)
    if (header) {
      oldNumber = Number(header[1])
      newNumber = Number(header[3])
      current = { header: line.slice(0, line.indexOf("@@", 2) + 2), context: header[5].trim(), lines: [] }
      hunks.push(current)
      continue
    }
    if (!current) continue
    // A patch ends every line with a marker; the empty string after the final newline is not one.
    if (line === "") continue
    // "\ No newline at end of file" annotates the line above rather than being one.
    if (line.startsWith("\\")) continue
    const marker = line[0]
    const body = line.slice(1)
    if (marker === "+") current.lines.push({ kind: "add", old: null, new: newNumber++, text: body })
    else if (marker === "-") current.lines.push({ kind: "del", old: oldNumber++, new: null, text: body })
    else current.lines.push({ kind: "context", old: oldNumber++, new: newNumber++, text: body })
  }

  return { path, hunks, binary, truncated: opts.truncated ?? false }
}
