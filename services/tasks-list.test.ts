// The cockpit's list (`listAllTasks`): ordered by state first, then by activity, so a page of 40
// holds every task in review before the first finished one — Cloud's `listOrgTasks`. `npm test`.
import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dataDir = mkdtempSync(join(tmpdir(), "lite-tasks-list-test-"))
process.env.DATA_DIR = dataDir
process.env.DB_PATH = join(dataDir, "test.db")

// After the environment: the database opens on first use, at DB_PATH.
const { runMigrations, db } = await import("../db/index")
const { projects, tasks } = await import("../db/schema")
const { listAllTasks } = await import("./tasks")

describe("listAllTasks", () => {
  before(() => {
    runMigrations()
    db.insert(projects).values({ id: "p_list", name: "List", image: "x" }).run()
    // Terminal and in-review states only: a live row would be refreshed from a machine it has not.
    const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000)
    const rows: [string, string, number][] = [
      ["old-review", "in-review", 300],
      ["recent-done", "done", 1],
      ["failed", "failed", 5],
      ["new-review", "in-review", 10],
      ["old-done", "done", 400],
    ]
    for (const [id, state, ago] of rows) {
      db.insert(tasks).values({ id, projectId: "p_list", title: id, prompt: "do it", state, lastActivityAt: minutesAgo(ago), createdAt: minutesAgo(ago) }).run()
    }
  })
  after(() => rmSync(dataDir, { recursive: true, force: true }))

  it("lists by state, then most recently active first", async () => {
    const { tasks: page } = await listAllTasks()
    assert.deepEqual(page.map((t) => t.id), ["new-review", "old-review", "failed", "recent-done", "old-done"])
  })

  it("keeps every task in review on the first page", async () => {
    const { tasks: page } = await listAllTasks({ limit: 2 })
    assert.deepEqual(page.map((t) => t.id), ["new-review", "old-review"])
  })
})
