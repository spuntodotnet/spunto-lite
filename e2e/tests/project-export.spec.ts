import { test, expect } from "@playwright/test"

// Export side of import/export: GET /api/projects/:id/export serves the portable spec as a
// downloadable JSON file. The import side is client-only (the file pre-fills the creation
// form) and is covered by project-import-ui.spec.ts.

const IMAGE = "mcr.microsoft.com/devcontainers/typescript-node:20"

test.describe("project export", () => {
  test("exports a downloadable spec, without secret values", async ({ request }) => {
    const created = await (
      await request.post("/api/projects", {
        data: {
          name: "e2e Export Me",
          description: "exported",
          image: IMAGE,
          dind: true,
          vscodeExtensions: ["dbaeumer.vscode-eslint"],
          prewarmImages: ["node:24"],
          postCreateCommand: "npm ci",
          postStartCommand: "npm run dev",
          forwardPorts: [3000, 8080],
          features: [{ id: "docker-in-docker" }],
          secrets: [{ name: "TOKEN", value: "s3cret" }],
        },
      })
    ).json()

    try {
      const res = await request.get(`/api/projects/${created.id}/export`)
      expect(res.status(), await res.text()).toBe(200)
      expect(res.headers()["content-type"]).toContain("application/json")
      // Slugified name + fixed suffix, so the browser saves a recognisable file.
      expect(res.headers()["content-disposition"]).toBe(
        'attachment; filename="e2e-export-me.spunto-project.json"',
      )

      const body = await res.json()
      expect(body.kind).toBe("spunto-lite/project")
      expect(body.version).toBe(1)
      expect(body.project).toMatchObject({
        name: "e2e Export Me",
        description: "exported",
        image: IMAGE,
        dind: true,
        vscodeExtensions: ["dbaeumer.vscode-eslint"],
        prewarmImages: ["node:24"],
        postCreateCommand: "npm ci",
        postStartCommand: "npm run dev",
        forwardPorts: [3000, 8080],
        secretNames: ["TOKEN"],
      })
      expect(body.project.features.map((f: { id: string }) => f.id)).toEqual(["docker-in-docker"])

      // Instance-scoped and sensitive fields never travel.
      expect(JSON.stringify(body)).not.toContain("s3cret")
      expect(body.project).not.toHaveProperty("id")
      expect(body.project).not.toHaveProperty("secrets")
      expect(body.project).not.toHaveProperty("deployPublicKey")
    } finally {
      await request.delete(`/api/projects/${created.id}`)
    }
  })

  test("an exported spec is accepted back by POST /api/projects", async ({ request }) => {
    const source = await (
      await request.post("/api/projects", {
        data: { name: "e2e-roundtrip", image: IMAGE, forwardPorts: [5173], postCreateCommand: "npm i" },
      })
    ).json()
    const exported = await (await request.get(`/api/projects/${source.id}/export`)).json()

    // What the pre-filled form ends up posting: the spec minus the name-only secrets.
    const { secretNames, ...spec } = exported.project
    expect(secretNames).toEqual([])
    const clone = await request.post("/api/projects", { data: { ...spec, name: "e2e-roundtrip-clone" } })
    expect(clone.status(), await clone.text()).toBe(201)
    const cloned = await clone.json()

    try {
      expect(cloned.image).toBe(IMAGE)
      expect(cloned.forwardPorts).toEqual([5173])
      expect(cloned.postCreateCommand).toBe("npm i")
    } finally {
      await request.delete(`/api/projects/${cloned.id}`)
      await request.delete(`/api/projects/${source.id}`)
    }
  })

  test("exporting a missing project is 404", async ({ request }) => {
    const res = await request.get("/api/projects/does-not-exist/export")
    expect(res.status()).toBe(404)
  })
})
