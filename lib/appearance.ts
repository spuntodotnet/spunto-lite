import { PALETTES, PALETTE_BY_ID, type Palette } from "@spunto/design-system/palettes"

/**
 * The dashboard colour picked in Settings → Appearance (Spunto Cloud's Account Settings →
 * Appearance, for Lite's one user).
 *
 * Two kinds of colour, both worn on `<html>` so they also reach the dialogs, popovers and menus
 * that portal to `<body>`:
 *
 * - **A product pair**, by colour name — the same seven Spunto Cloud offers (`blue` is Lite's own
 *   ink blue and sky, `amber` is Cloud's graphite and amber…). Worn through `data-product`
 *   (`@spunto/design-system/styles.css`), which moves `--primary`, `--ring`, `--accent`, the
 *   sidebar, `--field`/`--signal`, Build / Ship / Run, the charts and the logo together, light and
 *   dark.
 * - **One of the design system's 50 palettes**, by palette id (`lagoon-amber`…) — worn through
 *   `data-palette` (`palettes.css`, imported after `styles.css` in `app/globals.css`), the same
 *   cascade without a product. `data-product` stays `lite` beside it: the palette block comes later
 *   in the stylesheet at the same specificity, so its colours win, and Lite stays Lite underneath.
 *
 * Stored as that one string in `settings.dashboard_color` (null = Lite's blue); the root layout
 * reads it on the server and writes the attributes into the HTML itself, so a page never paints in
 * the default colour first. A name this release no longer knows reads as the default.
 */
export const PRODUCT_COLORS = [
  { id: "blue", label: "Blue", product: "lite" },
  { id: "amber", label: "Amber", product: "cloud" },
  { id: "violet", label: "Violet", product: "browser" },
  { id: "green", label: "Green", product: "sprout" },
  { id: "teal", label: "Teal", product: "search" },
  { id: "plum", label: "Plum", product: "cms" },
  { id: "graphite", label: "Graphite", product: "ds" },
] as const

/** What Lite wears until its user picks something else: its own pair. */
export const DEFAULT_DASHBOARD_COLOR = "blue"

export { PALETTES, type Palette }

/** Whether a stored / submitted value names a colour this release can draw. */
export function isDashboardColor(value: string): boolean {
  return PRODUCT_COLORS.some((c) => c.id === value) || Object.hasOwn(PALETTE_BY_ID, value)
}

/** The attributes `<html>` wears for a colour. Unknown or missing = Lite's own pair. */
export function dashboardColorAttrs(value: string | null | undefined): { product: string; palette?: string } {
  const pair = PRODUCT_COLORS.find((c) => c.id === value)
  if (pair) return { product: pair.product }
  if (value && Object.hasOwn(PALETTE_BY_ID, value)) return { product: "lite", palette: value }
  return { product: "lite" }
}

/** Puts a colour on the live document — Settings applies a pick before the save comes back. */
export function wearDashboardColor(value: string | null): void {
  const { product, palette } = dashboardColorAttrs(value)
  const html = document.documentElement
  html.dataset.product = product
  if (palette) html.dataset.palette = palette
  else delete html.dataset.palette
}
