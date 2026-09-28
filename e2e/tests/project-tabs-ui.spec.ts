import { test, expect } from "@playwright/test"

// The project page's two tabs (same organisation as Spunto Cloud): Workspaces by default, Tasks
// behind `?tab=tasks`, each with its count, and the primary button following the tab. The task is
// delegated on an unpullable image, so it fails on its way to a machine — which is all a row needs.

test("a project's workspaces and tasks are two tabs, and the tab survives a reload", async ({ page, request }) => {
  const res = await request.post("/api/projects", { data: { name: `e2e-tabs-${Date.now()}`, image: "spunto-lite.invalid/no-such-image:0" } })
  const project = await res.json()
  await request.post(`/api/projects/${project.id}/tasks`, { data: { title: "Tabbed task", prompt: "Anything" } })
  try {
    await page.goto(`/projects/${project.id}`)
    const workspaces = page.getByRole("tab", { name: /Workspaces/ })
    const tasks = page.getByRole("tab", { name: /Tasks/ })
    await expect(workspaces).toHaveAttribute("aria-selected", "true")
    await expect(page.getByRole("button", { name: "New workspace" }).first()).toBeVisible()
    await expect(tasks).toContainText("1")

    await tasks.click()
    await expect(page).toHaveURL(/\?tab=tasks$/)
    await expect(page.getByText("Tabbed task")).toBeVisible()
    await expect(page.getByRole("button", { name: "New task" }).first()).toBeVisible()
    await expect(page.getByRole("button", { name: "New workspace" })).toHaveCount(0)

    await page.reload()
    await expect(page.getByRole("tab", { name: /Tasks/ })).toHaveAttribute("aria-selected", "true")

    await page.getByRole("tab", { name: /Workspaces/ }).click()
    await expect(page).not.toHaveURL(/tab=/)
  } finally {
    await request.delete(`/api/projects/${project.id}`)
  }
})
