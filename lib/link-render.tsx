import Link from "next/link"
import type { LinkRender } from "@spunto/design-system/tasks"

/** `render.link` for the package's components: their links, drawn as `next/link`. */
export const nextLink: LinkRender = ({ href, className, children }) => (
  <Link href={href} className={className}>
    {children}
  </Link>
)
