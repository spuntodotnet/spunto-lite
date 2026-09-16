// Spunto Lite's thin layer over `@spunto/build/extensions` — what the package has no opinion on.
//
// The identifier grammar itself (`isExtensionId`, `parseExtensionId`), the registry error type and
// the failed-extension marker all live in the package, shared with Spunto Cloud: an id the picker
// accepts has to be an id the image build can install, and that is exactly the kind of agreement
// that stops holding the moment each side keeps its own copy.
//
// What stays here is the wording shown to a human and the zod-facing shape, neither of which is a
// protocol.

export { isExtensionId, parseExtensionId, RegistryError } from "@spunto/build/extensions"
export type { ExtensionSuggestion } from "@spunto/build/extensions"

// The build log marker for an extension code-server could not install, and its parser. The image
// build prints it (the generator is in the package too), the project page greps for it — so a
// failed install shows up in the UI instead of only in the raw log.
export { EXTENSION_FAILED_MARKER, parseFailedExtensions } from "@spunto/build/steps"

/** Shown next to a rejected id, in the form and in API errors. */
export const EXTENSION_ID_HINT = "Expected publisher.extension-id (e.g. esbenp.prettier-vscode)"
