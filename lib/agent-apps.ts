import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { AGENT_CATALOGS, AGENT_HARNESSES, agentFeature, type AgentHarness, type AgentHarnessId } from "@spunto/agent-runners"
import { OPTIONS_ENV, QUESTIONS_ENV, RUNNER_ENV, agentOptionsError, runnerCommand, type AgentCatalog } from "@spunto/build/agent-contract"
import { AGENT_PROTOCOLS, type AgentProtocol } from "@spunto/build/agent-stream"
import { AGENT_RUNNERS_DIR } from "./env"

/**
 * Agent apps (RFC 0048 of coderhammer/spunto, docs/taches.md): a project says which harnesses its
 * tasks may run under (`projects.agentAppIds`, the first being the default), and **each task picks
 * one** (`tasks.agentAppId`). That is the whole harness configuration — no command to write.
 *
 * Two things follow from it, both resolved here so that no other module branches on an app id:
 *
 *  - **the image**: every allowed app's feature joins the project's own (`effectiveFeatures`), so
 *    the same worker can run a task under one harness and the next under another. The list is
 *    part of the version: changing it rebuilds, like editing a feature does;
 *  - **the session**: `taskHarness` says how a task's next session is started and continued — its
 *    app's runner, which speaks the Spunto agent contract (`agent-v1`, docs/agent-contract.md of
 *    coderhammer/spunto) whatever the app. `protocolOf` says how the *current* session is read: the
 *    dialect it started on, kept on the task (`tasks.session_protocol`).
 *
 * Same module as Cloud's `agent-apps.ts`, minus installations: Lite has no organization to
 * authorise an app, so every builtin is always offered. And Lite is its own agent app too: where
 * Cloud reads the feature and the runner off an app's manifest, Lite takes them straight from
 * `@spunto/agent-runners` — the package Cloud's apps serve them from. `@spunto/build`, the
 * platform side, carries no harness.
 */

export type AgentApp = {
  id: AgentHarnessId
  name: string
  description: string
  /** Secret names the runner's SDK reads — any one of them is enough. */
  credentials: string[]
}

/** Same names, descriptions and credentials as Cloud's `BUILTIN_APPS`. */
export const AGENT_APPS: AgentApp[] = [
  {
    id: "claude",
    name: "Claude Code",
    description: "Run your tasks with Claude, through the official Agent SDK — live, answerable, interruptible.",
    credentials: ["ANTHROPIC_API_KEY"],
  },
  {
    id: "codex",
    name: "Codex",
    description: "Run your tasks with OpenAI's Codex, through the official Codex SDK.",
    credentials: ["OPENAI_API_KEY", "CODEX_API_KEY"],
  },
  // No Node SDK: the feature installs Vibe itself (with a Python of its own, through uv), and the
  // runner speaks ACP to `vibe-acp` (Cloud 1d00235a).
  {
    id: "mistral",
    name: "Mistral Vibe",
    description: "Run your tasks with Mistral Vibe, Mistral's coding agent — live, answerable, interruptible.",
    credentials: ["MISTRAL_API_KEY"],
  },
]

export function getAgentApp(id: string | null | undefined): AgentApp | null {
  if (!id) return null
  return AGENT_APPS.find((a) => a.id === id) ?? null
}

export function harnessOf(app: AgentApp): AgentHarness {
  return AGENT_HARNESSES[app.id]
}

/** The app's catalog — the models a task may run, and the app's own parameters. */
export function agentCatalog(app: AgentApp): AgentCatalog {
  return AGENT_CATALOGS[app.id]
}

/** `GET /api/agent-apps`: each app with its catalog — what the forms and the composer offer. */
export function listAgentApps() {
  return AGENT_APPS.map((app) => ({ ...app, catalog: agentCatalog(app) }))
}

export class AgentAppChoiceError extends Error {}

/** Why a project's harness list cannot be saved, or null. */
export function agentAppIdsError(ids: string[]): string | null {
  const unknown = ids.find((id) => !getAgentApp(id))
  if (unknown) return `"${unknown}" is not an agent app — one of ${AGENT_APPS.map((a) => a.id).join(", ")}.`
  if (new Set(ids).size !== ids.length) return "An agent app is listed twice."
  return null
}

/**
 * A project's default models (`taskAgentModels`), checked against the apps it allows — or why they
 * cannot be saved. A model per app because a model id only means something to its own harness.
 */
export function projectModelsError(agentAppIds: string[], models: Record<string, string>): string | null {
  for (const [appId, model] of Object.entries(models)) {
    const app = getAgentApp(appId)
    if (!app || !agentAppIds.includes(appId)) {
      return `taskAgentModels names "${appId}", which is not one of this project's agent apps (${agentAppIds.join(", ") || "none"}).`
    }
    const catalog = agentCatalog(app)
    if (!catalog.models.some((m) => m.value === model)) {
      return `"${model}" is not a model of ${app.name} — one of ${catalog.models.map((m) => m.value).join(", ")}.`
    }
  }
  return null
}

/**
 * A task's parameters, checked against its app's catalog and model — or a reason they cannot run.
 * Empty values are dropped: unset means "the harness's own default".
 */
export function resolveAgentOptions(appId: string | null, model: string | null, options: Record<string, string> | null | undefined): Record<string, string> {
  const set = Object.fromEntries(Object.entries(options ?? {}).filter(([, v]) => typeof v === "string" && v.trim()))
  if (Object.keys(set).length === 0) return {}
  const app = getAgentApp(appId)
  if (!app) throw new AgentAppChoiceError("Harness parameters only apply to an agent app.")
  const problem = agentOptionsError(agentCatalog(app), model, set)
  if (problem) throw new AgentAppChoiceError(problem)
  return set
}

/** The agent apps a project allows, in its order (the first is the default), unknown ids left out. */
export function allowedAgentApps(project: { agentAppIds?: string[] | null } | null | undefined): AgentApp[] {
  return (project?.agentAppIds ?? []).map(getAgentApp).filter((a): a is AgentApp => !!a)
}

type Feature = { id: string; options?: Record<string, string>; ociRef?: string; script?: string }

/**
 * The features an image is built from: the project's own, then each allowed agent app's — after,
 * because an app's feature installs a private Node and an SDK under /opt/spunto/agents and depends
 * on nothing the project adds. Never duplicated: a project that also lists one by hand (hidden from
 * the picker, but a spec file can name it) gets it once, where it is, installed the app's way. The
 * feature is the app's own (`agentFeature`): its id and its install script, written into the recipe
 * as an inline feature — what Cloud's apps declare in their manifest.
 */
export function effectiveFeatures<F extends Feature>(project: { features: F[]; agentAppIds?: string[] | null }): (F | Feature)[] {
  const out: (F | Feature)[] = [...project.features]
  for (const app of allowedAgentApps(project)) {
    const feature = agentFeature(harnessOf(app))
    const listed = out.findIndex((f) => f.id === feature.id)
    if (listed >= 0) out[listed] = { ...out[listed]!, ...feature }
    else out.push({ ...feature })
  }
  return out
}

/** Whether a feature id is an agent app's — added by `effectiveFeatures`, never picked by hand. */
export function isAgentFeature(featureId: string): boolean {
  return Object.values(AGENT_HARNESSES).some((h) => h.featureId === featureId)
}

/**
 * The harness a new task runs under: the one asked for — which must be one the project allows,
 * since only those are in its image — else the project's default (its first). A project that
 * allows none cannot delegate: agent apps are the only harness.
 */
export function resolveTaskAgentApp(project: { agentAppIds?: string[] | null } | null | undefined, requested?: string | null): AgentHarnessId {
  const allowed = allowedAgentApps(project)
  if (allowed.length === 0) {
    throw new AgentAppChoiceError("This project has no harness: switch on an agent app in its settings (Delegated work → Harness) first.")
  }
  if (requested && !allowed.some((a) => a.id === requested)) {
    throw new AgentAppChoiceError(`This project's tasks run under ${allowed.map((a) => a.id).join(" or ")}, not "${requested}" — add it to the project's harnesses first.`)
  }
  return (requested as AgentHarnessId) || allowed[0]!.id
}

/** Why a task may not start under its app — the project dropped it since, and its image may no longer carry it. */
export function taskAgentAppBlocker(task: { agentAppId?: string | null }, project: { agentAppIds?: string[] | null }): string | null {
  if (!task.agentAppId) return `This task cannot run: ${NO_AGENT_APP}`
  if (!getAgentApp(task.agentAppId)) return `"${task.agentAppId}" is not an agent app.`
  if (!(project.agentAppIds ?? []).includes(task.agentAppId)) {
    return `This project no longer runs tasks under ${getAgentApp(task.agentAppId)?.name ?? task.agentAppId} — its image may not carry it any more.`
  }
  return null
}

/** How a task's next session is started and continued. */
export type Harness = {
  /** The app running it. */
  appId: AgentHarnessId
  /** The dialect a session started now speaks — written on the task with it (`sessionProtocol`). */
  protocol: AgentProtocol
  command: string
  /** Resumes the session read off the stream (`$SPUNTO_TASK_SESSION_ID`). */
  followUpCommand: string
  /** Added to the session's environment — the runner's text and the task's parameters. */
  env: Record<string, string>
}

/** Why a task delegated before agent apps (no `agent_app_id`) cannot start a session any more. */
export const NO_AGENT_APP = "it was delegated before agent apps, on a CLI Lite no longer runs — delegate it again."

type HarnessTask = { agentAppId?: string | null; agentOptions?: Record<string, string> | null; sessionProtocol?: string | null; parentTaskId?: string | null }

/**
 * Bundled runners, by entry file: one esbuild pass per runner and per process, like Cloud. On
 * `globalThis` because the process has two module graphs (server.ts under tsx, Next's routes).
 */
const BUNDLES = Symbol.for("spunto-lite.runner-bundles")
const bundles: Map<string, Promise<string>> = ((globalThis as typeof globalThis & { [BUNDLES]?: Map<string, Promise<string>> })[BUNDLES] ??= new Map())

/**
 * One runner entry and everything it imports, as one self-contained ESM file — base64. Since
 * `@spunto/build` 0.23 a runner `.mjs` imports its harness's adapter (`claude/adapter.ts`, which
 * reads the contract's vocabulary…): the machine gets a single file and installs nothing (RFC 0048
 * § 9). Same options as Cloud's `runnerBundle` (apps/agent-apps/src/runner.ts).
 */
function bundle(entry: string): Promise<string> {
  return build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    // The Node the agent features install (`AGENT_NODE_VERSION`) is newer; this is the floor.
    target: "node20",
    write: false,
    logLevel: "silent",
  }).then((r) => Buffer.from(r.outputFiles[0]!.contents).toString("base64"))
}

/**
 * The runner's text, bundled. Not baked in the image: the runner ships with Lite's `@spunto/agent-runners`,
 * and a fix reaches the first session after an update, without a rebuild.
 *
 * The package's runners are bundled once per process and kept; a failed bundle is not, so the next
 * session tries again rather than the process staying stuck on an error until it restarts. A runner
 * from `AGENT_RUNNERS_DIR` is bundled at every session start instead — that directory is for
 * developing a runner, and an edit there should reach the next session as it did before bundling.
 */
export function runnerPayload(harness: Pick<AgentHarness, "id" | "runnerFile">): Promise<string> {
  // A directory that has no runner for this harness leaves it on the package's.
  const override = AGENT_RUNNERS_DIR ? path.resolve(AGENT_RUNNERS_DIR, `${harness.id}.mjs`) : null
  if (override && existsSync(override)) return bundle(override)
  const entry = packageRunnerEntry(harness)
  let bundled = bundles.get(entry)
  if (!bundled) {
    bundled = bundle(entry)
    bundled.catch(() => bundles.delete(entry))
    bundles.set(entry, bundled)
  }
  return bundled
}

/**
 * Where the package's runner entry is on disk. `runnerFile` is a `file:` URL next to its adapter
 * when the package is run from `node_modules` (the custom server, under tsx). Inside Next's server
 * bundle, `new URL("./claude.mjs", import.meta.url)` is an *asset* reference: the bundler copies
 * the `.mjs` alone into `.next`, without the adapter it imports, and esbuild could not bundle that
 * copy. So the entry is looked up in the installed package whenever the URL does not lead to one
 * that still has its adapter beside it.
 */
function packageRunnerEntry(harness: Pick<AgentHarness, "id" | "runnerFile">): string {
  const fromUrl = harness.runnerFile.protocol === "file:" ? fileURLToPath(harness.runnerFile) : null
  if (fromUrl && existsSync(path.join(path.dirname(fromUrl), harness.id))) return fromUrl
  return path.resolve(process.cwd(), "node_modules/@spunto/agent-runners/src", `${harness.id}.mjs`)
}

/**
 * The harness a task's **next** session starts with: its agent app's runner, speaking the contract.
 * A task with no app (delegated before agent apps) has none any more: `NO_AGENT_APP`.
 *
 * `QUESTIONS_ENV` lets Claude ask its multiple-choice questions (`AskUserQuestion`) and wait for
 * the answer — only for a task someone watches: a sub-task's parent is not told of a question, and
 * the turn would wait on no one (Cloud #856).
 */
export async function taskHarness(task: HarnessTask | null | undefined): Promise<Harness> {
  const app = getAgentApp(task?.agentAppId)
  if (!app) throw new Error(task?.agentAppId ? `The agent app "${task.agentAppId}" is not available.` : `This task cannot run: ${NO_AGENT_APP}`)
  const harness = harnessOf(app)
  return {
    appId: app.id,
    protocol: harness.protocol,
    command: runnerCommand(harness),
    followUpCommand: runnerCommand(harness, { resume: true }),
    env: {
      [RUNNER_ENV]: await runnerPayload(harness),
      [OPTIONS_ENV]: JSON.stringify(task?.agentOptions ?? {}),
      ...(task?.parentTaskId ? {} : { [QUESTIONS_ENV]: "1" }),
    },
  }
}

/**
 * How a task's **current** session is read and written to: the dialect it started on
 * (`tasks.session_protocol`), written when it starts. None recorded is a session from before the
 * contract: its history is already stored, there is nothing to read.
 */
export function protocolOf(task: HarnessTask | null | undefined): AgentProtocol {
  if (task?.sessionProtocol && (AGENT_PROTOCOLS as readonly string[]).includes(task.sessionProtocol)) {
    return task.sessionProtocol as AgentProtocol
  }
  return "none"
}
