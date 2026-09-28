import { getAttachment } from "@/services/task-attachments"
import { notFound } from "@/lib/http"
import { DOWNLOAD_MEDIA_TYPE, isInlineMediaType, workerFilename } from "@/lib/task-attachments"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * The bytes behind a `files` entry of a task event. **Only PNG, JPEG, WebP and GIF** are served
 * as themselves; everything else downloads as `application/octet-stream` — serving a
 * caller-supplied `text/html` or `image/svg+xml` from the dashboard's origin would be stored XSS.
 * Immutable: an id never names other bytes.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ taskId: string; attachmentId: string }> }) {
  const { taskId, attachmentId } = await params
  const attachment = getAttachment(taskId, attachmentId)
  if (!attachment) return notFound("Attachment not found")
  const inline = isInlineMediaType(attachment.mediaType)
  const name = workerFilename(attachment.id, attachment.filename, attachment.mediaType)
  return new Response(new Uint8Array(attachment.data), {
    headers: {
      "Content-Type": inline ? attachment.mediaType : DOWNLOAD_MEDIA_TYPE,
      "Content-Length": String(attachment.bytes),
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${name.replace(/["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
    },
  })
}
