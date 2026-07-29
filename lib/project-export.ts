// Portable project spec: the JSON exchanged by "Export" (download) and "Import"
// (pre-fills the new-project form). Shared by the server route that builds the
// file and the client that reads it back, so both agree on one shape.
//
// Deliberately excludes anything instance-scoped: id, version history, favorite,
// the deploy key — and **secret values**, which are write-only by design. Only
// secret *names* travel, so the import can lay out the rows to fill in.

import { z } from "zod"
import { ExtensionIdSchema, FeatureInputSchema, RepositorySchema, SharedVolumesSchema } from "./validation"

export const PROJECT_EXPORT_KIND = "spunto-lite/project"
export const PROJECT_EXPORT_VERSION = 1

// Repository ids are per-instance handles: keep them when present, but a
// hand-written file may omit them — one is minted at import time.
const ExportRepositorySchema = RepositorySchema.extend({ id: z.string().optional() })

export const ProjectExportSchema = z.object({
  kind: z.literal(PROJECT_EXPORT_KIND),
  version: z.literal(PROJECT_EXPORT_VERSION),
  exportedAt: z.string().optional(),
  project: z.object({
    name: z.string().min(1),
    description: z.string().nullable().optional(),
    image: z.string().min(1),
    features: z.array(FeatureInputSchema).default([]),
    vscodeExtensions: z.array(ExtensionIdSchema).default([]),
    prewarmImages: z.array(z.string()).default([]),
    dind: z.boolean().default(false),
    postCreateCommand: z.string().nullable().optional(),
    postStartCommand: z.string().nullable().optional(),
    repositories: z.array(ExportRepositorySchema).default([]),
    forwardPorts: z.array(z.number().int().min(1).max(65535)).default([]),
    // The declaration only — a name and a mount path. Unlike a secret's value,
    // there's nothing sensitive in it, and the volume is created on first spawn
    // wherever the spec is imported.
    sharedVolumes: SharedVolumesSchema.default([]),
    // Names only — values never leave the instance.
    secretNames: z.array(z.string()).default([]),
  }),
})

export type ProjectExport = z.infer<typeof ProjectExportSchema>

/** Download filename for a project's export, e.g. "my-app.spunto-project.json". */
export function projectExportFilename(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  return `${slug || "project"}.spunto-project.json`
}

/**
 * Parses the text of an uploaded file into a validated export.
 * Throws an `Error` whose message is safe to surface in a toast.
 */
export function parseProjectExport(text: string): ProjectExport {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error("Not a valid JSON file")
  }
  const parsed = ProjectExportSchema.safeParse(raw)
  if (!parsed.success) {
    const isExport = typeof raw === "object" && raw !== null && "kind" in raw
    throw new Error(
      isExport
        ? `Unsupported project export: ${z.prettifyError(parsed.error).split("\n")[0]}`
        : "Not a spunto-lite project export",
    )
  }
  return parsed.data
}

/**
 * sessionStorage handoff for "import from the dashboard": the file is read and
 * validated where it was picked, then the form picks it up after the navigation.
 */
export const PROJECT_IMPORT_HANDOFF_KEY = "spunto-lite:project-import"
