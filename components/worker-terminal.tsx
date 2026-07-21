"use client"

import { useEffect, useRef } from "react"

// base64 → raw bytes. Passing the Uint8Array to xterm lets it decode UTF-8 itself;
// atob() alone yields a latin-1 string that mangles multi-byte glyphs (❯, box-drawing, accents).
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}
// string → UTF-8 bytes → base64 (so pasted/typed non-ASCII survives the trip).
function utf8ToB64(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

// Bare interactive xterm bound to a tmux session over the terminal WebSocket.
// The session strip renders the chrome above it.
export function WorkerXterm({ workerId, session = "main" }: { workerId: string; session?: string }) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let disposed = false
    let ws: WebSocket | null = null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let term: any = null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let fit: any = null
    let onResize: (() => void) | null = null

    async function boot() {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")])
      if (disposed || !containerRef.current) return

      term = new Terminal({
        cursorBlink: true,
        fontFamily: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
        fontSize: 13,
        lineHeight: 1.4,
        theme: { background: "#09090b", foreground: "#e4e4e7", cursor: "#ea5400" },
      })
      fit = new FitAddon()
      term.loadAddon(fit)
      term.open(containerRef.current)
      fit.fit()

      const proto = window.location.protocol === "https:" ? "wss" : "ws"
      const { cols, rows } = term
      const url = `${proto}://${window.location.host}/api/workers/${workerId}/terminal?cols=${cols}&rows=${rows}&session=${session}`
      ws = new WebSocket(url)

      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data)
        if (msg.type === "output") term.write(b64ToBytes(msg.data))
        else if (msg.type === "error") term.writeln(`\r\n\x1b[31m${msg.message}\x1b[0m`)
      }
      term.onData((data: string) => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data: utf8ToB64(data) }))
      })

      onResize = () => {
        try {
          fit.fit()
          if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }))
        } catch {}
      }
      window.addEventListener("resize", onResize)
    }

    boot()
    return () => {
      disposed = true
      if (onResize) window.removeEventListener("resize", onResize)
      try {
        ws?.close()
        term?.dispose()
      } catch {}
    }
  }, [workerId, session])

  return <div ref={containerRef} className="h-full w-full" style={{ minHeight: 200 }} />
}
