import { test, expect } from "@playwright/test"
import type { APIRequestContext } from "@playwright/test"
import { execFileSync } from "node:child_process"

// Repro for the reported bug: a worker on `node:24` with BOTH the `docker-in-docker` and
// `claude-code` features ends up with only one of the two actually usable — either `docker`
// doesn't run, or `claude` isn't found.
//
// This drives the real control plane to spawn the worker, then inspects the resulting container
// the same way a human would from the in-app terminal — via `docker exec` as the `vscode` user,
// across the shell flavours that matter:
//   • login   shell (`zsh -lic`) — sources ~/.zprofile then ~/.zshrc
//   • interactive non-login (`zsh -ic`) — sources ~/.zshrc only (tmux panes, depending on config)
//   • login bash (`bash -lc`) — the baseline that "should" always have everything
// It also checks the Docker daemon is up and that `vscode` can talk to it.
//
// Because it needs a real Docker daemon AND the `docker` CLI on the runner, it's OPT-IN:
// run with E2E_DOCKER=1. Self-skips otherwise. Not run in CI.
//
// The assertions state what SHOULD hold (both tools usable from the terminal shell). When the
// bug is present the failing expectation pinpoints WHICH tool broke and in WHICH shell — that's
// the point: "let's see what it gives".

const RUN = process.env.E2E_DOCKER === "1"

function dockerCliAvailable(): boolean {
  try {
    execFileSync("docker", ["version", "--format", "{{.Client.Version}}"], { stdio: "pipe" })
    return true
  } catch {
    return false
  }
}

/** Run a command inside the worker container as `vscode`, returning { code, out }. */
function inContainer(container: string, shellArgs: string[]): { code: number; out: string } {
  try {
    const out = execFileSync("docker", ["exec", "-u", "vscode", container, ...shellArgs], {
      stdio: "pipe",
      encoding: "utf8",
    })
    return { code: 0, out: out.trim() }
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string }
    const out = `${err.stdout ?? ""}${err.stderr ?? ""}`.toString().trim()
    return { code: err.status ?? 1, out }
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

test.describe("feature conflict: docker-in-docker + claude-code on node:24", () => {
  test.skip(!RUN, "Set E2E_DOCKER=1 (and have the `docker` CLI) to run — spawns a real worker.")

  let projectId: string
  let workerId: string
  let container: string

  test.beforeAll(async ({ request }) => {
    expect(dockerCliAvailable(), "the `docker` CLI must be on PATH to inspect the worker").toBe(true)
    const res = await request.post("/api/projects", {
      data: {
        name: `e2e-dind-claude-${Date.now()}`,
        image: "node:24",
        // The exact combo from the bug report.
        features: [{ id: "docker-in-docker" }, { id: "claude-code" }],
      },
    })
    expect(res.status(), await res.text()).toBe(201)
    projectId = (await res.json()).id
  })

  test.afterAll(async ({ request }) => {
    if (workerId) await request.delete(`/api/workers/${workerId}`).catch(() => {})
    if (projectId) await request.delete(`/api/projects/${projectId}`).catch(() => {})
  })

  test("both `docker` and `claude` are usable from the worker's terminal shell", async ({ request }) => {
    // Spawn → build image (installs both features) → container ready.
    const spawn = await request.post(`/api/projects/${projectId}/workers`, { data: {} })
    expect(spawn.status(), await spawn.text()).toBe(201)
    workerId = (await spawn.json()).id
    container = `mp-worker-${workerId}`

    const state = await poll(
      () => workerState(request, workerId),
      (s) => s === "ready" || s === "error",
      9 * 60_000,
    )
    expect(state, "worker should build + start, not error").toBe("ready")

    // ── Claude: check the binary is reachable across shell flavours ──
    // (`command -v claude` prints the path and exits 0 when found.)
    const claudeLoginZsh = inContainer(container, ["zsh", "-lic", "command -v claude"])
    const claudeInteractiveZsh = inContainer(container, ["zsh", "-ic", "command -v claude"])
    const claudeLoginBash = inContainer(container, ["bash", "-lc", "command -v claude"])
    console.log("[repro] claude — zsh -lic:", JSON.stringify(claudeLoginZsh))
    console.log("[repro] claude — zsh -ic :", JSON.stringify(claudeInteractiveZsh))
    console.log("[repro] claude — bash -lc:", JSON.stringify(claudeLoginBash))

    // ── Docker: daemon up + usable by the vscode user ──
    // dockerd is started in the background at boot; give it a moment to come up.
    const dockerInfo = await poll(
      async () => inContainer(container, ["sh", "-c", "docker info >/dev/null 2>&1; echo $?"]),
      (r) => r.out.endsWith("0"),
      90_000,
    )
    const dockerWhich = inContainer(container, ["zsh", "-lic", "command -v docker"])
    const inDockerGroup = inContainer(container, ["sh", "-c", "id -nG | tr ' ' '\\n' | grep -qx docker; echo $?"])
    console.log("[repro] docker — daemon `docker info` exit:", dockerInfo.out)
    console.log("[repro] docker — command -v docker (zsh -lic):", JSON.stringify(dockerWhich))
    console.log("[repro] docker — vscode in docker group (0=yes):", inDockerGroup.out)

    // ── The bug shows up as one of these failing. We assert the terminal-facing shell (login
    // zsh, what tmux panes use) has claude, and that docker is fully usable. ──
    expect(claudeLoginZsh.code, `claude not on PATH in login zsh (tmux terminal). out=${claudeLoginZsh.out}`).toBe(0)
    expect(dockerInfo.out, "docker daemon never became reachable inside the container").toBe("0")
    expect(dockerWhich.code, `docker CLI not on PATH. out=${dockerWhich.out}`).toBe(0)

    // Clean up the worker now that we've inspected it.
    await request.delete(`/api/workers/${workerId}`)
    workerId = ""
  })
})
