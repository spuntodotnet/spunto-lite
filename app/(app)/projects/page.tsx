"use client"

import { useRef, useState, type ReactNode } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn, formatRelativeTime, toast } from "@spunto/design-system"
import { ArrowDown, ArrowUp, Box, GitBranch, Plus, Rocket, Search, Sparkles, Star, Upload } from "lucide-react"
import { api } from "@/lib/api"
import { PROJECT_IMPORT_HANDOFF_KEY, parseProjectExport } from "@/lib/project-export"
import type { Project } from "@/lib/types"
import { Button, buttonVariants } from "@/components/ui/button"
import { SpawnWorkerButton } from "@/components/spawn-worker-button"
import { newTaskHref } from "@/components/new-task"

/* Every project as one row of a table (Cloud 2a2f15bc), with what it runs right now — its
   workspaces and tasks, counted by the list route (`listProjectsWithStats`) — and what it is made
   of (base image, repositories, the build of its current version).

   Favorites are their own group on top, whatever the sort: they are the projects someone chose to
   keep in reach. Both groups follow the same sort, the one that moved last first by default. Each
   row has the two things a project is opened for — a workspace, a task — without the detour
   through its page. */

/** `GET /api/projects`: the project and its counts (services/projects.ts `ProjectListStats`). */
type ProjectRow = Project & {
  workerCount: number
  runningWorkerCount: number
  taskCount: number
  activeTaskCount: number
  lastActivityAt: string
  buildState: string | null
}
type SortKey = "name" | "image" | "workers" | "tasks" | "activity"
type Sort = { key: SortKey; desc: boolean }

const BUILD_LABEL: Record<string, { label: string; className: string }> = {
  ready: { label: "Built", className: "text-success" },
  building: { label: "Building…", className: "text-warning" },
  error: { label: "Build failed", className: "text-destructive" },
}

/** Live first, then total: a project with a running workspace outranks one with many stopped ones. */
const SORT_VALUE: Record<SortKey, (p: ProjectRow) => string | number> = {
  name: (p) => p.name.toLowerCase(),
  image: (p) => shortImage(p.image).toLowerCase(),
  workers: (p) => p.runningWorkerCount * 1e6 + p.workerCount,
  tasks: (p) => p.activeTaskCount * 1e6 + p.taskCount,
  activity: (p) => p.lastActivityAt,
}

/** What a click on a column sorts by first: names A→Z, numbers and dates biggest first. */
const FIRST_DESC: Record<SortKey, boolean> = { name: false, image: false, workers: true, tasks: true, activity: true }

function compare(sort: Sort) {
  const value = SORT_VALUE[sort.key]
  return (a: ProjectRow, b: ProjectRow) => {
    const x = value(a)
    const y = value(b)
    const order = x < y ? -1 : x > y ? 1 : 0
    // Ties: the one that moved last first, whatever the column.
    return (sort.desc ? -order : order) || b.lastActivityAt.localeCompare(a.lastActivityAt)
  }
}

/** "javascript-node:20" from "mcr.microsoft.com/devcontainers/javascript-node:20". */
function shortImage(image: string): string {
  return image.split("/").pop() ?? image
}

/** What the search box looks in: name, description, image, and each repository's label and URL. */
function matches(p: ProjectRow, q: string): boolean {
  return [p.name, p.description, p.image, ...p.repositories.flatMap((r) => [r.project, r.cloneUrl])].some((v) =>
    v?.toLowerCase().includes(q),
  )
}

function Stat({ label, value, detail }: { label: string; value: number; detail?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="font-display text-2xl tabular-nums">{value}</span>
        {detail && <span className="text-xs text-muted-foreground">{detail}</span>}
      </div>
    </div>
  )
}

/** "2 / 5" — the live part bold, the total muted; a dash when there was never any. */
function Count({ live, total, liveLabel }: { live: number; total: number; liveLabel: string }) {
  if (total === 0) return <span className="text-muted-foreground">—</span>
  return (
    <span className="inline-flex items-center gap-1.5 tabular-nums" title={`${live} ${liveLabel} of ${total}`}>
      {live > 0 && <span className="h-1.5 w-1.5 rounded-full bg-success" />}
      <span className={live > 0 ? "font-medium text-foreground" : "text-muted-foreground"}>{live}</span>
      <span className="text-muted-foreground">/ {total}</span>
    </span>
  )
}

function SortableHead({
  label,
  column,
  sort,
  onSort,
  className,
  hint,
}: {
  label: string
  column: SortKey
  sort: Sort
  onSort: (key: SortKey) => void
  className?: string
  hint?: string
}) {
  const active = sort.key === column
  const Arrow = sort.desc ? ArrowDown : ArrowUp
  const arrow = <Arrow className={cn("h-3 w-3", active ? "opacity-100" : "opacity-0")} />
  const right = className?.includes("text-right")
  return (
    <TableHead className={className} aria-sort={active ? (sort.desc ? "descending" : "ascending") : "none"}>
      <button
        type="button"
        onClick={() => onSort(column)}
        title={hint}
        className={cn("inline-flex items-center gap-1 rounded hover:text-foreground", active ? "text-foreground" : "text-muted-foreground")}
      >
        {/* On a right-aligned column the arrow goes first, so the label stays above its numbers. */}
        {right && arrow}
        {label}
        {!right && arrow}
      </button>
    </TableHead>
  )
}

const COLUMNS = 8

function GroupRow({ children }: { children: ReactNode }) {
  return (
    <TableRow className="bg-muted/40 hover:bg-muted/40">
      <TableCell colSpan={COLUMNS} className="py-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {children}
      </TableCell>
    </TableRow>
  )
}

export default function ProjectsPage() {
  const qc = useQueryClient()
  const router = useRouter()
  const fileInput = useRef<HTMLInputElement>(null)
  const [sort, setSort] = useState<Sort>({ key: "activity", desc: true })
  const [query, setQuery] = useState("")
  const { data: projects = [], isLoading } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.get<ProjectRow[]>("/api/projects"),
    // The counts move with the workspaces and tasks of every project: slow, but not never.
    refetchInterval: 15_000,
  })

  const favorite = useMutation({
    mutationFn: ({ id, favorite }: { id: string; favorite: boolean }) => api.post(`/api/projects/${id}/favorite`, { favorite }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  })

  /** Validate here, hand the spec to the creation form through sessionStorage. */
  async function importFile(file: File) {
    const text = await file.text()
    try {
      parseProjectExport(text)
    } catch (e) {
      return toast.error((e as Error).message)
    }
    sessionStorage.setItem(PROJECT_IMPORT_HANDOFF_KEY, text)
    router.push("/projects/new")
  }

  const onSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: FIRST_DESC[key] }))

  const q = query.trim().toLowerCase()
  const shown = projects.filter((p) => !q || matches(p, q)).sort(compare(sort))
  const favorites = shown.filter((p) => p.favorite)
  const others = shown.filter((p) => !p.favorite)

  const sum = (pick: (p: ProjectRow) => number) => projects.reduce((n, p) => n + (pick(p) ?? 0), 0)
  const runningWorkers = sum((p) => p.runningWorkerCount)
  const allWorkers = sum((p) => p.workerCount)
  const activeTasks = sum((p) => p.activeTaskCount)
  const allTasks = sum((p) => p.taskCount)

  const row = (project: ProjectRow) => {
    const href = `/projects/${project.id}`
    const build = project.buildState ? BUILD_LABEL[project.buildState] : null
    const repos = project.repositories.map((r) => r.project)
    return (
      <TableRow key={project.id} className="group cursor-pointer" onClick={() => router.push(href)}>
        <TableCell className="pr-0">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              favorite.mutate({ id: project.id, favorite: !project.favorite })
            }}
            title={project.favorite ? "Remove from favorites" : "Add to favorites"}
            aria-label={project.favorite ? "Remove from favorites" : "Add to favorites"}
            className={cn(
              "rounded-md p-1 hover:bg-accent",
              project.favorite
                ? "text-amber-400"
                : "text-muted-foreground/30 group-hover:text-muted-foreground/70 hover:!text-muted-foreground",
            )}
          >
            <Star className="h-4 w-4" fill={project.favorite ? "currentColor" : "none"} />
          </button>
        </TableCell>

        {/* Project: name, then its repositories (or its description) */}
        <TableCell>
          <Link href={href} onClick={(e) => e.stopPropagation()} className="font-medium text-foreground hover:underline">
            {project.name}
          </Link>
          <div className="mt-0.5 flex max-w-[22rem] items-center gap-1.5 text-xs text-muted-foreground">
            {repos.length > 0 ? (
              <>
                <GitBranch className="h-3 w-3 shrink-0" />
                <span className="truncate font-mono" title={project.repositories.map((r) => r.cloneUrl).join("\n")}>
                  {repos[0]}
                  {repos.length > 1 && ` +${repos.length - 1}`}
                </span>
              </>
            ) : (
              <span className="truncate" title={project.description ?? undefined}>
                {project.description || "No repository"}
              </span>
            )}
          </div>
        </TableCell>

        <TableCell>
          <span className="block max-w-56 truncate font-mono text-xs" title={project.image}>
            {shortImage(project.image)}
          </span>
        </TableCell>

        <TableCell className="text-right text-sm">
          <Count live={project.runningWorkerCount} total={project.workerCount} liveLabel="running" />
        </TableCell>

        <TableCell className="text-right text-sm">
          <Count live={project.activeTaskCount} total={project.taskCount} liveLabel="in progress" />
        </TableCell>

        <TableCell className="hidden text-xs lg:table-cell">
          {build ? <span className={build.className}>{build.label}</span> : <span className="text-muted-foreground">Not built</span>}
          <span className="ml-1.5 text-muted-foreground">v{project.currentVersion}</span>
        </TableCell>

        <TableCell className="hidden text-right text-xs text-muted-foreground md:table-cell" title={new Date(project.lastActivityAt).toLocaleString()}>
          {formatRelativeTime(project.lastActivityAt)}
        </TableCell>

        {/* Quick actions — what someone opens a project for, without the detour through its page.
            Clicks stop here: the spawn dialog is portalled, but React still bubbles its events
            through this cell to the row, which would navigate away mid-form. */}
        <TableCell className="w-px whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
          <div className="flex justify-end gap-1 opacity-60 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <SpawnWorkerButton
              projectId={project.id}
              compact
              onSpawned={(w) => router.push(`/projects/${project.id}/workers/${w.id}`)}
            />
            <Link
              href={newTaskHref(project.id)}
              className={cn(buttonVariants({ size: "sm", variant: "outline" }), "h-7 gap-1 px-2 text-xs")}
              title="Delegate a task to an agent on this project"
            >
              <Sparkles className="h-3.5 w-3.5" />
              Task
            </Link>
          </div>
        </TableCell>
      </TableRow>
    )
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl tracking-tight">Projects</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Devcontainer specs you spawn workspaces from — or delegate a task to an agent in one.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => fileInput.current?.click()}>
            <Upload /> Import
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            className="hidden"
            aria-label="Import project JSON"
            onChange={(e) => {
              const file = e.target.files?.[0]
              // Reset so re-picking the same file fires `change` again.
              e.target.value = ""
              if (file) importFile(file)
            }}
          />
          <Link href="/projects/new-from-template">
            <Button variant="outline">
              <Rocket /> From template
            </Button>
          </Link>
          <Link href="/projects/new">
            <Button>
              <Plus /> New project
            </Button>
          </Link>
        </div>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : projects.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-12 text-center">
          <Box className="mx-auto mb-3 size-8 text-muted-foreground" />
          <p className="font-medium">No projects yet</p>
          <p className="mb-4 mt-1 text-sm text-muted-foreground">Create your first devcontainer spec.</p>
          <Link href="/projects/new">
            <Button>
              <Plus /> New project
            </Button>
          </Link>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Projects" value={projects.length} />
            <Stat label="Workspaces running" value={runningWorkers} detail={`of ${allWorkers}`} />
            <Stat label="Tasks in progress" value={activeTasks} />
            <Stat label="Tasks delegated" value={allTasks} />
          </div>

          <div className="space-y-3">
            <label className="relative block w-full sm:w-64">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Name, repository, image…"
                aria-label="Search projects"
                className="h-8 w-full rounded-md border border-border bg-background pl-7 pr-2 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/30"
              />
            </label>

            <div className="overflow-x-auto rounded-lg border border-border">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-10" />
                    <SortableHead label="Project" column="name" sort={sort} onSort={onSort} className="min-w-56" />
                    <SortableHead label="Base image" column="image" sort={sort} onSort={onSort} />
                    <SortableHead label="Workspaces" column="workers" sort={sort} onSort={onSort} className="text-right" hint="Running / total" />
                    <SortableHead label="Tasks" column="tasks" sort={sort} onSort={onSort} className="text-right" hint="In progress / total" />
                    <TableHead className="hidden lg:table-cell">Build</TableHead>
                    <SortableHead label="Last activity" column="activity" sort={sort} onSort={onSort} className="hidden text-right md:table-cell" />
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.length === 0 && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={COLUMNS} className="py-10 text-center text-sm text-muted-foreground">
                        No project matches “{query.trim()}”.
                      </TableCell>
                    </TableRow>
                  )}
                  {favorites.length > 0 && (
                    <>
                      <GroupRow>
                        <span className="inline-flex items-center gap-1.5">
                          <Star className="h-3 w-3 text-amber-400" fill="currentColor" />
                          Favorites
                        </span>
                      </GroupRow>
                      {favorites.map(row)}
                      {others.length > 0 && <GroupRow>All projects</GroupRow>}
                    </>
                  )}
                  {others.map(row)}
                </TableBody>
              </Table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
