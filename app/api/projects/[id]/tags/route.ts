import { z } from "zod"
import { setProjectTags } from "@/services/projects"
import { json, notFound, parseBody } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const MAX_PROJECT_TAGS = 20
const TagsSchema = z.object({ tags: z.array(z.string().max(40)).max(MAX_PROJECT_TAGS) })

/**
 * `{ tags: [...] }` — replaces the project's tags, labels the Projects table is filtered by. Not the
 * project's configuration: no version, no rebuild. Trimmed, a duplicate kept once; case matters (a
 * tag's colour is a hash of its exact name). Answers `{ tags }` as stored.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const parsed = await parseBody(req, TagsSchema)
  if ("response" in parsed) return parsed.response
  const tags = setProjectTags(id, parsed.data.tags)
  return tags ? json({ tags }) : notFound("Project not found")
}
