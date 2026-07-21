"use client"

import { useRef, useState, type ReactNode } from "react"
import { cn } from "@/lib/utils"

/**
 * Lightweight hover/focus tooltip — no external dependency. Wraps a trigger and
 * reveals `content` in a floating panel after a short delay (matches the "big"
 * spunto's 150 ms). Kept intentionally simple (single side) for the worker cards.
 */
export function Tooltip({
  content,
  children,
  side = "top",
  className,
  delay = 150,
}: {
  content: ReactNode
  children: ReactNode
  side?: "top" | "bottom"
  className?: string
  delay?: number
}) {
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const show = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setOpen(true), delay)
  }
  const hide = () => {
    if (timer.current) clearTimeout(timer.current)
    setOpen(false)
  }

  if (!content) return <>{children}</>

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {open && (
        <span
          role="tooltip"
          className={cn(
            "absolute left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md pointer-events-none",
            side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5",
            className,
          )}
        >
          {content}
        </span>
      )}
    </span>
  )
}
