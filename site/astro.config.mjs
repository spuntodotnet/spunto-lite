import { defineConfig } from "astro/config"
import react from "@astrojs/react"
import sitemap from "@astrojs/sitemap"
import tailwindcss from "@tailwindcss/vite"

// lite.spunto.net — fully static (`dist/`), published by .github/workflows/site.yml.
// English without a prefix, French under /fr, like spunto.net.
export default defineConfig({
  site: "https://lite.spunto.net",
  trailingSlash: "ignore",
  devToolbar: { enabled: false },
  integrations: [
    react(),
    sitemap({
      i18n: { defaultLocale: "en", locales: { en: "en", fr: "fr" } },
    }),
  ],
  markdown: {
    shikiConfig: { themes: { light: "github-light", dark: "github-dark" } },
  },
  vite: {
    plugins: [tailwindcss()],
    server: { allowedHosts: true },
  },
})
