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

import { z } from "zod"
import {
  buildProjectSpec,
  parseProjectSpec,
  projectSpecFilename,
  PROJECT_SPEC_KIND,
  PROJECT_SPEC_VERSION,
  type ProjectSpec,
  type SpecProject,
} from "@spunto/build/spec"
import { PortsAttributesSchema, type PortsAttributes } from "./ports"

export { buildProjectSpec, PROJECT_SPEC_KIND, PROJECT_SPEC_VERSION }
export type { SpecProject }

/**
 * Two project fields the shared spec has no room for **yet**, carried beside it under the names
 * Spunto Cloud gives the same columns — `portsAttributes` (a label and a path per port) and
 * `taskReviewParkAfterMinutes` (Park it after N minutes). `@spunto/build/spec` 0.25 has neither,
 * and its parse strips a key it does not know, so a file from Lite keeps them only because Lite
 * writes them at the top of `project` and reads them back itself (`parseProjectExport`). A reader
 * that only knows the spec — Cloud's import today — ignores them, which is the spec's own rule for
 * a product-specific field. Once the spec declares them, this module goes back to re-exporting it.
 */
export type ProjectExtras = {
  portsAttributes?: PortsAttributes
  taskReviewParkAfterMinutes?: number
}

const ExtrasSchema = z.object({
  portsAttributes: PortsAttributesSchema.optional().catch(undefined),
  taskReviewParkAfterMinutes: z.number().int().min(0).max(24 * 60).optional().catch(undefined),
})

/** The envelope — the package's — with the extras above on its project. */
export type ProjectExport = ProjectSpec & { project: ProjectSpec["project"] & ProjectExtras }

/** `buildProjectSpec`, plus the extras. Unset extras are left out, like every unset field. */
export function buildProjectExport(project: SpecProject & ProjectExtras, now?: Date): ProjectExport {
  const { portsAttributes, taskReviewParkAfterMinutes, ...spec } = project
  const built = buildProjectSpec(spec, now)
  return {
    ...built,
    project: {
      ...built.project,
      ...(portsAttributes ? { portsAttributes } : {}),
      ...(taskReviewParkAfterMinutes ? { taskReviewParkAfterMinutes } : {}),
    },
  }
}

/** Download filename for a project's export, e.g. "my-app.spunto-project.json". */
export const projectExportFilename = projectSpecFilename

/**
 * Parses the text of an uploaded file into a validated export.
 * Throws an `Error` whose message is safe to surface in a toast.
 */
export function parseProjectExport(text: string): ProjectExport {
  const spec = parseProjectSpec(text)
  // The text parsed once already: a second JSON.parse cannot throw. An extra that does not hold
  // is dropped rather than failing the file — the spec's own rule for a field the reader can't honour.
  const raw = (JSON.parse(text) as { project?: unknown }).project
  const extras = ExtrasSchema.safeParse(raw ?? {})
  if (!extras.success) return spec
  const { portsAttributes, taskReviewParkAfterMinutes } = extras.data
  return {
    ...spec,
    project: {
      ...spec.project,
      ...(portsAttributes ? { portsAttributes } : {}),
      ...(taskReviewParkAfterMinutes !== undefined ? { taskReviewParkAfterMinutes } : {}),
    },
  }
}

/**
 * sessionStorage handoff for "import from the dashboard": the file is read and
 * validated where it was picked, then the form picks it up after the navigation.
 */
export const PROJECT_IMPORT_HANDOFF_KEY = "spunto-lite:project-import"
