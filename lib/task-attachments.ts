/**
 * Files in an agent session's stream — catching the bytes before they reach anything that would
 * clip them (RFC 0022).
 *
 * A conversation with an agent carries files in both directions: a screenshot a tool hands back,
 * a PDF someone drops into a prompt, a CSV the agent read. In a JSON-lines stream they all travel
 * the same way, as a base64 blob inside a content block:
 *
 * ```json
 * {"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KG…"}}
 * {"type":"document","source":{"type":"base64","media_type":"application/pdf","data":"JVBERi0…"}}
 * ```
 *
 * That one block is routinely **megabytes on a single line**, which is exactly the shape the
 * ingestion path is worst at: the normalized payload keeps 8 KiB per field and the retained
 * source line keeps 64 KiB, so before this existed a screenshot arrived as a wall of truncated
 * base64 in the timeline and the file itself was gone. Reading it back was impossible — the bytes
 * were never stored anywhere whole.
 *
 * So the bytes come out **first**, on the raw line, before the adapter ever sees it:
 *
 *  1. `scanFileBlocks` finds every such block in the parsed line, and keeps a handle on it;
 *  2. the caller stores the bytes (`task-attachments.service.ts`) and gets an id back;
 *  3. `referenceAttachment` swaps the blob for that id, in place.
 *
 * What the adapter then parses is a line a few hundred bytes long that says "there was a file
 * here, it is `att_…`", and the event it produces carries `payload.files` — a reference the
 * timeline turns into a thumbnail (or a download row) and one cached fetch.
 *
 * **Why here and not in `@spunto/build/agent-stream`.** The package is pure by charter: no I/O,
 * no storage. A file is bytes that have to be *put somewhere*, and the only participant with
 * somewhere to put them is the platform. What is left for this module is deliberately not dialect
 * knowledge either — it recognises one shape, the base64 content block, wherever it sits in the
 * line, which is what Claude Code emits, what the Anthropic API defines, and the obvious thing
 * for a `jsonl` harness of one's own to write.
 *
 * Pure functions, no database: the ingestion loop is in `task-events.service.ts`.
 */

/**
 * What a browser is allowed to render **inline**, on the dashboard's own origin.
 *
 * This list is not about what may be stored — anything may (see `MAX_FILE_BYTES`) — it is the
 * answer to a different and much sharper question: *what can be handed back with a `Content-Type`
 * that makes a browser execute it?* An `image/svg+xml` or a `text/html` served from the dashboard
 * origin is stored cross-site scripting against everyone in the organization. Four raster formats
 * cannot be anything but pixels, so those render; **everything else downloads** (see the route's
 * `Content-Disposition`), which is the safe default and also the useful one for a PDF or a CSV.
 */
export const INLINE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const
export type InlineMediaType = (typeof INLINE_MEDIA_TYPES)[number]

/** Served when we will not vouch for the bytes — which is every type outside the list above. */
export const DOWNLOAD_MEDIA_TYPE = "application/octet-stream"

/**
 * Per-file ceiling.
 *
 * Not an arbitrary round number: a file has to travel as base64 in the turn's JSON body and then
 * be **written into the worker** for the agent to open it, one `docker exec` per batch of chunks
 * (see `task-attachments.service.ts` § `materialize`). Measured against a real worker, 10 MiB
 * takes about five seconds end to end — which is roughly where sending a file stops feeling like
 * sending a message. It is also, not coincidentally, twice what a model will accept as an image.
 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024

/** How many files one turn may carry — a human's drop as much as a tool's answer. */
export const MAX_FILES_PER_TURN = 10

/** And in total, so ten files at the ceiling is not a 100 MB request. */
export const MAX_TURN_BYTES = 25 * 1024 * 1024

/** Longest stored name. It is shown in a row and used to build a path inside the worker. */
export const MAX_FILENAME_CHARS = 120

/** The reference left in the line where the bytes used to be. */
const ATTACHMENT_KEY = "spunto_attachment"

/** How deep the walk goes. A content block sits two or three levels down; this is a loop guard. */
const MAX_DEPTH = 8

/** The two block types that carry base64 in the Anthropic content-block vocabulary. */
const FILE_BLOCK_TYPES = ["image", "document"] as const

export function isInlineMediaType(value: unknown): value is InlineMediaType {
  return typeof value === "string" && (INLINE_MEDIA_TYPES as readonly string[]).includes(value)
}

/** A file found in a harness line, and the block that held it. */
export type FileSite = {
  /** The content block itself — mutated in place by `referenceAttachment`. */
  block: Record<string, unknown>
  mediaType: string
  /** What the harness called it, when it said — a `document` block often carries a title. */
  filename: string | null
  /** Base64, as the harness wrote it. */
  data: string
  /**
   * The `tool_use_id` of the enclosing `tool_result`, when there is one — which is the common
   * case, since a harness's files come back as tool answers. It is what pairs the file with the
   * `tool.result` event the adapter derives from the same line, rather than with whatever else
   * that line produced.
   */
  callId: string | null
}

/**
 * Worth parsing? A stream is mostly text, and `JSON.parse` on every line of a long session to
 * find the handful that carry a file is a waste the fast path avoids. False positives cost one
 * parse and nothing else; the substring is the one part of the block shape that cannot be spelled
 * differently, since it is a JSON *value*.
 */
export function mayCarryFile(line: string): boolean {
  return line.includes('"base64"')
}

/**
 * Every file block in a parsed harness line, outermost first.
 *
 * Structural, not positional: the walk looks for the block shape anywhere in the line rather than
 * at `message.content[i]`, because the same block appears in an assistant message, in a user
 * message, inside a `tool_result`'s content array, and — for a harness writing our own `jsonl`
 * vocabulary — wherever it felt like putting it. One recogniser covers all of them.
 *
 * A block whose data isn't a string is not a site: it stays in the line untouched and reaches the
 * adapter as it always did. The **media type is not filtered here** — what may be stored and what
 * may be rendered are different questions, and only the second one has an allow-list.
 */
export function scanFileBlocks(json: unknown): FileSite[] {
  const sites: FileSite[] = []
  walk(json, null, 0, sites)
  return sites
}

function walk(node: unknown, callId: string | null, depth: number, out: FileSite[]): void {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES_PER_TURN) return
  if (Array.isArray(node)) {
    for (const item of node) walk(item, callId, depth + 1, out)
    return
  }
  if (!node || typeof node !== "object") return
  const obj = node as Record<string, unknown>

  // A tool result names the call it answers. Carried down so a file nested in its content is
  // attributed to that call and not to the message as a whole.
  const inherited =
    obj.type === "tool_result" && typeof obj.tool_use_id === "string" ? obj.tool_use_id : callId

  const site = fileSiteOf(obj, inherited)
  if (site) {
    out.push(site)
    // No descent into a block we have already claimed: its `data` is the only thing under it, and
    // walking a few megabytes of base64 string is not free.
    return
  }

  for (const value of Object.values(obj)) walk(value, inherited, depth + 1, out)
}

function fileSiteOf(obj: Record<string, unknown>, callId: string | null): FileSite | null {
  if (typeof obj.type !== "string" || !(FILE_BLOCK_TYPES as readonly string[]).includes(obj.type)) return null
  const source = obj.source
  if (!source || typeof source !== "object") return null
  const src = source as Record<string, unknown>
  if (src.type !== "base64") return null
  if (typeof src.media_type !== "string" || !src.media_type) return null
  if (typeof src.data !== "string" || !src.data) return null
  // `title` is what a `document` block calls its name; `filename` is what a home-made `jsonl`
  // harness would most naturally write. Either will do — neither is required.
  const named = typeof obj.title === "string" ? obj.title : typeof obj.filename === "string" ? obj.filename : null
  return { block: obj, mediaType: src.media_type, filename: cleanFilename(named), data: src.data, callId }
}

/**
 * Put the id where the bytes were.
 *
 * The block keeps its `type` and its media type, so a reader of the stored source still sees a
 * content block in the shape the harness used; what it loses is the payload, which now lives in a
 * row of its own. `source` is removed outright rather than blanked: a `data: ""` would be a
 * *malformed* block, and one thing worse than an absent file is a line claiming to hold one.
 */
export function referenceAttachment(site: FileSite, attachmentId: string): void {
  delete site.block.source
  site.block.media_type = site.mediaType
  site.block[ATTACHMENT_KEY] = attachmentId
}

/**
 * A name safe to show, to store, and to build a path out of.
 *
 * Every separator and every traversal segment goes, because this string ends up in a path built
 * by a shell **inside the worker**. It is not the only defence — the file is written under a
 * directory named after its attachment id, and the path is quoted — but a name that cannot
 * express "elsewhere" is the one that needs no defence at all.
 *
 * `null` for anything that survives as empty: a missing name is honest, and the caller falls back
 * to the id.
 */
export function cleanFilename(value: unknown): string | null {
  if (typeof value !== "string") return null
  const base = value
    // Take the last segment, so a browser that sends a path hands over a name.
    .split(/[\\/]/)
    .pop()!
    // Control characters are exactly what is refused (the class holds them as raw bytes).
    .replace(/[ -]/g, "")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, MAX_FILENAME_CHARS)
    .trim()
  return base || null
}

/** Decode what a harness (or a browser) sent, refusing anything past the ceiling. */
export function decodeAttachment(data: string): Buffer | null {
  // `base64` is lenient about whitespace and about a data-url prefix neither party should send
  // but both occasionally do.
  const clean = data.replace(/^data:[^,]*,/, "").replace(/\s+/g, "")
  if (!clean) return null
  // 4 base64 chars per 3 bytes: refuse the string before allocating the buffer, so an oversized
  // upload costs no memory at all.
  if (Math.ceil(clean.length * 3) / 4 > MAX_FILE_BYTES + 1024) return null
  const buf = Buffer.from(clean, "base64")
  if (buf.length === 0 || buf.length > MAX_FILE_BYTES) return null
  return buf
}

/**
 * The name a file is written under in the worker, given what it was called and what it is.
 *
 * An extension matters more here than it looks: it is how the agent's own tools decide what they
 * are opening, so a PDF landing as `att_x` with no suffix is a PDF the harness may not try to
 * read. Taken from the name when it has one, else guessed from the media type, else dropped —
 * never invented.
 */
export function workerFilename(attachmentId: string, filename: string | null, mediaType: string): string {
  const safe = cleanFilename(filename)
  if (safe && /\.[A-Za-z0-9]{1,12}$/.test(safe)) return safe
  const ext = EXTENSIONS[mediaType] ?? mediaType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") ?? ""
  const stem = safe ?? attachmentId
  return ext ? `${stem}.${ext}` : stem
}

/** The handful worth spelling out; everything else falls back to the media type's subtype. */
const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "application/json": "json",
  "application/zip": "zip",
  "application/gzip": "gz",
}
