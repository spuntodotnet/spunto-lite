import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import {
  AGENT_CATALOGS,
  AGENT_HARNESSES,
  OPTIONS_ENV,
  RUNNER_ENV,
  agentOptionsError,
  runnerCommand,
  type AgentCatalog,
  type AgentHarness,
  type AgentHarnessId,
} from "@spunto/build/agent-runners"
import type { AgentProtocol } from "@spunto/build/agent-stream"
import { AVAILABLE_FEATURES } from "@spunto/build/catalogs"
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
 *  - **the session**: `taskHarness` says how a task's session is started, continued and read — its
 *    app's runner. A task delegated before agent apps (no app) finishes on the CLI it began on.
 *
 * Same module as Cloud's `agent-apps.ts`, minus installations: Lite has no organization to
 * authorise an app, so both builtins are always offered.
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

type Feature = { id: string; options?: Record<string, string>; ociRef?: string; localScript?: string }

/**
 * The features an image is built from: the project's own, then each allowed agent app's — after,
 * because an app's feature installs a private Node and an SDK under /opt/spunto/agents and depends
 * on nothing the project adds. Never duplicated. An injected feature is a catalog entry like any
 * other (`injected: true`, hidden from the picker), so its `localScript` comes from there.
 */
export function effectiveFeatures<F extends Feature>(project: { features: F[]; agentAppIds?: string[] | null }): (F | Feature)[] {
  const out: (F | Feature)[] = [...project.features]
  for (const app of allowedAgentApps(project)) {
    const featureId = harnessOf(app).featureId
    if (out.some((f) => f.id === featureId)) continue
    const cat = AVAILABLE_FEATURES.find((c) => c.id === featureId)
    out.push({ id: featureId, options: { ...cat?.defaultOptions }, ociRef: cat?.ociRef, localScript: cat?.localScript })
  }
  return out
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
  if (!task.agentAppId) return null
  if (!getAgentApp(task.agentAppId)) return `"${task.agentAppId}" is not an agent app.`
  if (!(project.agentAppIds ?? []).includes(task.agentAppId)) {
    return `This project no longer runs tasks under ${getAgentApp(task.agentAppId)?.name ?? task.agentAppId} — its image may not carry it any more.`
  }
  return null
}

/** How a task's session is started, continued and read. */
export type Harness = {
  /** The app running it, or null for a task delegated before agent apps (`LEGACY_CLI`). */
  appId: string | null
  protocol: AgentProtocol
  command: string
  /** Resumes the session read off the stream (`$SPUNTO_TASK_SESSION_ID`). */
  followUpCommand: string
  /** Added to the session's environment — the runner's text and the task's parameters, for an app. */
  env: Record<string, string>
}

/**
 * What ran a task delegated **before agent apps** (agent_app_id null): Claude Code's CLI, with the
 * project's own command if it had one. Kept only so those conversations can go on to their end: a
 * live session is written to in its own dialect, and a reply resumes it with the CLI it started on.
 */
export const LEGACY_CLI = {
  command: "claude --dangerously-skip-permissions -p",
  followUpCommand: 'claude --dangerously-skip-permissions -p --resume "$SPUNTO_TASK_SESSION_ID"',
} as const

type HarnessProject = { taskAgentProtocol?: string | null; taskAgentCommand?: string | null; taskFollowUpCommand?: string | null }
type HarnessTask = { agentAppId?: string | null; agentOptions?: Record<string, string> | null }

/**
 * The runner's text, base64, read at every session start rather than at boot: the runner ships
 * with Lite's `@spunto/build`, and a fix reaches the next session without a rebuild.
 */
function runnerPayload(harness: AgentHarness): string {
  // A directory that has no runner for this harness leaves it on the package's.
  const override = AGENT_RUNNERS_DIR ? path.resolve(AGENT_RUNNERS_DIR, `${harness.id}.mjs`) : null
  const file = override && existsSync(override) ? override : harness.runnerFile
  return Buffer.from(readFileSync(file, "utf8")).toString("base64")
}

/** The harness of a task: its agent app's runner, or — delegated before agent apps — the CLI it began on. */
export function taskHarness(task: HarnessTask | null | undefined, project: HarnessProject | null | undefined): Harness {
  const app = getAgentApp(task?.agentAppId)
  if (app) {
    const harness = harnessOf(app)
    return {
      appId: app.id,
      protocol: harness.protocol,
      command: runnerCommand(harness),
      followUpCommand: runnerCommand(harness, { resume: true }),
      env: { [RUNNER_ENV]: runnerPayload(harness), [OPTIONS_ENV]: JSON.stringify(task?.agentOptions ?? {}) },
    }
  }
  return {
    appId: null,
    protocol: legacyProtocol(project),
    command: project?.taskAgentCommand?.trim() || LEGACY_CLI.command,
    followUpCommand: project?.taskFollowUpCommand?.trim() || LEGACY_CLI.followUpCommand,
    env: {},
  }
}

function legacyProtocol(project: HarnessProject | null | undefined): AgentProtocol {
  return (project?.taskAgentProtocol ?? "claude-stream") as AgentProtocol
}

/** The protocol alone, for the many readers that only need to know how to read a task's stream. */
export function protocolOf(task: HarnessTask | null | undefined, project: HarnessProject | null | undefined): AgentProtocol {
  const app = getAgentApp(task?.agentAppId)
  return app ? harnessOf(app).protocol : legacyProtocol(project)
}
