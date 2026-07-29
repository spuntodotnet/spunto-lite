import { test, expect } from "@playwright/test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { APIRequestContext } from "@playwright/test"

// The point of the whole feature, checked against a REAL Docker daemon: a service declared
// once is reachable **by DNS from inside a worker**. Everything else about shared services
// (CRUD, validation, the search index) is covered by the HTTP-only `services.spec.ts`; this
// is the part no amount of API assertions can stand in for.
//
// OPT-IN like `worker-lifecycle.spec.ts`: set E2E_DOCKER=1. It needs a Docker socket *and*
// the `docker` CLI on the runner (to exec inside the worker), and the first spawn of a fresh
// project builds a devcontainer image — minutes.

const RUN = process.env.E2E_DOCKER === "1"
const WORKER_IMAGE = "mcr.microsoft.com/devcontainers/typescript-node:20"
// Tiny, instant to pull, and it speaks HTTP — so `curl` inside the worker is the assertion.
const SERVICE_IMAGE = "nginx:alpine"

const exec = promisify(execFile)

async function poll<T>(fn: () => Promise<T>, until: (v: T) => boolean, timeoutMs: number, everyMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: T
  do {
    last = await fn()
    if (until(last)) return last
    await new Promise((r) => setTimeout(r, everyMs))
  } while (Date.now() < deadline)
  return last
}

const state = async (request: APIRequestContext, path: string): Promise<string> =>
  (await (await request.get(path)).json()).state

/** Runs a command inside the worker's container, straight through the `docker` CLI. */
async function inWorker(workerId: string, script: string): Promise<string> {
  const { stdout } = await exec("docker", ["exec", `mp-worker-${workerId}`, "bash", "-lc", script])
  return stdout.trim()
}

test.describe("a shared service is reachable from a worker (Docker)", () => {
  test.skip(!RUN, "Set E2E_DOCKER=1 to run — needs a real Docker socket and the docker CLI.")

  const slug = `e2e-reach-${Date.now()}`
  let serviceId = ""
  let projectId = ""
  let workerId = ""

  test.afterAll(async ({ request }) => {
    if (workerId) await request.delete(`/api/workers/${workerId}`).catch(() => {})
    if (projectId) await request.delete(`/api/projects/${projectId}`).catch(() => {})
    if (serviceId) await request.delete(`/api/services/${serviceId}`).catch(() => {})
  })

  test("curl http://<slug> works from inside a freshly spawned worker", async ({ request }) => {
    // 1. Declare and start the service. It joins `mp-shared-net` under its slug.
    const created = await request.post("/api/services", {
      data: { slug, image: SERVICE_IMAGE, ports: [{ container: 80 }], httpPort: 80 },
    })
    expect(created.status(), await created.text()).toBe(201)
    serviceId = (await created.json()).id
    const serviceUp = await poll(
      () => state(request, `/api/services/${serviceId}`),
      (s) => s === "ready" || s === "error",
      3 * 60_000,
    )
    expect(serviceUp, "the service should reach ready, not error").toBe("ready")

    // 2. Spawn a worker *after* the service exists, so it gets both the network and the env var.
    const project = await request.post("/api/projects", {
      data: { name: `e2e-reach-${Date.now()}`, image: WORKER_IMAGE },
    })
    expect(project.status(), await project.text()).toBe(201)
    projectId = (await project.json()).id
    const spawn = await request.post(`/api/projects/${projectId}/workers`, { data: {} })
    expect(spawn.status(), await spawn.text()).toBe(201)
    workerId = (await spawn.json()).id
    const workerReady = await poll(
      () => state(request, `/api/workers/${workerId}`),
      (s) => s === "ready" || s === "error",
      9 * 60_000,
    )
    expect(workerReady, "the worker should reach ready, not error").toBe("ready")

    // 3. The discovery variable is in the worker's environment…
    const envVar = `SPUNTO_SVC_${slug.toUpperCase().replace(/-/g, "_")}`
    expect(await inWorker(workerId, `printenv ${envVar}`)).toBe(`http://${slug}:80`)

    // 4. …and the name it points at actually resolves and answers.
    const status = await inWorker(workerId, `curl -s -o /dev/null -w '%{http_code}' "$${envVar}/"`)
    expect(status, `curl $${envVar} from inside the worker`).toBe("200")
  })
})
