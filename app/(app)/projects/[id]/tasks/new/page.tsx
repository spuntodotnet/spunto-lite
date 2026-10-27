"use client"

import { use } from "react"
import { useRouter } from "next/navigation"
import { NewTask } from "@/components/new-task"

/**
 * A new conversation, in the place it will stream: the cockpit's frame with an empty transcript and
 * the composer at the bottom. Delegating *replaces* this URL with the task's own — the box stays
 * where it was, and the session starts arriving above it.
 */
export default function NewTaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col overflow-hidden">
      <NewTask
        projectId={id}
        backHref={`/projects/${id}?tab=tasks`}
        onCreated={(task) => router.replace(`/projects/${id}/tasks/${task.id}`)}
      />
    </div>
  )
}
