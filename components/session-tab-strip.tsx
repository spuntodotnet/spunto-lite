"use client"

import { Terminal as TerminalIcon, X, Plus } from "lucide-react"
import { cn } from "@/lib/utils"
import type { TmuxSession } from "@/hooks/use-tmux-sessions"

export function SessionTabStrip({
  tabs,
  active,
  setActive,
  createSession,
  killSession,
  busy,
}: {
  tabs: TmuxSession[]
  active: string
  setActive: (name: string) => void
  createSession: () => void
  killSession: (name: string) => void
  busy: boolean
}) {
  return (
    <div className="flex items-center gap-1 border-b border-white/5 bg-[#0c0c0e] px-1.5 py-1 shrink-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {tabs.map((s) => {
        const isActive = s.name === active
        return (
          <button
            key={s.name}
            onClick={() => setActive(s.name)}
            title={`${s.name} · ${s.windows} window${s.windows > 1 ? "s" : ""}${s.attached ? " · attached" : ""}`}
            className={cn(
              "group flex shrink-0 items-center gap-1.5 rounded-md pl-2 pr-1 py-1 text-[11px] font-mono transition-colors",
              isActive ? "bg-[#ea5400]/15 text-[#ff7a3d]" : "text-zinc-500 hover:bg-white/5 hover:text-zinc-300",
            )}
          >
            <TerminalIcon className="h-3 w-3 shrink-0 opacity-70" />
            <span className="max-w-[110px] truncate">{s.name}</span>
            {!s.attached && <span className="h-1 w-1 shrink-0 rounded-full bg-emerald-500/70" title="running in background" />}
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation()
                killSession(s.name)
              }}
              className={cn(
                "flex h-4 w-4 shrink-0 items-center justify-center rounded transition-opacity hover:bg-white/10 hover:text-red-400",
                isActive ? "opacity-70" : "opacity-0 group-hover:opacity-60",
              )}
            >
              <X className="h-3 w-3" />
            </span>
          </button>
        )
      })}
      <button
        onClick={createSession}
        disabled={busy}
        title="New terminal session"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200 disabled:opacity-40"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
