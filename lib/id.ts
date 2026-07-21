import { customAlphabet } from "nanoid"

// Lowercase-alphanumeric only: safe to embed in DNS labels (worker-<id>.localhost)
// with no hyphens, so a trailing `-<port>` segment stays unambiguous.
const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"

export const newId = customAlphabet(alphabet, 12)
export const newShortId = customAlphabet(alphabet, 8)
