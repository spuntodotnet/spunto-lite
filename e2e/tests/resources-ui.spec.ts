import { test, expect } from "../helpers/browser"

// Browser test: the Resources page renders its dashboard and is reachable from the sidebar.
// The overview polls react-query (never idles) and its numbers depend on the host, so we only
// assert the static scaffolding — heading + the summary tiles + section headers.
test.describe("resources page", () => {
  test("renders the overview dashboard", async ({ page }) => {
    await page.goto("/resources")
    await expect(page.getByRole("heading", { name: "Resources" })).toBeVisible()
    await expect(page.getByText("Running containers")).toBeVisible()
    await expect(page.getByText("CPU in use")).toBeVisible()
    await expect(page.getByText("Memory in use")).toBeVisible()
    await expect(page.getByRole("heading", { name: "Containers" })).toBeVisible()
    await expect(page.getByRole("heading", { name: "Volumes" })).toBeVisible()
  })

  test("is reachable from the sidebar", async ({ page }) => {
    await page.goto("/projects")
    await page.getByRole("link", { name: "Resources" }).click()
    await expect(page).toHaveURL(/\/resources$/)
    await expect(page.getByRole("heading", { name: "Resources" })).toBeVisible()
  })
})
