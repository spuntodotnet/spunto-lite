import { getCollection, type CollectionEntry } from "astro:content"
import type { Locale } from "./i18n"

export type Doc = CollectionEntry<"docs">

export const GROUPS = ["start", "use", "agents", "operate"] as const

/** `en/projects` → `projects`; the index page is `introduction`, served at /docs. */
export function slugOf(doc: Doc): string {
  return doc.id.split("/").slice(1).join("/")
}

export function hrefOf(locale: Locale, slug: string): string {
  const path = slug === "introduction" ? "/docs" : `/docs/${slug}`
  return locale === "en" ? path : `/fr${path}`
}

/** A language's pages, in reading order: by group, then by `order`. */
export async function docsFor(locale: Locale): Promise<Doc[]> {
  const all = await getCollection("docs", (d) => d.id.startsWith(`${locale}/`))
  return all.sort(
    (a, b) => GROUPS.indexOf(a.data.group) - GROUPS.indexOf(b.data.group) || a.data.order - b.data.order,
  )
}
