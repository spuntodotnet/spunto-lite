"use client"

import { useEffect, useRef } from "react"
import { useQuery } from "@tanstack/react-query"

/** Read-only, auto-scrolling log tail (polls a text endpoint). */
export function LogsPanel({ url, refetchInterval = 2000 }: { url: string; refetchInterval?: number }) {
  const { data = "" } = useQuery({
    queryKey: ["logs", url],
    queryFn: () => fetch(url).then((r) => r.text()),
    refetchInterval,
  })
  const ref = useRef<HTMLPreElement>(null)
  const stick = useRef(true)

  useEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [data])

  return (
    <pre
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      }}
      className="h-full overflow-auto bg-[oklch(0.17_0.012_52)] text-zinc-200 text-xs font-mono p-3 rounded-lg whitespace-pre-wrap break-words"
    >
      {data || "No output yet…"}
    </pre>
  )
}
