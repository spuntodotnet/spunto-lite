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

  test("New workspace spawns on the branch typed in the form", async ({ page, request }) => {
    await page.goto(`/projects/${projectId}`)
    await page.getByRole("button", { name: "New workspace" }).first().click()

    // Named: toasts are role="dialog" too, and one fires on success.
    const dialog = page.getByRole("dialog", { name: "New workspace" })
    await expect(dialog).toBeVisible()
    await dialog.getByLabel("Name").fill("e2e-ui-worker")
    await dialog.getByLabel("Branch").fill("release/1.2")
    await dialog.getByRole("button", { name: "Create" }).click()
    await expect(dialog).toBeHidden()

    // The container spawn needs Docker and may fail in the background; what this
    // asserts is that the form's branch reached the worker row.
    await expect
      .poll(async () => {
        const list = await (await request.get(`/api/projects/${projectId}/workers`)).json()
        return list.find((w: { name: string }) => w.name === "e2e-ui-worker")?.branch
      })
      .toBe("release/1.2")
  })

  test("the empty-state 'New project' CTA is reachable", async ({ page }) => {
    await page.goto("/projects/new")
    await expect(page).toHaveURL(/\/projects\/new$/)
  })

  // A project that has never been built has no log to show, so the build-cache row
  // must stay plain markup. Regression guard on the *absence* of an affordance: the
  // design system turns a target into a <button> as soon as it gets an `onSelect`,
  // and handing it one unconditionally is how this becomes a button that does nothing.
  test("the build-cache row is inert until the project has a build", async ({ page }) => {
    await page.goto(`/projects/${projectId}`)
    await expect(page.getByText("Build cache")).toBeVisible()
    await expect(page.getByText("not built")).toBeVisible()
    await expect(page.getByRole("button", { name: /local · Docker/ })).toHaveCount(0)
  })
})

// The build log used to be reachable only from a workspace page, and only while that
// workspace had no container yet — which is the one moment you aren't looking for it.
// A failed build is the case that matters: the panel is where you find out why.
test.describe("build log from the project panel", () => {
  let projectId: string

  test.beforeEach(async ({ request }) => {
    // A base image no registry can serve: the build fails within seconds, at the pull,
    // without downloading anything. Enough to put a real row in `/builds` to open.
    const res = await request.post("/api/projects", {
      data: { name: `e2e-buildlog-${Date.now()}`, image: "spunto-lite.invalid/no-such-image:0" },
    })
    expect(res.status(), await res.text()).toBe(201)
    projectId = (await res.json()).id
  })

  test.afterEach(async ({ request }) => {
    if (projectId) await request.delete(`/api/projects/${projectId}`)
  })

  test("clicking the build-cache row opens that build's log", async ({ page, request }) => {
    await page.goto(`/projects/${projectId}`)
    await page.getByRole("button", { name: "Pre-build" }).click()

    // Wait for the build to be *over* before opening it, and not merely started.
    // A build still in flight keeps changing its own log, which re-renders the
    // panel for free and hides whether opening it printed anything — this test
    // passed against a panel that only ever filled in because the build was
    // still writing. A finished build's log is fixed, so what you see is exactly
    // what opening the panel put there.
    await expect
      .poll(
        async () => {
          const builds = await (await request.get(`/api/projects/${projectId}/builds`)).json()
          return builds[0]?.state
        },
        { timeout: 60_000 }
      )
      .toBe("error")

    // Reload so the page's own /builds poll *starts* from the finished log. Without
    // this the test only proves the panel fills in eventually: the poll that lands
    // after the panel is open re-renders it either way, which is precisely how a
    // panel that never printed on open still went green here.
    await page.reload()

    const row = page.getByRole("button", { name: /local · Docker/ })
    await expect(row).toBeVisible({ timeout: 15_000 })
    await row.click()

    const panel = page.getByRole("dialog", { name: "Build log" })
    await expect(panel).toBeVisible()
    // The image ref is what ties the log to the image it produced. Matched as a
    // prefix on purpose: what the tag carries past the version is the build
    // recipe's business, not this test's.
    await expect(panel).toContainText(`mp-proj-${projectId}:v1`)

    // The log itself, not just the bar around it. Asserting only the header let a
    // regression through once: the terminal is mounted by the sheet, so printing
    // into it from outside runs before it exists and leaves a panel that is
    // correct in every respect except the one it is for. xterm's DOM renderer
    // puts the characters in the page, one span per cell — hence the loose match
    // on a word rather than on a whole line.
    await expect(panel.locator(".xterm-rows")).toContainText(/ERROR/, { timeout: 15_000 })
  })
})
