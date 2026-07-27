import { desc } from "drizzle-orm"
import { db } from "../db/index"
import { projects, workers, projectImageBuilds, projectSecrets, userSecrets } from "../db/schema"
import { TEMPLATES } from "../lib/templates"

// Flat index of everything the ⌘K palette can jump to: projects, workers (the
// nodes), the services they expose, image builds, secret *names*, and the project
// templates.
//
// Two deliberate choices:
//
//  1. **SQLite only, no Docker round-trip.** The palette fetches this every time
//     it opens, so it has to come back in milliseconds. `getResourcesOverview()`
//     inspects every container and reads its stats — right for the Resources
//     dashboard, far too slow here. The trade-off is that a worker's `state` is
//     the stored one, not reconciled against the live container.
//  2. **The whole index, not a query answer.** Matching happens client-side: the
//     design-system palette filters accent- and case-insensitively over each
//     item's label/keywords and highlights the matched slice. A control plane has
//     tens of rows, not millions — shipping the index once beats a debounced
//     round-trip per keystroke.

export type SearchKind = "project" | "worker" | "service" | "build" | "secret" | "template"

export type SearchHit = {
  /** Unique across kinds — used as the palette item's `value`. */
  id: string
  kind: SearchKind
  label: string
  description?: string
  meta?: string
  /** Extra terms the palette matches on but never displays. */
  keywords: string[]
  /** In-app route. Absent on `service` hits, which don't live on this origin. */
  href?: string
  /**
   * A target hosted by the worker itself (code-server, or one of its forwarded
   * ports). Only the browser can turn this into a URL — `workerBaseUrl()` derives
   * the host from `window.location` — so the server hands over the coordinates
   * and the client resolves them.
   */
  target?: { workerId: string; port?: number }
}

export type SearchIndex = { hits: SearchHit[]; generatedAt: string }

/** Builds pile up (one row per image build); the palette only ever wants the recent ones. */
const BUILD_LIMIT = 40

export function getSearchIndex(): SearchIndex {
  // Same order as the dashboard: favourites first, then newest.
  const projectRows = db.select().from(projects).orderBy(desc(projects.favorite), desc(projects.createdAt)).all()
  const workerRows = db.select().from(workers).orderBy(desc(workers.createdAt)).all()
  const buildRows = db
    .select()
    .from(projectImageBuilds)
    .orderBy(desc(projectImageBuilds.createdAt))
    .limit(BUILD_LIMIT)
    .all()
  const projectSecretRows = db
    .select({ id: projectSecrets.id, projectId: projectSecrets.projectId, name: projectSecrets.name })
    .from(projectSecrets)
    .all()
  const userSecretRows = db.select({ id: userSecrets.id, name: userSecrets.name }).from(userSecrets).all()

  const projectById = new Map(projectRows.map((p) => [p.id, p]))
  // FK cascades make an orphan row impossible; the fallback is pure defensiveness.
  const projectName = (id: string) => projectById.get(id)?.name ?? "(deleted project)"

  const hits: SearchHit[] = []

  for (const p of projectRows) {
    hits.push({
      id: `project:${p.id}`,
      kind: "project",
      label: p.name,
      description: p.description ?? p.image,
      meta: `v${p.currentVersion}`,
      href: `/projects/${p.id}`,
      keywords: [
        p.id,
        p.image,
        // Searching a repo slug or a feature id is how you find the project you
        // half-remember: "the one with the postgres feature".
        ...p.repositories.map((r) => r.project),
        ...p.features.map((f) => f.id),
        ...p.forwardPorts.map(String),
        p.favorite ? "favorite" : "",
        p.dind ? "dind docker-in-docker" : "",
      ].filter(Boolean),
    })
  }

  for (const w of workerRows) {
    const project = projectById.get(w.projectId)
    const owner = projectName(w.projectId)

    hits.push({
      id: `worker:${w.id}`,
      kind: "worker",
      label: w.name,
      description: owner,
      meta: w.state,
      href: `/projects/${w.projectId}/workers/${w.id}`,
      keywords: [w.id, owner, w.state, ...w.tags, w.containerId?.slice(0, 12) ?? "", "worker", "node", "container"].filter(
        Boolean,
      ),
    })

    // Services = what a worker actually serves: its code-server, plus every port
    // the project forwards. Only listed for a worker that's up — the proxy has
    // nothing to route to otherwise, so an entry would be a dead link.
    if (w.state !== "ready") continue

    hits.push({
      id: `service:${w.id}:code`,
      kind: "service",
      label: `${w.name} · code-server`,
      description: owner,
      meta: "editor",
      target: { workerId: w.id },
      keywords: [w.id, owner, "code-server", "vscode", "editor", "ide", "service"],
    })
    for (const port of project?.forwardPorts ?? []) {
      hits.push({
        id: `service:${w.id}:${port}`,
        kind: "service",
        label: `${w.name} · :${port}`,
        description: owner,
        meta: `port ${port}`,
        target: { workerId: w.id, port },
        keywords: [w.id, owner, String(port), "port", "service"],
      })
    }
  }

  for (const b of buildRows) {
    const owner = projectName(b.projectId)
    hits.push({
      id: `build:${b.id}`,
      kind: "build",
      label: b.imageRef,
      description: `${owner} · v${b.version}`,
      meta: b.state,
      // Builds are surfaced on the project page, not on a route of their own.
      href: `/projects/${b.projectId}`,
      keywords: [b.projectId, owner, b.state, `v${b.version}`, "build", "image", "deployment"],
    })
  }

  // Names only. A secret's value is write-only — it never leaves the server, and
  // certainly not through a search index.
  for (const s of userSecretRows) {
    hits.push({
      id: `secret:user:${s.id}`,
      kind: "secret",
      label: s.name,
      description: "Global secret",
      href: "/secrets",
      keywords: ["global", "secret", "env", "variable"],
    })
  }
  for (const s of projectSecretRows) {
    const owner = projectName(s.projectId)
    hits.push({
      id: `secret:project:${s.id}`,
      kind: "secret",
      label: s.name,
      description: owner,
      meta: "project",
      href: `/projects/${s.projectId}`,
      keywords: [owner, "secret", "env", "variable"],
    })
  }

  for (const t of TEMPLATES) {
    hits.push({
      id: `template:${t.id}`,
      kind: "template",
      label: t.name,
      description: t.description,
      meta: t.stack,
      href: "/projects/new-from-template",
      keywords: [t.id, t.stack, t.image, ...t.forwardPorts.map(String), "template", "starter"],
    })
  }

  return { hits, generatedAt: new Date().toISOString() }
}
