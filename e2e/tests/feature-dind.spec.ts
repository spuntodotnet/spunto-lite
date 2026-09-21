import { test, expect } from "@playwright/test"
import type { APIRequestContext } from "@playwright/test"
import { execFileSync } from "node:child_process"

// Repro for: "a project with the `docker-in-docker` feature spawns a worker where `docker`
// doesn't run". The CLI is there, the daemon never is.
//
// The narrower sibling of feature-docker-claude.spec.ts: one feature, no second suspect. It goes
// all the way down to WHY, because the failure is silent by construction — the image build prints
// `registered entrypoint /usr/local/share/docker-init.sh` whether or not the entrypoint was
// actually recorded, so the build log alone reads like a success.
//
// The contract under test, end to end:
//   image build  → the feature's `entrypoint` from devcontainer-feature.json lands in
//                  /etc/mp-feature-entrypoints (buildImageScript's "finalize" block)
//   every start  → buildStartScript runs every line of that file in the background
//   result       → dockerd is up and `vscode` can talk to it
// Break the first link and the other two are no-ops, which is exactly what a user sees as
// "docker doesn't start".
//
// Needs a real Docker daemon AND the `docker` CLI on the runner: OPT-IN via E2E_DOCKER=1.
// Self-skips otherwise. Not run in CI.

const RUN = process.env.E2E_DOCKER === "1"

const ENTRYPOINTS_FILE = "/etc/mp-feature-entrypoints"
const DIND_ENTRYPOINT = "/usr/local/share/docker-init.sh"

function dockerCliAvailable(): boolean {
  try {
    execFileSync("docker", ["version", "--format", "{{.Client.Version}}"], { stdio: "pipe" })
    return true
  } catch {
    return false
  }
}

/** Run a command inside the worker container, returning { code, out }. */
function inContainer(container: string, args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync("docker", ["exec", container, ...args], { stdio: "pipe", encoding: "utf8" })
    return { code: 0, out: out.trim() }
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string }
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}`.toString().trim() }
  }
}

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

async function workerState(request: APIRequestContext, id: string): Promise<string> {
  const res = await request.get(`/api/workers/${id}`)
  expect(res.status()).toBe(200)
  return (await res.json()).state
}

test.describe("feature docker-in-docker: the daemon actually runs", () => {
  test.skip(!RUN, "Set E2E_DOCKER=1 (and have the `docker` CLI) to run — spawns a real worker.")

  let projectId = ""
  let workerId = ""

  test.beforeAll(async ({ request }) => {
    expect(dockerCliAvailable(), "the `docker` CLI must be on PATH to inspect the worker").toBe(true)
    const res = await request.post("/api/projects", {
      data: {
        name: `e2e-dind-${Date.now()}`,
        image: "node:24",
        features: [{ id: "docker-in-docker" }],
      },
    })
    expect(res.status(), await res.text()).toBe(201)
    projectId = (await res.json()).id
  })

  test.afterAll(async ({ request }) => {
    if (workerId) await request.delete(`/api/workers/${workerId}`).catch(() => {})
    if (projectId) await request.delete(`/api/projects/${projectId}`).catch(() => {})
  })

  test("`docker` is usable inside a worker built with the feature", async ({ request }) => {
    const spawn = await request.post(`/api/projects/${projectId}/workers`, { data: {} })
    expect(spawn.status(), await spawn.text()).toBe(201)
    workerId = (await spawn.json()).id
    const container = `mp-worker-${workerId}`

    const state = await poll(
      () => workerState(request, workerId),
      (s) => s === "ready" || s === "error",
      9 * 60_000,
    )
    expect(state, "worker should build + start, not error").toBe("ready")

    // ── What the feature installed: the CLI and its entrypoint script ──
    // These pass even when the bug is present — asserted first so a failure here is read as
    // "the feature install itself broke", a different problem from the one below.
    const cli = inContainer(container, ["bash", "-lc", "command -v docker"])
    expect(cli.code, `docker CLI missing — the feature install failed. out=${cli.out}`).toBe(0)
    const entrypointScript = inContainer(container, ["test", "-x", DIND_ENTRYPOINT])
    expect(entrypointScript.code, `${DIND_ENTRYPOINT} missing — the feature install failed`).toBe(0)

    // ── The link that breaks: the entrypoint has to be *registered* at image-build time ──
    const registered = inContainer(container, ["cat", ENTRYPOINTS_FILE])
    expect(
      registered.code,
      `${ENTRYPOINTS_FILE} does not exist: the image build never recorded the feature's entrypoint, ` +
        `so nothing starts dockerd at boot. out=${registered.out}`,
    ).toBe(0)
    expect(registered.out, `${ENTRYPOINTS_FILE} should list the feature's entrypoint`).toContain(DIND_ENTRYPOINT)

    // ── The consequence a user reports: no daemon ──
    // dockerd is started in the background at boot; give it a moment to come up.
    const info = await poll(
      async () => inContainer(container, ["sh", "-c", "docker info >/dev/null 2>&1; echo $?"]),
      (r) => r.out.endsWith("0"),
      90_000,
    )
    expect(info.out, "docker daemon never became reachable inside the container").toBe("0")

    // And it has to be reachable as `vscode` — the user the terminal lands as, not root.
    const asVscode = inContainer(container, ["su", "vscode", "-c", "docker info >/dev/null 2>&1; echo $?"])
    expect(asVscode.out, "docker daemon not reachable as the `vscode` user").toBe("0")

    await request.delete(`/api/workers/${workerId}`)
    workerId = ""
  })
})
