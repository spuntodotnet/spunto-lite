"use client"

import { useEffect, useRef, useState } from "react"

// Interactive tmux terminal over the /api/workers/:id/terminal WebSocket.
// Protocol — browser→server: {type:"input",data:base64} | {type:"resize",cols,rows}
//            server→browser: {type:"ready"} | {type:"output",data:base64} | {type:"error"}
export function WorkerTerminal({ workerId, session = "main" }: { workerId: string; session?: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<"connecting" | "open" | "closed">("connecting")

  useEffect(() => {
    let disposed = false
    let ws: WebSocket | null = null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let term: any = null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let fit: any = null

    async function boot() {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")])
      if (disposed || !containerRef.current) return

      term = new Terminal({
        cursorBlink: true,
        fontFamily: 'var(--font-geist-mono), "JetBrains Mono", monospace',
        fontSize: 13,
        theme: { background: "#0f0f10", foreground: "#e4e4e7", cursor: "#ea5400" },
      })
      fit = new FitAddon()
      term.loadAddon(fit)
      term.open(containerRef.current)
      fit.fit()

      const proto = window.location.protocol === "https:" ? "wss" : "ws"
      const { cols, rows } = term
      const url = `${proto}://${window.location.host}/api/workers/${workerId}/terminal?cols=${cols}&rows=${rows}&session=${session}`
      ws = new WebSocket(url)

      ws.onopen = () => setStatus("open")
      ws.onclose = () => setStatus("closed")
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data)
        if (msg.type === "output") term.write(atob(msg.data))
        else if (msg.type === "error") term.writeln(`\r\n\x1b[31m${msg.message}\x1b[0m`)
      }

      term.onData((data: string) => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data: btoa(data) }))
        }
      })

      const onResize = () => {
        try {
          fit.fit()
          if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }))
        } catch {}
      }
      window.addEventListener("resize", onResize)
      ;(term as unknown as { _cleanup: () => void })._cleanup = () => window.removeEventListener("resize", onResize)
    }

    boot()
    return () => {
      disposed = true
      try {
        ;(term as unknown as { _cleanup?: () => void })?._cleanup?.()
        ws?.close()
        term?.dispose()
      } catch {}
    }
  }, [workerId, session])

  return (
    <div className="h-full min-h-0 flex flex-col rounded-lg overflow-hidden border border-border bg-[#0f0f10]">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/60 text-xs text-muted-foreground">
        <span className={`size-2 rounded-full ${status === "open" ? "bg-emerald-500" : status === "closed" ? "bg-red-500" : "bg-amber-500"}`} />
        Terminal · {session}
      </div>
      <div ref={containerRef} className="flex-1 min-h-0 p-2" />
    </div>
  )
}
