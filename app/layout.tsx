import type { Metadata } from "next"
// The design-system now carries its own typefaces (Geist / JetBrains Mono / Young Serif):
// `@font-face` rules ship in styles.css and `<FontPreloads/>` warms the latin
// subset early. No app-side Google Fonts <link> or font-family vars anymore.
import { FontPreloads } from "@spunto/design-system/fonts"
import { Providers } from "./providers"
import "./globals.css"

export const metadata: Metadata = {
  title: "Spunto Lite",
  description: "Local dev-environment control plane",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // `data-product="lite"`: the design system's couple for Spunto Lite — ink blue and sky — from
    // which `--primary`, `--ring`, `--accent` and the sidebar's colours all derive. One universe
    // with Spunto Cloud (background, type, radius, statuses), one colour per product.
    <html lang="en" data-product="lite" suppressHydrationWarning>
      <body className="antialiased">
        <FontPreloads />
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
