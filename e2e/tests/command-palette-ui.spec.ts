import { test, expect } from "../helpers/browser"

// The ⌘K palette, driven from the keyboard the way a user reaches it. The palette
// is a Base UI Autocomplete inside a Base UI Dialog, so it's found by its dialog
// role + accessible name ("Command palette"), and its items are options.
//
// Control+k rather than Meta+k on purpose: the design-system palette treats ⌘ and
// Ctrl as interchangeable, and Control is the combo that works on the Linux
// Chrome these tests drive.
test.describe("command palette", () => {
  let projectId: string
  const name = `e2e-cmdk-${Date.now()}`

  test.beforeEach(async ({ request }) => {
    const res = await request.post("/api/projects", {
      data: { name, description: "found through the palette", image: "mcr.microsoft.com/devcontainers/typescript-node:20" },
    })
    expect(res.status(), await res.text()).toBe(201)
    projectId = (await res.json()).id
  })

  test.afterEach(async ({ request }) => {
    if (projectId) await request.delete(`/api/projects/${projectId}`)
  })

  const palette = (page: import("@playwright/test").Page) => page.getByRole("dialog", { name: "Command palette" })

  test("the header trigger opens it", async ({ page }) => {
    await page.goto("/projects")
    const trigger = page.getByRole("button", { name: /Search/ })
    await expect(trigger).toBeVisible()
    await trigger.click()
    await expect(palette(page)).toBeVisible()
    await expect(palette(page).getByPlaceholder(/Search projects, workers, services/)).toBeFocused()
  })

  test("mod+k opens it and escape closes it", async ({ page }) => {
    await page.goto("/projects")
    await page.keyboard.press("Control+k")
    await expect(palette(page)).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(palette(page)).toBeHidden()
  })

  test("it finds a project and enter navigates to it", async ({ page }) => {
    await page.goto("/projects")
    await page.keyboard.press("Control+k")

    const option = palette(page).getByRole("option", { name: new RegExp(name) })
    await expect(option).toBeVisible()

    // Typing narrows the list down to the project — the static "Go to" entries drop out.
    await page.keyboard.type(name)
    await expect(option).toBeVisible()
    await expect(palette(page).getByRole("option", { name: /Global secrets/ })).toHaveCount(0)

    // The first match is auto-highlighted, so ↵ alone activates it.
    await page.keyboard.press("Enter")
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`))
    await expect(palette(page)).toBeHidden()
  })

  test("static destinations and actions are searchable", async ({ page }) => {
    await page.goto("/projects")
    await page.keyboard.press("Control+k")

    await page.keyboard.type("resources")
    const resources = palette(page).getByRole("option", { name: /Resources/ })
    await expect(resources).toBeVisible()
    await resources.click()
    await expect(page).toHaveURL(/\/resources$/)

    await page.keyboard.press("Control+k")
    // Keyword match: "scaffold" is never displayed, only indexed.
    await page.keyboard.type("scaffold")
    await expect(palette(page).getByRole("option", { name: /New project from template/ })).toBeVisible()
  })

  test("a query with no match shows the empty state", async ({ page }) => {
    await page.goto("/projects")
    await page.keyboard.press("Control+k")
    await page.keyboard.type("zzzzz-no-such-thing")
    await expect(palette(page).getByText("No results")).toBeVisible()
    await expect(palette(page).getByRole("option")).toHaveCount(0)
  })

  test("reopening starts from an empty query", async ({ page }) => {
    await page.goto("/projects")
    await page.keyboard.press("Control+k")
    await page.keyboard.type(name)
    await page.keyboard.press("Escape")

    await page.keyboard.press("Control+k")
    await expect(palette(page).getByPlaceholder(/Search projects, workers, services/)).toHaveValue("")
    // The full list is back, not just the previous match.
    await expect(palette(page).getByRole("option", { name: /Global secrets/ })).toBeVisible()
  })
})
