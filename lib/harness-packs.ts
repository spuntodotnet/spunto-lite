import type { AgentProtocol } from "@spunto/build/agent-stream"

/**
 * The harnesses a project can pick with one click — a static catalogue, versioned with the
 * release, like `GET /api/features` (docs/tasks.md § "Choisir le modèle"). Same shape and same
 * content as Spunto Cloud's `GET /api/harness-packs`.
 *
 * A pack is a **suggestion, never a remembered choice**: nothing on a project says which pack is
 * active. The form re-derives it by comparing the current fields to each pack (`packMatches`),
 * and falls back to "Custom" when none matches.
 */

/**
 * The default harness: Claude Code, reading its prompt on stdin. `bash -l` inside the worker
 * gives it the project's own PATH and secrets — including whatever authenticates it there.
 */
export const DEFAULT_AGENT_COMMAND = "claude --dangerously-skip-permissions -p"

/**
 * How a finished one-shot session is continued: `--resume` on the id read off the stream, so the
 * next turn keeps the context of the previous ones.
 */
export const DEFAULT_FOLLOW_UP_COMMAND = 'claude --dangerously-skip-permissions -p --resume "$SPUNTO_TASK_SESSION_ID"'

export type HarnessPack = {
  id: string
  label: string
  description: string
  agentCommand: string
  followUpCommand: string
  protocol: AgentProtocol
  models: { value: string; label: string }[]
}

export const HARNESS_PACKS: HarnessPack[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    description: "The built-in default, kept alive between turns.",
    agentCommand: DEFAULT_AGENT_COMMAND,
    followUpCommand: DEFAULT_FOLLOW_UP_COMMAND,
    protocol: "claude-stream",
    models: [
      { value: "claude-opus-5-5", label: "Claude Opus 5.5" },
      { value: "claude-opus-5", label: "Claude Opus 5" },
      { value: "claude-sonnet-5", label: "Claude Sonnet 5" },
      { value: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
      { value: "claude-fable-5-1", label: "Claude Fable 5.1" },
    ],
  },
]

/** Does a project's current harness correspond to this pack? Blank fields mean the defaults. */
export function packMatches(
  pack: HarnessPack,
  project: { taskAgentCommand?: string | null; taskFollowUpCommand?: string | null; taskAgentProtocol?: string | null },
): boolean {
  const command = project.taskAgentCommand?.trim() || DEFAULT_AGENT_COMMAND
  const followUp = project.taskFollowUpCommand?.trim() || DEFAULT_FOLLOW_UP_COMMAND
  const protocol = project.taskAgentProtocol || "claude-stream"
  return command === pack.agentCommand && followUp === pack.followUpCommand && protocol === pack.protocol
}
