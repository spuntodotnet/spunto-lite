import { test, expect } from "../helpers/browser"
import type { Page } from "@playwright/test"

// Import side of import/export: picking an exported JSON pre-fills the "New project" form.
// Two entry points share one code path (lib/project-export.ts): the button inside the form,
// and the dashboard's "Import" (which validates, then hands the spec over the navigation).

const IMAGE = "mcr.microsoft.com/devcontainers/typescript-node:20"

function jsonFile(payload: unknown) {
  return { name: "spec.spunto-project.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(payload)) }
}

/**
 * The form's fields, after an import — asserted identically from both entry points.
 * Ids and field names are the design system's (`@spunto/design-system/projects`); the
 * base image is a catalog chip rather than a text input, so it's read off the build
 * manifest, which recaps the value the form actually holds.
 */
async function expectPrefilled(page: Page, name: string) {
  await expect(page.locator("#project-name")).toHaveValue(name)
  await expect(page.locator("#project-description")).toHaveValue("imported spec")
  await expect(page.getByRole("main").getByText(IMAGE.split("/").pop()!).first()).toBeVisible()
  await expect(page.locator('input[name="forwardPorts"]')).toHaveValue("3000, 8080")
  await expect(page.locator('textarea[name="prewarmImages"]')).toHaveValue("node:24")
  await expect(page.locator("#post-create")).toHaveValue("npm ci")
  await expect(page.locator("#post-start")).toHaveValue("npm run dev")
  // Secret names travel, values don't. A secret is write-only, so there's no
  // half-filled row to lay out: the banner names the ones to type back in.
  await expect(page.getByText(/Secret values aren.t exported/)).toContainText("TOKEN")
}

test.describe("project import", () => {
  let sourceId: string
  let exported: unknown
  const name = `e2e-import-${Date.now()}`

  test.beforeEach(async ({ request }) => {
    const res = await request.post("/api/projects", {
      data: {
        name,
        description: "imported spec",
        image: IMAGE,
        prewarmImages: ["node:24"],
        postCreateCommand: "npm ci",
        postStartCommand: "npm run dev",
        forwardPorts: [3000, 8080],
        secrets: [{ name: "TOKEN", value: "s3cret" }],
      },
    })
    expect(res.status(), await res.text()).toBe(201)
    sourceId = (await res.json()).id
    exported = await (await request.get(`/api/projects/${sourceId}/export`)).json()
  })

  test.afterEach(async ({ request }) => {
    if (sourceId) await request.delete(`/api/projects/${sourceId}`)
  })

  test("the form's Import button pre-fills every field", async ({ page }) => {
    await page.goto("/projects/new")
    await page.getByLabel("Import project JSON").setInputFiles(jsonFile(exported))

    await expect(page.getByText(/Fields pre-filled from the export of/)).toBeVisible()
    await expectPrefilled(page, name)
  })

  test("the dashboard's Import lands on a pre-filled creation form", async ({ page }) => {
    await page.goto("/projects")
    await page.getByRole("main").getByLabel("Import project JSON").setInputFiles(jsonFile(exported))

    await expect(page).toHaveURL(/\/projects\/new$/)
    await expectPrefilled(page, name)
  })

  test("an imported spec can be created as a new project", async ({ page, request }) => {
    await page.goto("/projects/new")
    await page.getByLabel("Import project JSON").setInputFiles(jsonFile(exported))
    await expect(page.locator("#project-name")).toHaveValue(name)

    const clonedName = `${name}-clone`
    await page.locator("#project-name").fill(clonedName)
    await page.getByRole("button", { name: "Create project" }).click()
    await expect(page).toHaveURL(/\/projects\/[a-z0-9]+$/)

    const created = (await (await request.get("/api/projects")).json()).find(
      (p: { name: string }) => p.name === clonedName,
    )
    expect(created).toBeTruthy()
    try {
      expect(created.image).toBe(IMAGE)
      expect(created.forwardPorts).toEqual([3000, 8080])
      expect(created.postStartCommand).toBe("npm run dev")
      // An export carries secret *names* only, so there's nothing to store.
      expect(await (await request.get(`/api/projects/${created.id}/secrets`)).json()).toEqual([])
    } finally {
      await request.delete(`/api/projects/${created.id}`)
    }
  })

  test("a file that isn't a project export is rejected", async ({ page }) => {
    await page.goto("/projects/new")
    await page.getByLabel("Import project JSON").setInputFiles(jsonFile({ hello: "world" }))

    await expect(page.getByText("Not a spunto-lite project export")).toBeVisible()
    await expect(page.locator("#project-name")).toHaveValue("")
  })
})
