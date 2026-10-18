import { z } from "zod"
import { getSshAgentStatus, lockKey, unlockSelectedKey, UnlockError } from "@/lib/ssh-agent"
import { json, parseBody, badRequest } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// Never logged, never stored: see lib/ssh-agent.ts. It only reaches ssh-add's stdin.
const UnlockSchema = z.object({ passphrase: z.string().min(1).max(1024) })

/** How workers authenticate with the selected key: encrypted or not, agent available, unlocked. */
export async function GET() {
  return json(await getSshAgentStatus())
}

/** Unlocks the selected key: decrypts it into Spunto Lite's ssh-agent with the given passphrase. */
export async function POST(req: Request) {
  const parsed = await parseBody(req, UnlockSchema)
  if ("response" in parsed) return parsed.response
  try {
    await unlockSelectedKey(parsed.data.passphrase)
  } catch (err) {
    if (err instanceof UnlockError) return badRequest(err.message)
    throw err
  }
  return json(await getSshAgentStatus())
}

/** Locks it again: the agent forgets the decrypted key. */
export async function DELETE() {
  await lockKey()
  return json(await getSshAgentStatus())
}
