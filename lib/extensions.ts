// Pure helpers around VS Code extension identifiers. No I/O — safe to import
// from client components and from zod schemas (see lib/open-vsx.ts for the
// registry client that actually talks to Open VSX).

/**
 * `publisher.extension-name`, the identifier code-server resolves against the
 * registry. Exactly one dot: neither half may contain another one.
 */
export const EXTENSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*\.[A-Za-z0-9][A-Za-z0-9_-]*$/

export const EXTENSION_ID_HINT = "Expected publisher.extension-id (e.g. esbenp.prettier-vscode)"

export function isExtensionId(value: string): boolean {
  return EXTENSION_ID_RE.test(value)
}

/**
 * Prefix the image build prints for every extension code-server could not
 * install. Shared with the UI, which greps the build log for it so a failed
 * install shows up on the project page instead of only in the raw log.
 */
export const EXTENSION_FAILED_MARKER = "[build] EXTENSION FAILED:"

/** Extension ids the given build log reports as failed, in order, deduplicated. */
export function parseFailedExtensions(logs: string): string[] {
  const re = /^\[build\] EXTENSION FAILED: (\S+)/gm
  return [...new Set(Array.from(logs.matchAll(re), (m) => m[1]))]
}

/** Splits a validated id into its two halves; null when the id is malformed. */
export function parseExtensionId(id: string): { namespace: string; name: string } | null {
  if (!isExtensionId(id)) return null
  const dot = id.indexOf(".")
  return { namespace: id.slice(0, dot), name: id.slice(dot + 1) }
}
