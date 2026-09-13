"use client"

import { useEffect, useRef, type RefObject } from "react"
import { useQuery } from "@tanstack/react-query"
import { Terminal, type TerminalHandle } from "@spunto/design-system"

/**
 * Prints a full text snapshot into a terminal handle, re-printing it whenever it
 * changes. `text` is the whole already-tailed buffer, not a delta: we clear and
 * re-write. Container/build logs are LF-terminated and xterm needs CRLF to return
 * the cursor to column 0.
 *
 * Takes a handle rather than rendering one, because the DS offers two surfaces
 * that expose the same `TerminalHandle` — the bare `Terminal` and the framed
 * `TerminalPanel` — and which one a page wants is a framing decision, not a
 * printing one.
 *
 * `placeholder` writes dim text *into the buffer*, for the bare `Terminal` which
 * has nowhere else to put it. `TerminalPanel` has a real `placeholder` prop that
 * swaps the surface out instead — callers using it should leave this unset.
 */
export function useLogSnapshot(term: RefObject<TerminalHandle | null>, text: string, placeholder?: string) {
  // react-query keeps the string reference stable while the buffer is unchanged,
  // so this only fires on a real update — cheap enough to reprint the whole tail
  // (and correct even once the tail window slides past its line cap).
  useEffect(() => {
    const t = term.current
    if (!t) return
    t.clear()
    if (text) t.write(text.replace(/\r?\n/g, "\r\n"))
    else if (placeholder) t.write(`\x1b[2m${placeholder}\x1b[0m`)
  }, [term, text, placeholder])
}

/**
 * Renders a chunk of log text in the design-system `Terminal` (a read-only
 * xterm surface — no `onData`, so stdin stays disabled) so ANSI colours from the
 * container/build survive.
 */
export function LogTerminal({ text, placeholder = "No output yet…" }: { text: string; placeholder?: string }) {
  const term = useRef<TerminalHandle>(null)
  useLogSnapshot(term, text, placeholder)

  return (
    <div className="h-full w-full min-h-0 min-w-0">
      {/* Drop the DS Terminal's own border + padding: the logs surface sits flush
          in its (already dark) panel, no framing needed. */}
      <Terminal ref={term} className="border-0 p-0" fontSize={12} options={{ webLinks: true }} />
    </div>
  )
}

/** Read-only, auto-scrolling log tail (polls a text endpoint). */
export function LogsPanel({ url, refetchInterval = 2000 }: { url: string; refetchInterval?: number }) {
  const { data = "" } = useQuery({
    queryKey: ["logs", url],
    queryFn: () => fetch(url).then((r) => r.text()),
    refetchInterval,
  })
  return <LogTerminal text={data} />
}
