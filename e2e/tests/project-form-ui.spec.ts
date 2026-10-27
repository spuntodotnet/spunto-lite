import type { Page } from "@playwright/test"
import { test, expect } from "../helpers/browser"

// The project form is `ProjectForm` from `@spunto/design-system/projects`: controlled by one
// `ProjectFormValue`, mapped to Lite's own payload by `lib/project-form-value.ts`. So what these
// tests assert is **what the API ends up storing**, not what the DOM shows — the package owns the
// rendering, this repo owns the payload, and that's the contract that must not drift.
//
// Two things of Lite's don't map onto the package's value: the legacy `gitlab`/`bitbucket`
// providers (carried alongside a repo row) and the shared volumes (a `customSections` card of
// Lite's own). Both are exactly the kind of thing a round-trip test has to pin down.
//
// The form is laid out as the dashboard's (`layout="sidebar"`): a rail of pages, one shown at a
// time — General, Tooling, Lifecycle, Runtime (docker-in-docker + shared volumes), Secrets.

/** Opens a page of the form from its rail. */
async function openPage(page: Page, title: string) {
  await page.getByRole("navigation", { name: "Form sections" }).getByRole("button", { name: new RegExp(`^${title}`) }).click()
}

test.describe("project form → stored project", () => {
  const created: string[] = []

  test.afterEach(async ({ request }) => {
    while (created.length) await request.delete(`/api/projects/${created.pop()}`)
  })

  test("creating a project stores every section of the form", async ({ page, request }) => {
    const name = `e2e-form-${Date.now()}`
    await page.goto("/projects/new")

    await page.locator("#project-name").fill(name)
    await page.locator("#project-description").fill("driven by playwright")

    // The base image is a catalog chip, not a text field.
    await page.getByRole("button", { name: /^Python 3\./ }).click()

    // A generic git repo. The branch is the package's own field since 0.15 — Lite
    // no longer draws one under the row.
    await page.getByRole("button", { name: "Add Git URL" }).click()
    await page.getByPlaceholder("git@gitlab.com:group/repo.git").fill("git@gitlab.com:acme/api.git")
    await page.getByLabel("Workspace path").fill("api")
    await page.getByLabel("Branch", { exact: true }).fill("develop")

    // Everything past identity / image / repositories is on pages of its own.
    await expect(page.locator("#post-create")).toBeHidden()
    await openPage(page, "Tooling")

    await page.getByRole("button", { name: "Node.js", exact: true }).click()
    await page.getByLabel("Node.js version").fill("22")

    await page.getByLabel("Extension search").fill("esbenp.prettier-vscode")
    await page.getByLabel("Extension search").press("Enter")

    await openPage(page, "Lifecycle")
    await page.locator("#post-create").fill("npm ci")
    await page.locator("#post-start").fill("npm run dev")
    // Ports and prewarm images are deliberately not in `sections` — the form has
    // no field for them at all, on any page.
    await expect(page.locator('input[name="forwardPorts"]')).toHaveCount(0)
    await expect(page.locator('textarea[name="prewarmImages"]')).toHaveCount(0)
    await openPage(page, "Runtime")
    await page.getByRole("switch").click()

    // Shared volumes are a section of Lite's own, declared through `customSections`
    // and drawn by the package's chrome on the Runtime page — so the round trip has to
    // be pinned here too. A row left blank is not a volume and must not reach the API.
    await page.getByRole("button", { name: "Add shared volume" }).click()
    await page.getByLabel("Shared volume 1 name").fill("pnpm-store")
    await page.getByLabel("Shared volume 1 mount path").fill("/home/vscode/.local/share/pnpm/store")
    await page.getByRole("button", { name: "Add shared volume" }).click()
    // The blank row is on screen but isn't a volume: the rail's recap counts one, not two.
    await expect(page.getByRole("navigation", { name: "Form sections" })).toContainText("1 shared volume")

    await openPage(page, "Secrets")
    await page.getByLabel("Secret name").fill("TOKEN")
    await page.getByLabel("Secret value").fill("s3cret")
    await page.getByRole("button", { name: "Add secret" }).click()

    await page.getByRole("button", { name: "Create project" }).click()
    // Not just `/projects/<something>`: `/projects/new` matches that too, and the
    // assertion would pass without the form ever having been submitted.
    await expect(page).toHaveURL(/\/projects\/(?!new$)[a-z0-9]+$/)

    const id = new URL(page.url()).pathname.split("/").pop()!
    created.push(id)
    const stored = await (await request.get(`/api/projects/${id}`)).json()

    expect(stored).toMatchObject({
      name,
      description: "driven by playwright",
      image: expect.stringMatching(/^mcr\.microsoft\.com\/devcontainers\/python:3\./),
      vscodeExtensions: ["esbenp.prettier-vscode"],
      dind: true,
      postCreateCommand: "npm ci",
      postStartCommand: "npm run dev",
      // Nothing to type them in, so nothing is stored.
      forwardPorts: [],
      prewarmImages: [],
      sharedVolumes: [{ name: "pnpm-store", mountPath: "/home/vscode/.local/share/pnpm/store" }],
    })
    // The feature carries the version typed in the form; its OCI ref is resolved server-side.
    expect(stored.features).toEqual([
      { id: "node", ociRef: "ghcr.io/devcontainers/features/node:1", options: { version: "22" } },
    ])
    expect(stored.repositories).toEqual([
      {
        id: expect.any(String),
        provider: "git",
        project: "acme/api",
        workspacePath: "api",
        cloneUrl: "git@gitlab.com:acme/api.git",
        branch: "develop",
      },
    ])
    expect(await (await request.get(`/api/projects/${id}/secrets`)).json()).toMatchObject([{ name: "TOKEN" }])
  })

  // A section declared through `customSections` is part of the form's chrome, not a card
  // bolted next to it: it reports a summary, so the rail says the Runtime page holds a shared
  // volume without anyone having to open it.
  test("a project's shared volumes are recapped in the rail, and on the Runtime page", async ({ page, request }) => {
    const project = await (
      await request.post("/api/projects", {
        data: {
          name: `e2e-fold-${Date.now()}`,
          image: "mcr.microsoft.com/devcontainers/go:1.21",
          sharedVolumes: [{ name: "pnpm-store", mountPath: "/home/vscode/.local/share/pnpm/store" }],
        },
      })
    ).json()
    created.push(project.id)

    await page.goto(`/projects/${project.id}/edit`)
    await expect(page.getByRole("navigation", { name: "Form sections" }).getByRole("button", { name: /^Runtime/ })).toContainText(
      "1 shared volume",
    )
    await openPage(page, "Runtime")
    await expect(page.getByLabel("Shared volume 1 mount path")).toHaveValue("/home/vscode/.local/share/pnpm/store")
  })

  // The one rule the form can't be allowed to let through: a shared volume on
  // /workspace would shadow each worker's own volume. The check lives server-side
  // (lib/shared-volumes.ts) and the form surfaces its message — this pins that the
  // refusal actually reaches the user instead of a project being created anyway.
  test("a shared volume mounted inside /workspace is refused, and nothing is created", async ({ page, request }) => {
    const name = `e2e-form-guard-${Date.now()}`
    await page.goto("/projects/new")
    await page.locator("#project-name").fill(name)
    await openPage(page, "Runtime")
    await page.getByRole("button", { name: "Add shared volume" }).click()
    await page.getByLabel("Shared volume 1 name").fill("cache")
    await page.getByLabel("Shared volume 1 mount path").fill("/workspace/node_modules")

    await page.getByRole("button", { name: "Create project" }).click()
    // The message lands twice — the error line under the rail and a toast.
    await expect(page.getByText(/is inside \/workspace/).first()).toBeVisible()
    // Still on the form, and the project was never created.
    await expect(page).toHaveURL(/\/projects\/new$/)
    const list = await (await request.get("/api/projects")).json()
    expect(list.map((p: { name: string }) => p.name)).not.toContain(name)
  })

  test("the form fits a phone — no horizontal overflow from 320 to 768 px", async ({ page, context }) => {
    await page.goto("/projects/new")
    // Every page stays mounted (the others hidden); the one shown holds the widest row (a repository).
    await page.getByRole("button", { name: "Add Git URL" }).click()

    // Metrics over CDP rather than `setViewportSize`, so this works both on a locally
    // launched Chromium and against browser-remote's shared one.
    const session = await context.newCDPSession(page)
    const setWidth = async (width: number) => {
      await session.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false })
      return page.evaluate(() => {
        const form = document.querySelector('[data-slot="project-form"]')!
        const box = form.getBoundingClientRect()
        // Anything absolutely positioned is decoration (the sections' watermark):
        // it's meant to spill and is clipped by `overflow-hidden`, so it scrolls
        // nothing. So is whatever sits in a horizontal scroller — on a narrow form the
        // rail of pages is a strip that scrolls on its own (bleeding its 4px focus
        // gutter), which scrolls nothing else either. Children inherit the exemption.
        const decorative = (el: Element) => {
          for (let n: Element | null = el; n && n !== form; n = n.parentElement) {
            const style = getComputedStyle(n)
            if (style.position === "absolute" || style.overflowX === "auto" || style.overflowX === "scroll") return true
          }
          return false
        }
        let worst = 0
        for (const el of form.querySelectorAll("*")) {
          const r = el.getBoundingClientRect()
          if (!r.width || decorative(el)) continue
          worst = Math.max(worst, r.right - box.right, box.left - r.left)
        }
        return { formWidth: Math.round(box.width), overflow: Math.round(worst) }
      })
    }

    // The width that matters is the *form's*, not the window's — Lite's app shell
    // has a fixed 224px sidebar and a padded page, and it's already what pushes
    // every screen past a 320px window (true of /projects, which has no form on
    // it at all). So the chrome is measured once and added back, and each pass
    // then really does hand the form 320…768 px.
    const { formWidth: reference } = await setWidth(1200)
    const chrome = 1200 - reference

    try {
      for (const width of [320, 375, 414, 640, 768]) {
        const { formWidth, overflow } = await setWidth(width + chrome)
        expect(formWidth, "form width under test").toBe(width)
        // The container-query claim: the form reads its own width, so nothing
        // inside it ever sticks out of it.
        expect(overflow, `the form overflows its own width at ${width}px`).toBeLessThanOrEqual(1)
      }
    } finally {
      await session.send("Emulation.clearDeviceMetricsOverride")
    }
  })

  test("editing a project rewrites nothing but what was edited", async ({ page, request }) => {
    const name = `e2e-edit-${Date.now()}`
    const before = await (
      await request.post("/api/projects", {
        data: {
          name,
          description: "before",
          image: "mcr.microsoft.com/devcontainers/go:1.21",
          // One feature with no options, one with a version — both round-trip.
          features: [{ id: "docker-in-docker" }, { id: "python", options: { version: "3.11" } }],
          vscodeExtensions: ["golang.go"],
          prewarmImages: ["traefik:v3", "node:24"],
          dind: true,
          postCreateCommand: "go mod download",
          postStartCommand: "go run .",
          forwardPorts: [8080],
          repositories: [
            // Two rows, so an edit that touches neither has to give both back untouched —
            // the form drawing one row and dropping the other is the regression this pins.
            {
              id: "r-infra",
              provider: "git",
              project: "acme/infra",
              workspacePath: "infra",
              cloneUrl: "git@example.com:acme/infra.git",
              branch: "main",
            },
            {
              id: "r-api",
              provider: "git",
              project: "acme/api",
              workspacePath: "api",
              cloneUrl: "git@example.org:acme/api.git",
            },
          ],
        },
      })
    ).json()
    created.push(before.id)

    await page.goto(`/projects/${before.id}/edit`)
    // Settings you didn't set yourself are said in the rail before any page is opened.
    await expect(page.getByRole("navigation", { name: "Form sections" }).getByRole("button", { name: /^Lifecycle/ })).not.toContainText(
      "nothing set",
    )
    await expect(page.getByLabel("Branch", { exact: true }).first()).toHaveValue("main")
    await openPage(page, "Lifecycle")
    await expect(page.locator("#post-create")).toHaveValue("go mod download")
    // This project has ports and prewarmed images, and the form shows neither.
    // They must still come back out of a save untouched — hidden, not dropped.
    await expect(page.locator('input[name="forwardPorts"]')).toHaveCount(0)
    await expect(page.locator('textarea[name="prewarmImages"]')).toHaveCount(0)

    await openPage(page, "General")
    await page.locator("#project-name").fill(`${name}-renamed`)
    await page.getByRole("button", { name: "Save changes" }).click()
    await expect(page).toHaveURL(new RegExp(`/projects/${before.id}$`))

    const after = await (await request.get(`/api/projects/${before.id}`)).json()
    expect(after.name).toBe(`${name}-renamed`)
    // Everything the form didn't touch is stored exactly as it was — the whole point
    // of the mapping in lib/project-form-value.ts.
    for (const key of [
      "description",
      "image",
      "features",
      "vscodeExtensions",
      "prewarmImages",
      "dind",
      "postCreateCommand",
      "postStartCommand",
      "forwardPorts",
      "repositories",
    ] as const) {
      expect(after[key], `${key} should be unchanged`).toEqual(before[key])
    }
    expect(after.currentVersion).toBe(before.currentVersion + 1)
  })

  // Spunto Cloud's pages, so nobody gets lost going from one to the other — with Lite's Runtime
  // kept for docker-in-docker and its shared volumes.
  test("the rail has Cloud's pages, Agents among them", async ({ page }) => {
    await page.goto("/projects/new")
    const entries = await page.getByRole("navigation", { name: "Form sections" }).getByRole("button").allTextContents()
    const pages = ["General", "Tooling", "Lifecycle", "Runtime", "Agents", "Secrets"]
    // Then the submit block, which sits under the rail.
    expect(entries.slice(pages.length)).toEqual(["Create project", "Cancel"])
    pages.forEach((title, i) => expect(entries[i].startsWith(title), `${entries[i]} should be ${title}`).toBe(true))
  })

  // Delegated work is a section of the form now, saved with it — no second Save button.
  test("the Agents page edits how tasks run, and a saved secret can be removed", async ({ page, request }) => {
    const project = await (
      await request.post("/api/projects", {
        data: {
          name: `e2e-agents-${Date.now()}`,
          image: "mcr.microsoft.com/devcontainers/go:1.21",
          secrets: [{ name: "OLD_TOKEN", value: "x" }],
        },
      })
    ).json()
    created.push(project.id)

    await page.goto(`/projects/${project.id}/edit`)
    await expect(page.getByRole("navigation", { name: "Form sections" }).getByRole("button", { name: /^Agents/ })).toContainText("Claude Code")
    await openPage(page, "Agents")
    await page.getByRole("button", { name: "Codex" }).click()
    await page.getByPlaceholder("Run `npm test` before pushing.").fill("Run go test ./...")
    await page.getByText("Stop it").click()

    await openPage(page, "Secrets")
    await page.getByRole("button", { name: "Remove OLD_TOKEN" }).click()

    await page.getByRole("button", { name: "Save changes" }).click()
    await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`))

    const stored = await (await request.get(`/api/projects/${project.id}`)).json()
    expect(stored).toMatchObject({
      agentAppIds: ["claude", "codex"],
      taskAgentInstructions: "Run go test ./...",
      taskReviewMode: "stop",
    })
    expect(await (await request.get(`/api/projects/${project.id}/secrets`)).json()).toEqual([])
  })
})
