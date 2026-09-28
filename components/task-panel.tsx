"use client"

import { TaskList, TaskWorkerChip } from "@spunto/design-system/tasks"
import { useTaskListActions } from "@/hooks/use-task-actions"
import { nextLink } from "@/lib/link-render"
import type { Task } from "@/lib/task-cache"
import type { Worker } from "@/lib/types"
import { NewTaskButton } from "@/components/new-task-button"

/**
 * A project's delegated work — what is running, and what is waiting for me? Drawn by the design
 * system's `TaskList`; this only wires it. Rows come from the page, which also hands them to the
 * workspaces below so each machine can say which task holds it.
 */
export function TaskPanel({ projectId, tasks, workers }: { projectId: string; tasks: Task[]; workers: Worker[] }) {
  const { accept, drop } = useTaskListActions()
  return (
    <TaskList
      tasks={tasks}
      taskHref={(task) => `/projects/${projectId}/tasks/${task.id}`}
      onAccept={accept}
      onDrop={drop}
      renderWorker={(task) =>
        task.workerId && (
          <TaskWorkerChip
            worker={workers.find((w) => w.id === task.workerId)}
            href={`/projects/${projectId}/workers/${task.workerId}`}
            render={{ link: nextLink }}
          />
        )
      }
      cockpitHref="/agents"
      emptyAction={<NewTaskButton projectId={projectId} variant="outline" />}
      render={{ link: nextLink }}
    />
  )
}
