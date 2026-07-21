"use client"

import { useTmuxSessions } from "@/hooks/use-tmux-sessions"
import { SessionTabStrip } from "@/components/session-tab-strip"
import { WorkerXterm } from "@/components/worker-terminal"

export function TerminalSessions({ workerId, enabled, reconnectKey = 0 }: { workerId: string; enabled: boolean; reconnectKey?: number }) {
  const { tabs, active, setActive, createSession, killSession, busy } = useTmuxSessions(workerId, enabled)
  return (
    <div className="flex h-full flex-col">
      <SessionTabStrip tabs={tabs} active={active} setActive={setActive} createSession={createSession} killSession={killSession} busy={busy} />
      <div className="min-h-0 flex-1 bg-[#09090b] p-2">
        <WorkerXterm key={`${active}:${reconnectKey}`} workerId={workerId} session={active} />
      </div>
    </div>
  )
}
