"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

export function Switch({
  checked,
  onCheckedChange,
  className,
  id,
  disabled,
}: {
  checked: boolean
  onCheckedChange: (v: boolean) => void
  className?: string
  id?: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
        checked ? "bg-primary" : "bg-input",
        className,
      )}
    >
      <span
        className={cn(
          "inline-block size-4 rounded-full bg-white shadow-sm transition-transform",
          checked ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
  )
}
