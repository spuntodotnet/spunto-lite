// Which terminal sessions currently have a browser attached.
//
// tmux answered this for free — `session_attached` came out of `list-sessions`. A dtach session is
// a socket file and nothing more: it says who *could* connect, never who is. The process that
// knows is the one holding the WebSocket, which is why `parseSessionList` takes the answer as a
// callback rather than trying to read it off the container.
//
// Kept on `globalThis` rather than in a module-level `Set`, because the two halves of this app do
// not share a module graph: the WebSocket bridge runs under `tsx` from `server.ts`, while the API
// routes are bundled by Next. Same process, two instances of any module imported from both — so a
// plain `Set` here would have the bridge writing into one and `/sessions` reading an empty other.

const KEY = Symbol.for("spunto-lite.terminal-attachments")

type Registry = Set<string>

function registry(): Registry {
  const g = globalThis as typeof globalThis & { [KEY]?: Registry }
  return (g[KEY] ??= new Set())
}

const keyFor = (workerId: string, session: string) => `${workerId}:${session}`

/** Called when a bridge attaches. Returns the matching detach, safe to call twice. */
export function markAttached(workerId: string, session: string): () => void {
  const key = keyFor(workerId, session)
  registry().add(key)
  let released = false
  return () => {
    if (released) return
    released = true
    registry().delete(key)
  }
}

export function isAttached(workerId: string, session: string): boolean {
  return registry().has(keyFor(workerId, session))
}
