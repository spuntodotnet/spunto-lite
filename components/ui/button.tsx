// Re-export of the shared design-system primitive (kept at this path so the
// app's import sites stay stable). The design system stopped exporting the
// `ButtonProps` type in 0.3.x, so we derive it locally to keep this export.
import type { ComponentProps } from "react"
import { Button, buttonVariants } from "@spunto/design-system"

export type ButtonProps = ComponentProps<typeof Button>
export { Button, buttonVariants }
