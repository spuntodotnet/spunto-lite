import { test, expect } from "../helpers/browser"

// Delegating is the design system's `NewTaskComposer`, as in Spunto Cloud: not a dialog over the
// page but the place the conversation will stream — `/projects/<id>/tasks/new`, or the agent
// cockpit with nothing picked. Delegating replaces that URL with the task's own. The image is
// unpullable: the task fails on its way to a machine, which is all these need.

test.describe("new task composer", () => {
  let projectId: string

  test.beforeEach(async ({ request }) => {
    const res = await request.post("/api/projects", {
      data: { name: `e2e-new-task-${Date.now()}`, image: "spunto-lite.invalid/no-such-image:0", agentAppIds: ["claude", "codex"] },
    })
    expect(res.status(), await res.text()).toBe(201)
    projectId = (await res.json()).id
  })

  test.afterEach(async ({ request }) => {
    if (projectId) await request.delete(`/api/projects/${projectId}`)
  })

  test("New task opens the composer, and delegating opens the task under the harness picked", async ({ page, request }) => {
    await page.goto(`/projects/${projectId}?tab=tasks`)
    await page.getByRole("link", { name: "New task" }).first().click()
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/tasks/new$`))

    // The harness comes first (`placement: "lead"`), and the model chip lists that harness's models.
    const harness = page.getByRole("combobox", { name: "Harness" })
    await expect(harness).toContainText("Claude Code")
    await harness.click()
    await page.getByRole("option", { name: /Codex/ }).click()
    await expect(harness).toContainText("Codex")

    await page.getByPlaceholder(/Describe the work/).fill("Say hello from the composer")
    await page.getByRole("button", { name: /Delegate/ }).click()
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/tasks/(?!new$)[a-z0-9]+$`))

    const taskId = new URL(page.url()).pathname.split("/").pop()!
    const task = await (await request.get(`/api/tasks/${taskId}`)).json()
    // No title asked: it is taken from the prompt.
    expect(task).toMatchObject({ prompt: "Say hello from the composer", agentAppId: "codex", title: "Say hello from the composer" })
  })

  test("the agent cockpit with nothing picked is a new conversation that asks for a project", async ({ page }) => {
    await page.goto("/agents")
    await page.getByRole("button", { name: "Project" }).or(page.getByRole("combobox", { name: "Project" })).click()
    await page.getByRole("option", { name: /e2e-new-task-/ }).first().click()
    await expect(page.getByRole("combobox", { name: "Harness" })).toContainText("Claude Code")
    await page.getByPlaceholder(/Describe the work/).fill("From the cockpit")
    await page.getByRole("button", { name: /Delegate/ }).click()
    // The conversation it started is selected straight away.
    await expect(page).toHaveURL(/\/agents\?task=[a-z0-9]+$/)
  })
})
