// The portable project file: what "Export" downloads and "Import" reads back.
//
// The format is `@spunto/build/spec`, shared with Spunto Cloud — one file you can carry between
// the two, which is what makes "prototype it locally, then move it to the cloud" a feature rather
// than a slide. Files exported by earlier releases announce themselves as `spunto-lite/project`
// and are still accepted on read; new ones always carry the neutral `spunto/project`.
//
// Deliberately excludes anything instance-scoped: id, version history, favorite, the deploy key —
// and **secret values**, which are write-only by design. Only secret *names* travel, so the import
// can lay out the rows to fill in.
//
// Shape here, policy at creation: the schema checks that a file is well-formed, not that every id
// in it is installable. An extension id this accepts but the instance refuses is caught by
// `/api/projects`, which validates its own payload anyway — and a file that a stricter reader
// would have rejected outright is a file the user cannot even see the problem in.

import {
  buildProjectSpec,
  parseProjectSpec,
  projectSpecFilename,
  PROJECT_SPEC_KIND,
  PROJECT_SPEC_VERSION,
  type ProjectSpec,
  type SpecProject,
} from "@spunto/build/spec"

export { buildProjectSpec, PROJECT_SPEC_KIND, PROJECT_SPEC_VERSION }
export type { SpecProject }

/** Kept as the local name for the envelope — the shape is the package's. */
export type ProjectExport = ProjectSpec

/** Download filename for a project's export, e.g. "my-app.spunto-project.json". */
export const projectExportFilename = projectSpecFilename

/**
 * Parses the text of an uploaded file into a validated export.
 * Throws an `Error` whose message is safe to surface in a toast.
 */
export const parseProjectExport = parseProjectSpec

/**
 * sessionStorage handoff for "import from the dashboard": the file is read and
 * validated where it was picked, then the form picks it up after the navigation.
 */
export const PROJECT_IMPORT_HANDOFF_KEY = "spunto-lite:project-import"
