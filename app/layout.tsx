import type { Metadata } from "next"
// The design-system now carries its own typefaces (Geist / JetBrains Mono / Syne):
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
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">
        <FontPreloads />
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
