import { test, expect } from "../helpers/browser"

// Browser test: the Services page — nav entry, empty/populated list, and the form's
// preset prefill. Nothing here starts a container (that needs Docker), so the service
// used as a fixture is created over the API with `start: false`.

test.describe("services page", () => {
  test("is reachable from the sidebar", async ({ page }) => {
    await page.goto("/projects")
    await page.getByRole("link", { name: "Services" }).click()
    await expect(page).toHaveURL(/\/services$/)
    await expect(page.getByRole("heading", { name: "Services" })).toBeVisible()
  })

  test("a preset prefills the new-service form", async ({ page }) => {
    await page.goto("/services")
    await page.getByRole("button", { name: "New service" }).first().click()
    await expect(page.getByRole("heading", { name: "New shared service" })).toBeVisible()

    await page.getByRole("button", { name: "Elasticsearch 8" }).click()
    await expect(page.getByLabel("Slug")).toHaveValue("elasticsearch")
    await expect(page.getByLabel("Image")).toHaveValue(/elasticsearch/)
    await expect(page.getByLabel(/HTTP port/)).toHaveValue("9200")
    // The preset's env vars and volumes land as editable rows, not read-only text.
    await expect(page.getByPlaceholder("POSTGRES_PASSWORD").first()).toHaveValue("discovery.type")
    await expect(page.getByPlaceholder("/usr/share/elasticsearch/data")).toHaveValue(
      "/usr/share/elasticsearch/data",
    )
  })

  test("a declared service is listed with its address and injected variable", async ({ page, request }) => {
    const slug = `e2e-ui-${Date.now()}`
    const created = await (
      await request.post("/api/services", {
        data: { slug, image: "redis:7-alpine", ports: [{ container: 6379 }], start: false },
      })
    ).json()

    try {
      await page.goto("/services")
      await expect(page.getByText(slug, { exact: true })).toBeVisible()
      // The two things a worker needs: the in-cluster address and the injected variable.
      await expect(page.getByText(`${slug}:6379`)).toBeVisible()
      const envVar = `SPUNTO_SVC_${slug.toUpperCase().replace(/-/g, "_")}`
      await expect(page.getByText(envVar)).toBeVisible()
      // Stopped → the primary action is Start. (`.first()`: the host may have other services.)
      await expect(page.getByRole("button", { name: "Start" }).first()).toBeVisible()
    } finally {
      await request.delete(`/api/services/${created.id}`)
    }
  })
})
