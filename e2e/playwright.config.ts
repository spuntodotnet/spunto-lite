import { defineConfig } from "@playwright/test"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Optionally load the repo-root .env (e.g. DATA_ENCRYPTION_KEY) so a host run matches the
// app it's testing. spunto-lite boots fine with zero config, so this is best-effort.
try {
  process.loadEnvFile(path.resolve(__dirname, "../.env"))
} catch {
  // Already set in the environment (e.g. CI / compose) — fine to skip.
}

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 4 : undefined,
  reporter: "list",
  use: {
    // Both the Node `request` fixture and the browser use this base URL. On a host run it's
    // localhost; inside the compose network (browser-remote/CDP) it's http://spunto-lite so the
    // same URL resolves from the Node runner *and* the browser container. Default port 3900
    // keeps host runs off the app's default :80.
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3900",
    // Harmless over http; lets the browser-remote flow tolerate self-signed certs if ever fronted by TLS.
    ignoreHTTPSErrors: true,
  },
  projects: [
    // Fast HTTP-only API suite — no browser, no Docker. Excludes the browser + worker specs.
    {
      name: "api",
      testIgnore: [/worker-lifecycle\.spec\.ts/, /[\\/]feature-[^\\/]*\.spec\.ts$/, /landing\.spec\.ts/, /projects-ui\.spec\.ts/],
    },
    // Browser suite. Drives Chrome — locally a bundled Chromium, or (with CDP_ENDPOINT set)
    // browser-remote's shared Chrome over CDP. fullyParallel:false keeps each spec on one worker
    // so tests in a file don't open concurrent CDP connections to the single shared browser.
    {
      name: "browser",
      testMatch: [/landing\.spec\.ts/, /projects-ui\.spec\.ts/],
      fullyParallel: false,
      // Desktop UI — test at a realistic laptop resolution rather than the 1280×720 default.
      use: {
        viewport: { width: 1512, height: 982 },
        deviceScaleFactor: 2,
      },
    },
    // Real Docker worker lifecycle (spawn container → ready → stop → delete) and feature-conflict
    // repros (feature-*.spec.ts — e.g. docker-in-docker + claude-code on node:24). Opt-in via
    // E2E_DOCKER=1 (needs a reachable Docker socket + the `docker` CLI on the runner + pulls large
    // images on first run). Self-skips otherwise. Not run in CI.
    {
      name: "worker-lifecycle",
      testMatch: [/worker-lifecycle\.spec\.ts/, /[\\/]feature-[^\\/]*\.spec\.ts$/],
      // First worker of a fresh project builds the image + installs features over the network (minutes).
      timeout: 600_000,
    },
  ],
})
