"use client"

import { use } from "react"
import { TaskCockpit } from "@/components/task-cockpit"

/**
 * One conversation at its own URL — linkable, bookmarkable, openable in a tab. Everything lives in
 * `TaskCockpit`, which the agent cockpit mounts too; this page only makes it fill the screen under
 * the header, so the stream scrolls inside itself rather than scrolling the window.
 */
export default function TaskPage({ params }: { params: Promise<{ id: string; taskId: string }> }) {
  const { id, taskId } = use(params)
  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col overflow-hidden">
      <TaskCockpit taskId={taskId} backHref={`/projects/${id}`} />
    </div>
  )
}
