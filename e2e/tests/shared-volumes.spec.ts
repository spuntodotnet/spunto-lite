import { test, expect } from "@playwright/test"
import type { APIRequestContext } from "@playwright/test"

// Project-level shared volumes: the declaration side, over real HTTP. Mounting them in a
// container needs Docker and lives in worker-lifecycle.spec.ts (opt-in); everything here is
// SQLite + validation, so it runs in the fast `api` project.

const IMAGE = "mcr.microsoft.com/devcontainers/typescript-node:20"
const STORE = { name: "pnpm-store", mountPath: "/home/vscode/.local/share/pnpm/store" }

async function createProject(request: APIRequestContext, name: string, overrides: Record<string, unknown> = {}) {
  const res = await request.post("/api/projects", { data: { name, image: IMAGE, ...overrides } })
  expect(res.status(), await res.text()).toBe(201)
  return res.json()
}

test.describe("shared volumes", () => {
  test("declared at creation, versioned, and exported", async ({ request }) => {
    const created = await createProject(request, "e2e-shared-volumes", {
      sharedVolumes: [STORE, { name: "datasets", mountPath: "/data" }],
    })
    try {
      expect(created.sharedVolumes).toEqual([STORE, { name: "datasets", mountPath: "/data" }])

      // Part of the versioned config: the v1 snapshot carries it, so a restore can bring it back.
      const versions = await (await request.get(`/api/projects/${created.id}/versions`)).json()
      expect(versions[versions.length - 1].config.sharedVolumes).toEqual([
        STORE,
        { name: "datasets", mountPath: "/data" },
      ])

      // The declaration travels in an export — there's nothing sensitive in a name + a path.
      const exported = await (await request.get(`/api/projects/${created.id}/export`)).json()
      expect(exported.project.sharedVolumes).toEqual([STORE, { name: "datasets", mountPath: "/data" }])
    } finally {
      await request.delete(`/api/projects/${created.id}`)
    }
  })

  test("a PATCH that doesn't mention them leaves them alone", async ({ request }) => {
    const created = await createProject(request, "e2e-shared-volumes-patch", { sharedVolumes: [STORE] })
    try {
      const untouched = await request.patch(`/api/projects/${created.id}`, { data: { description: "unrelated" } })
      expect((await untouched.json()).sharedVolumes).toEqual([STORE])

      const replaced = await request.patch(`/api/projects/${created.id}`, {
        data: { sharedVolumes: [{ name: "m2", mountPath: "/home/vscode/.m2" }] },
      })
      expect((await replaced.json()).sharedVolumes).toEqual([{ name: "m2", mountPath: "/home/vscode/.m2" }])

      // Emptying the list is a real intent, not "leave unchanged".
      const cleared = await request.patch(`/api/projects/${created.id}`, { data: { sharedVolumes: [] } })
      expect((await cleared.json()).sharedVolumes).toEqual([])
    } finally {
      await request.delete(`/api/projects/${created.id}`)
    }
  })

  test("restoring an older version brings the declaration back", async ({ request }) => {
    const created = await createProject(request, "e2e-shared-volumes-restore", { sharedVolumes: [STORE] })
    try {
      await request.patch(`/api/projects/${created.id}`, { data: { sharedVolumes: [] } })
      expect((await (await request.get(`/api/projects/${created.id}`)).json()).sharedVolumes).toEqual([])

      const restore = await request.post(`/api/projects/${created.id}/versions/1/restore`)
      expect(restore.status(), await restore.text()).toBe(200)
      expect((await restore.json()).sharedVolumes).toEqual([STORE])
    } finally {
      await request.delete(`/api/projects/${created.id}`)
    }
  })

  test("a trailing slash on the mount path is normalized away", async ({ request }) => {
    const created = await createProject(request, "e2e-shared-volumes-normalize", {
      sharedVolumes: [{ name: "cache", mountPath: "/home/vscode/.cache/" }],
    })
    try {
      expect(created.sharedVolumes).toEqual([{ name: "cache", mountPath: "/home/vscode/.cache" }])
    } finally {
      await request.delete(`/api/projects/${created.id}`)
    }
  })

  // A volume mounted on /workspace would shadow the worker's own volume and break the setup
  // script's idempotent clone — including through a trailing slash, which normalization strips
  // *before* the guard runs.
  for (const mountPath of ["/workspace", "/workspace/", "/workspace/node_modules", "/var/lib/docker", "/", "relative/path"]) {
    test(`rejects a shared volume mounted on ${mountPath}`, async ({ request }) => {
      const res = await request.post("/api/projects", {
        data: { name: "e2e-bad-mount", image: IMAGE, sharedVolumes: [{ name: "cache", mountPath }] },
      })
      expect(res.status(), await res.text()).toBe(400)
    })
  }

  test("rejects an invalid name, a duplicate name and two volumes on one path", async ({ request }) => {
    const bad = [
      [{ name: "Pnpm Store", mountPath: "/data" }],
      [STORE, { name: "pnpm-store", mountPath: "/data" }],
      [STORE, { name: "other", mountPath: STORE.mountPath }],
    ]
    for (const sharedVolumes of bad) {
      const res = await request.post("/api/projects", {
        data: { name: "e2e-bad-volumes", image: IMAGE, sharedVolumes },
      })
      expect(res.status(), JSON.stringify(sharedVolumes)).toBe(400)
    }
  })

  test("resources lists volumes with a kind the UI knows", async ({ request }) => {
    const body = await (await request.get("/api/resources")).json()
    for (const v of body.volumes) {
      expect(["workspace", "docker", "containerd", "shared", "other"]).toContain(v.kind)
      if (v.kind === "shared") {
        // A shared volume belongs to a project, never to a single workspace.
        expect(v.workerId).toBeNull()
        expect(v.mountedBy === null || typeof v.mountedBy === "number").toBe(true)
      }
    }
  })
})
