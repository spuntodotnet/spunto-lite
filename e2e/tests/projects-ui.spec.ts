import { test, expect } from "../helpers/browser"

// Browser test mixing API setup with UI assertion (the same pattern the sibling `spunto`
// project uses): seed a project over HTTP, then assert the dashboard renders it. Driving the
// full multi-step "new project" form is intentionally left out here — it's brittle and better
// covered once the form stabilises; this locks in the list→card render path.
test.describe("projects dashboard", () => {
  let projectId: string
  const name = `e2e-ui-${Date.now()}`

  test.beforeEach(async ({ request }) => {
    const res = await request.post("/api/projects", {
      data: { name, image: "mcr.microsoft.com/devcontainers/typescript-node:20" },
    })
    expect(res.status(), await res.text()).toBe(201)
    projectId = (await res.json()).id
  })

  test.afterEach(async ({ request }) => {
    if (projectId) await request.delete(`/api/projects/${projectId}`)
  })

  test("a created project shows up on /projects", async ({ page }) => {
    await page.goto("/projects")
    // Don't wait for networkidle — the dashboard uses react-query polling that never idles.
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible()
    await expect(page.getByText(name)).toBeVisible()
  })

  test("a project can be deleted from the edit page's danger zone", async ({ page, request }) => {
    await page.goto(`/projects/${projectId}/edit`)
    await expect(page.getByText("Danger zone")).toBeVisible()

    await page.getByRole("button", { name: "Delete project", exact: true }).click()
    await expect(page.getByRole("alertdialog")).toContainText(`Delete “${name}”?`)
    await page.getByRole("button", { name: "Delete", exact: true }).click()

    // Redirected back to the dashboard, project gone. Scoped to <main>: the
    // success toast also carries the project name.
    await expect(page).toHaveURL(/\/projects$/)
    await expect(page.getByRole("main").getByText(name)).toHaveCount(0)
    expect((await request.get(`/api/projects/${projectId}`)).status()).toBe(404)
    projectId = "" // already gone — skip the afterEach cleanup
  })

  test("cancelling the confirmation keeps the project", async ({ page, request }) => {
    await page.goto(`/projects/${projectId}/edit`)
    await page.getByRole("button", { name: "Delete project", exact: true }).click()
    await page.getByRole("button", { name: "Cancel" }).click()

    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/edit$`))
    expect((await request.get(`/api/projects/${projectId}`)).status()).toBe(200)
  })

  test("the dashboard card has no delete shortcut", async ({ page }) => {
    await page.goto("/projects")
    await expect(page.getByText(name)).toBeVisible()
    // Deleting is deliberately confined to the edit page's danger zone.
    await expect(page.getByRole("main").getByRole("button", { name: /delete/i })).toHaveCount(0)
  })

  test("the empty-state 'New project' CTA is reachable", async ({ page }) => {
    await page.goto("/projects/new")
    await expect(page).toHaveURL(/\/projects\/new$/)
  })
})
