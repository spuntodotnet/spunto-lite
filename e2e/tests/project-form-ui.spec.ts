import { test, expect } from "../helpers/browser"

// The project form is `ProjectForm` from `@spunto/design-system/projects`: controlled by one
// `ProjectFormValue`, mapped to Lite's own payload by `lib/project-form-value.ts`. So what these
// tests assert is **what the API ends up storing**, not what the DOM shows — the package owns the
// rendering, this repo owns the payload, and that's the contract that must not drift.
//
// Two things of Lite's don't map onto the package's value: the legacy `gitlab`/`bitbucket`
// providers (carried alongside a repo row) and the shared volumes (a `customSections` card of
// Lite's own). Both are exactly the kind of thing a round-trip test has to pin down.

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
    await page.getByRole("button", { name: "Python 3.12", exact: true }).click()

    // A generic git repo. The branch is the package's own field since 0.15 — Lite
    // no longer draws one under the row.
    await page.getByRole("button", { name: "Add Git URL" }).click()
    await page.getByPlaceholder("git@gitlab.com:group/repo.git").fill("git@gitlab.com:acme/api.git")
    await page.getByLabel("Workspace path").fill("api")
    await page.getByLabel("Branch", { exact: true }).fill("develop")

    // Everything past identity / image / repositories is folded until asked for.
    const advanced = page.getByRole("button", { name: /Advanced options/ })
    await expect(advanced).toHaveAttribute("aria-expanded", "false")
    await advanced.click()

    await page.getByRole("button", { name: "Node.js", exact: true }).click()
    await page.getByLabel("Node.js version").fill("22")

    await page.getByLabel("Extension search").fill("esbenp.prettier-vscode")
    await page.getByLabel("Extension search").press("Enter")

    await page.locator("#post-create").fill("npm ci")
    await page.locator("#post-start").fill("npm run dev")
    // Ports and prewarm images are deliberately not in `sections` — the form has
    // no field for them at all, folded or not.
    await expect(page.locator('input[name="forwardPorts"]')).toHaveCount(0)
    await expect(page.locator('textarea[name="prewarmImages"]')).toHaveCount(0)
    await page.getByRole("switch").click()

    await page.getByLabel("Secret name").fill("TOKEN")
    await page.getByLabel("Secret value").fill("s3cret")
    await page.getByRole("button", { name: "Add secret" }).click()

    // Shared volumes are a section of Lite's own, declared through `customSections`
    // and drawn by the package's chrome inside the fold — so the round trip has to be
    // pinned here too. A row left blank is not a volume and must not reach the API.
    await page.getByRole("button", { name: "Add shared volume" }).click()
    await page.getByLabel("Shared volume 1 name").fill("pnpm-store")
    await page.getByLabel("Shared volume 1 mount path").fill("/home/vscode/.local/share/pnpm/store")
    await page.getByRole("button", { name: "Add shared volume" }).click()

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
      image: "mcr.microsoft.com/devcontainers/python:3.12",
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
    // A generic git repo earns the project a deploy key.
    expect(stored.deployPublicKey).toContain("ssh-")
    expect(await (await request.get(`/api/projects/${id}/secrets`)).json()).toMatchObject([{ name: "TOKEN" }])
  })

  // A section declared through `customSections` is part of the form's chrome, not a card
  // bolted next to it: it reports a summary, so a project whose *only* advanced setting is a
  // shared volume must open the fold on its own rather than hide it. That's the failure the
  // disclosure exists to prevent, and it used to be out of reach for an app's own section.
  test("a project whose only advanced setting is a shared volume opens the fold", async ({ page, request }) => {
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
    await expect(page.getByRole("button", { name: /Advanced options/ })).toHaveAttribute("aria-expanded", "true")
    await expect(page.getByLabel("Shared volume 1 mount path")).toHaveValue("/home/vscode/.local/share/pnpm/store")
    // And it earns its line in the build manifest.
    await expect(page.getByText("volumes", { exact: true })).toBeVisible()
  })

  // The one rule the form can't be allowed to let through: a shared volume on
  // /workspace would shadow each worker's own volume. The check lives server-side
  // (lib/shared-volumes.ts) and the form surfaces its message — this pins that the
  // refusal actually reaches the user instead of a project being created anyway.
  test("a shared volume mounted inside /workspace is refused, and nothing is created", async ({ page, request }) => {
    const name = `e2e-form-guard-${Date.now()}`
    await page.goto("/projects/new")
    await page.locator("#project-name").fill(name)
    await page.getByRole("button", { name: /Advanced options/ }).click()
    await page.getByRole("button", { name: "Add shared volume" }).click()
    await page.getByLabel("Shared volume 1 name").fill("cache")
    await page.getByLabel("Shared volume 1 mount path").fill("/workspace/node_modules")

    await page.getByRole("button", { name: "Create project" }).click()
    // The message lands twice — the manifest's error line and a toast.
    await expect(page.getByText(/is inside \/workspace/).first()).toBeVisible()
    // Still on the form, and the project was never created.
    await expect(page).toHaveURL(/\/projects\/new$/)
    const list = await (await request.get("/api/projects")).json()
    expect(list.map((p: { name: string }) => p.name)).not.toContain(name)
  })

  test("the form fits a phone — no horizontal overflow from 320 to 768 px", async ({ page, context }) => {
    await page.goto("/projects/new")
    // Worst case: every section mounted, including the widest row (a repository).
    await page.getByRole("button", { name: /Advanced options/ }).click()
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
        // nothing. Its children inherit that exemption.
        const decorative = (el: Element) => {
          for (let n: Element | null = el; n && n !== form; n = n.parentElement)
            if (getComputedStyle(n).position === "absolute") return true
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
            // `gitlab` is a provider the design system's repo list doesn't model: it
            // must survive an edit untouched rather than be rewritten to `github`.
            { id: "r-infra", provider: "gitlab", project: "acme/infra", workspacePath: "infra", branch: "main" },
            {
              id: "r-api",
              provider: "git",
              project: "acme/api",
              workspacePath: "api",
              cloneUrl: "git@gitlab.com:acme/api.git",
            },
          ],
        },
      })
    ).json()
    created.push(before.id)

    await page.goto(`/projects/${before.id}/edit`)
    // A fold that hides settings you didn't set yourself is the failure it exists to
    // avoid: with features/lifecycle/ports already filled, it opens on its own.
    await expect(page.getByRole("button", { name: /Advanced options/ })).toHaveAttribute("aria-expanded", "true")
    await expect(page.locator("#post-create")).toHaveValue("go mod download")
    await expect(page.getByLabel("Branch", { exact: true }).first()).toHaveValue("main")
    // This project has ports and prewarmed images, and the form shows neither.
    // They must still come back out of a save untouched — hidden, not dropped.
    await expect(page.locator('input[name="forwardPorts"]')).toHaveCount(0)
    await expect(page.locator('textarea[name="prewarmImages"]')).toHaveCount(0)

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
})
