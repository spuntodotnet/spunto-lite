import type { Metadata } from "next"
import { connection } from "next/server"
// The design-system now carries its own typefaces (Geist / JetBrains Mono / Young Serif):
// `@font-face` rules ship in styles.css and `<FontPreloads/>` warms the latin
// subset early. No app-side Google Fonts <link> or font-family vars anymore.
import { FontPreloads } from "@spunto/design-system/fonts"
import { getSettings } from "@/services/settings"
import { dashboardColorAttrs } from "@/lib/appearance"
import { Providers } from "./providers"
import "./globals.css"

export const metadata: Metadata = {
  title: "Spunto Lite",
  description: "Local dev-environment control plane",
}

/**
 * The colour picked in Settings → Appearance (lib/appearance.ts), read here so the server writes
 * it into the HTML: no inline script, no first paint in the default colour. `connection()` keeps
 * the layout out of `next build`'s prerender — a colour baked in at build time would be whatever
 * the build machine's database said. A database that can't be read leaves Lite in its own colour
 * rather than taking every page down with it.
 */
async function dashboardColor(): Promise<string | null> {
  await connection()
  try {
    return getSettings().dashboardColor
  } catch {
    return null
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { product, palette } = dashboardColorAttrs(await dashboardColor())
  return (
    // `data-product="lite"` by default: the design system's couple for Spunto Lite — ink blue and
    // sky — from which `--primary`, `--ring`, `--accent` and the sidebar's colours all derive. One
    // universe with Spunto Cloud (background, type, radius, statuses), one colour per product.
    // Settings → Appearance can dress it in another pair, or in one of the 50 `data-palette`s.
    <html lang="en" data-product={product} data-palette={palette} suppressHydrationWarning>
      <body className="antialiased">
        <FontPreloads />
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
