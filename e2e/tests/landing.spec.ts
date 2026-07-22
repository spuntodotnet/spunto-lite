import { test, expect } from "../helpers/browser"

// Browser smoke test: the landing page renders and its nav links reach the main sections.
// Imports `test` from ../helpers/browser (not @playwright/test) so it runs against a locally
// launched Chromium, or browser-remote's Chrome over CDP when CDP_ENDPOINT is set.
test.describe("landing page", () => {
  test("renders the hero and both nav links", async ({ page }) => {
    await page.goto("/")
    await expect(page.getByRole("heading", { name: /Spunto/i })).toBeVisible()
    await expect(page.getByRole("link", { name: /Mes projets/i })).toBeVisible()
    await expect(page.getByRole("link", { name: /Réglages/i })).toBeVisible()
  })

  test("'Mes projets' navigates to the projects page", async ({ page }) => {
    await page.goto("/")
    await page.getByRole("link", { name: /Mes projets/i }).click()
    await expect(page).toHaveURL(/\/projects$/)
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible()
  })

  test("'Réglages' navigates to the settings page", async ({ page }) => {
    await page.goto("/")
    await page.getByRole("link", { name: /Réglages/i }).click()
    await expect(page).toHaveURL(/\/settings$/)
  })
})
