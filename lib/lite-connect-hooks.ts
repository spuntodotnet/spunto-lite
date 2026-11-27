/**
 * The Lite Connect tunnel (services/lite-tunnel.ts) runs in server.ts's module graph, started at
 * boot; the routes that connect, disconnect or change capabilities run in Next's. Same process, two
 * module graphs — so the tunnel registers its controls on `globalThis`, like lib/agent.ts's hooks,
 * and everything else reaches it through here. Unset (a `next build`, a test without a tunnel):
 * every call is a no-op.
 */

export type LiteTunnelStatus = {
  /** `off`: not connected (or disconnected). `connecting`: dialing or waiting for `welcome`. `online`: welcomed. `retrying`: waiting to redial. */
  state: "off" | "connecting" | "online" | "retrying"
  /** Why the last attempt did not hold, while retrying. Never a token. */
  error: string | null
  nextRetryAt: number | null
}

export type LiteTunnelControl = {
  /** Closes the tunnel if open, then dials again with what the database says now (or stays off). */
  restart(): void
  /** Closes the tunnel and does not redial. */
  stop(): void
  status(): LiteTunnelStatus
  /** Sends a message up the tunnel if it is online; false otherwise (the message is dropped). */
  emit(message: Record<string, unknown>): boolean
}

const KEY = Symbol.for("spunto-lite.lite-tunnel")

export function setLiteTunnel(control: LiteTunnelControl): void {
  ;(globalThis as typeof globalThis & { [KEY]?: LiteTunnelControl })[KEY] = control
}

export function liteTunnel(): LiteTunnelControl | undefined {
  return (globalThis as typeof globalThis & { [KEY]?: LiteTunnelControl })[KEY]
}
