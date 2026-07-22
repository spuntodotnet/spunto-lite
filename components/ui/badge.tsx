// Thin wrapper over the shared design-system Badge (kept at this path so the
// app's import sites stay stable). The design system dropped the `muted` and
// `warning` variants in 0.2.x; we re-add them here as className overrides so the
// app's existing badges keep their look without owning a full cva copy.
import type { ComponentProps } from "react"
import { Badge as DsBadge, badgeVariants } from "@spunto/design-system"

const EXTRA_VARIANTS = {
  muted: "border-transparent bg-muted text-muted-foreground",
  warning: "border-transparent bg-amber-500/15 text-amber-600 dark:text-amber-400",
} as const

type ExtraVariant = keyof typeof EXTRA_VARIANTS
type DsBadgeProps = ComponentProps<typeof DsBadge>
type BadgeProps = Omit<DsBadgeProps, "variant"> & { variant?: DsBadgeProps["variant"] | ExtraVariant }

function Badge({ variant, className, ...props }: BadgeProps) {
  if (variant && variant in EXTRA_VARIANTS) {
    // Render on the design-system base styles, then override the accent colors.
    const accent = EXTRA_VARIANTS[variant as ExtraVariant]
    return <DsBadge className={className ? `${accent} ${className}` : accent} {...props} />
  }
  return <DsBadge variant={variant as DsBadgeProps["variant"]} className={className} {...props} />
}

export { Badge, badgeVariants }
