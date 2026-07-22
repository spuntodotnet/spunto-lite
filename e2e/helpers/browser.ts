import { test as base, chromium, expect } from "@playwright/test"
import type { Browser } from "@playwright/test"

// Custom `test` that, when CDP_ENDPOINT is set, drives an *existing* Chrome over the DevTools
// Protocol instead of launching a bundled browser. In the stack that endpoint is the
// `browser-remote` service (ghcr.io/spuntodotnet/browser-remote): a headless Chrome already on
// the compose network — so the e2e image can stay a plain node image with no ~400MB of
// Playwright browsers, and tests hit the app at its in-network name (http://spunto-lite).
//
// Without CDP_ENDPOINT (e.g. running from the host) it falls back to a locally launched
// Chromium, so `npm test` on a dev machine keeps working unchanged (against http://localhost:PORT).
//
// The built-in `context`/`page` fixtures depend on this `browser`, so overriding it is enough —
// they pick up baseURL / ignoreHTTPSErrors from the config `use` block as usual.
//
// spunto-lite has no auth, so — unlike the sibling `spunto` project — there's no session/JWT
// helper here; tests just create fixtures over the API and drive the open UI.
export const test = base.extend<object, { browser: Browser }>({
  browser: [
    async ({}, use) => {
      const cdp = process.env.CDP_ENDPOINT
      if (!cdp) {
        const browser = await chromium.launch()
        await use(browser)
        await browser.close()
        return
      }

      // `GET /json/version` returns a webSocketDebuggerUrl pointing at 127.0.0.1:9222 — internal
      // to the browser-remote container and unreachable from here. Keep only its path and
      // recompose it against the host we can actually reach.
      const res = await fetch(`${cdp}/json/version`)
      if (!res.ok) throw new Error(`CDP_ENDPOINT ${cdp}/json/version -> ${res.status}`)
      const { webSocketDebuggerUrl } = (await res.json()) as { webSocketDebuggerUrl: string }
      const wsEndpoint = cdp.replace(/^http/, "ws") + new URL(webSocketDebuggerUrl).pathname

      const browser = await chromium.connectOverCDP(wsEndpoint)
      // close() only tears down *our* connection — browser-remote's Chrome keeps running.
      await use(browser)
      await browser.close()
    },
    { scope: "worker" },
  ],

  // Over CDP, Playwright's viewport / deviceScaleFactor emulation is NOT applied to the shared
  // browser (it reports the configured size but the page stays at Chrome's default). Apply the
  // configured metrics explicitly via the DevTools protocol so browser tests render at the
  // project's resolution. No-op when launching locally, where the built-in viewport works.
  page: async ({ page, context, viewport }, use, testInfo) => {
    if (process.env.CDP_ENDPOINT && viewport) {
      const deviceScaleFactor = testInfo.project.use.deviceScaleFactor ?? 1
      const session = await context.newCDPSession(page)
      await session.send("Emulation.setDeviceMetricsOverride", {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor,
        mobile: false,
      })
    }
    await use(page)
  },
})

export { expect }
