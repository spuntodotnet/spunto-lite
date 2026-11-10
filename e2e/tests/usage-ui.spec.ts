import { test, expect } from "../helpers/browser"

// Browser test: the Usage page renders and is reachable from the sidebar. What it shows depends on
// the sessions the control plane holds — none on a fresh one — so only the scaffolding is
// asserted: the heading, the period picker, and the period in the URL.
test.describe("usage page", () => {
  test("is reachable from the sidebar and keeps its period in the URL", async ({ page }) => {
    await page.goto("/projects")
    await page.getByRole("link", { name: "Usage" }).click()
    await expect(page).toHaveURL(/\/usage$/)
    await expect(page.getByRole("heading", { name: "Usage" })).toBeVisible()
    const period = page.getByRole("tablist", { name: "Period" })
    await expect(period.getByRole("tab", { name: "30 days" })).toHaveAttribute("aria-selected", "true")

    await period.getByRole("tab", { name: "7 days" }).click()
    await expect(page).toHaveURL(/\/usage\?days=7$/)
    await expect(period.getByRole("tab", { name: "7 days" })).toHaveAttribute("aria-selected", "true")
    // Either the dashboard or its empty state — never stuck loading.
    await expect(page.getByText("Context sent per day").or(page.getByText("No agent activity in this period."))).toBeVisible()
  })
})
