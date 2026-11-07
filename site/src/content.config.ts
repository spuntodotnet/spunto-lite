import { defineCollection, z } from "astro:content"
import { glob } from "astro/loaders"

// One file per page and per language: `en/<slug>.md` and `fr/<slug>.md` carry
// the same slug, so the language switch lands on the same page.
const docs = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/docs" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    group: z.enum(["start", "use", "agents", "operate"]),
    order: z.number(),
  }),
})

export const collections = { docs }
