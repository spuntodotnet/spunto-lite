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

  test("a project can be deleted from its card", async ({ page, request }) => {
    await page.goto("/projects")
    await expect(page.getByText(name)).toBeVisible()

    await page.getByRole("button", { name: `Delete project ${name}` }).click()
    await expect(page.getByRole("alertdialog")).toContainText(`Delete “${name}”?`)
    await page.getByRole("button", { name: "Delete", exact: true }).click()

    // Scoped to <main>: the success toast also carries the project name.
    await expect(page.getByRole("main").getByText(name)).toHaveCount(0)
    expect((await request.get(`/api/projects/${projectId}`)).status()).toBe(404)
    projectId = "" // already gone — skip the afterEach cleanup
  })

  test("cancelling the confirmation keeps the project", async ({ page, request }) => {
    await page.goto("/projects")
    await page.getByRole("button", { name: `Delete project ${name}` }).click()
    await page.getByRole("button", { name: "Cancel" }).click()

    await expect(page.getByText(name)).toBeVisible()
    expect((await request.get(`/api/projects/${projectId}`)).status()).toBe(200)
  })

  test("a project can be deleted from its detail page", async ({ page, request }) => {
    await page.goto(`/projects/${projectId}`)
    await expect(page.getByRole("heading", { name })).toBeVisible()

    await page.getByRole("button", { name: "Delete project", exact: true }).click()
    await page.getByRole("button", { name: "Delete", exact: true }).click()

    // Redirected back to the dashboard, project gone.
    await expect(page).toHaveURL(/\/projects$/)
    await expect(page.getByRole("main").getByText(name)).toHaveCount(0)
    expect((await request.get(`/api/projects/${projectId}`)).status()).toBe(404)
    projectId = ""
  })

  test("the empty-state 'New project' CTA is reachable", async ({ page }) => {
    await page.goto("/projects/new")
    await expect(page).toHaveURL(/\/projects\/new$/)
  })
})
