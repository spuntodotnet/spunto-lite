"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { useQuery } from "@tanstack/react-query"
import { toast } from "@spunto/design-system"
import {
  EDIT_SECTIONS,
  ProjectForm as DesignSystemProjectForm,
  type ProjectFeatureSelection,
  type ProjectFormSectionId,
  type ProjectFormValue,
  type ProjectRepo,
} from "@spunto/design-system/projects"
import type { DevcontainerFeatureEntry, VscodeExtensionEntry } from "@spunto/design-system/devcontainer"
import { Upload } from "lucide-react"
import { api } from "@/lib/api"
import { EXTENSION_ID_HINT, isExtensionId } from "@/lib/extensions"
import {
  fromExport,
  fromProject,
  newProjectFormValue,
  toProjectPayload,
  validateProjectPayload,
  withUniqueRepoIds,
  type LiteRepo,
} from "@/lib/project-form-value"
import {
  PROJECT_IMPORT_HANDOFF_KEY,
  parseProjectExport,
  type ProjectExport,
} from "@/lib/project-export"
import type {
  Project,
  DevImage,
  DevFeature,
  ExtensionLookup,
  ExtensionSuggestion,
} from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

/**
 * Sections Lite doesn't show. Anything absent from `sections` doesn't exist in
 * the form — but the value still carries it, and `toProjectPayload` still sends
 * it, so a project that already has forwarded ports or prewarmed images keeps
 * them through an edit. Hidden, not dropped: the API, the setup script and the
 * import/export format are untouched.
 */
const HIDDEN_SECTIONS: ProjectFormSectionId[] = ["ports", "prewarm"]

/**
 * Creating shows the rest — including docker-in-docker, which the dashboard only
 * reveals when editing, because in Lite a project *is* its devcontainer spec and
 * there's no second screen to tune it on.
 */
const CREATE_FORM_SECTIONS: ProjectFormSectionId[] = EDIT_SECTIONS.filter((s) => !HIDDEN_SECTIONS.includes(s))
/**
 * Editing also drops `secrets`: the edit page has its own `SecretsCard` below the
 * form, which lists and deletes what's already stored — things the form's
 * write-only list can't do.
 */
const EDIT_FORM_SECTIONS: ProjectFormSectionId[] = CREATE_FORM_SECTIONS.filter((s) => s !== "secrets")

/** What an import pre-filled, for the banner above the form. */
type ImportedSpec = { name: string; secretNames: string[]; formKey: number }

/**
 * The "compose a devcontainer" screen, which is `ProjectForm` from
 * `@spunto/design-system/projects` — the catalogs, the pickers, the numbered
 * sections, the advanced fold and the build manifest all come from the package.
 * What stays here is what the package deliberately doesn't know: Lite's routes,
 * its catalogs' data, its Open VSX endpoints, and the two fields of its project
 * model the package's `ProjectFormValue` has no room for (see `extras` below).
 */
export function ProjectForm({ initial }: { initial?: Project }) {
  const router = useRouter()
  const editing = !!initial

  const [value, setValue] = useState<ProjectFormValue>(() =>
    initial ? fromProject(initial) : newProjectFormValue(),
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [imported, setImported] = useState<ImportedSpec | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const { data: images = [] } = useQuery({ queryKey: ["images"], queryFn: () => api.get<DevImage[]>("/api/images") })
  const { data: features = [] } = useQuery({
    queryKey: ["features"],
    queryFn: () => api.get<DevFeature[]>("/api/features"),
  })

  // Ids the Open VSX search handed back this session. Anything in here provably
  // exists, so it skips the verification below.
  const searched = useRef(new Set<string>())

  /**
   * Everything the form types lands here. Two things happen on the way in that
   * the package leaves to the app on purpose:
   *  - a hand-typed extension id is checked — shape now, existence right after;
   *  - repo row ids are kept unique (see `withUniqueRepoIds`).
   */
  function handleChange(next: ProjectFormValue) {
    const added = next.vscodeExtensions.filter((id) => !value.vscodeExtensions.includes(id))
    const malformed = added.filter((id) => !isExtensionId(id))
    if (malformed.length) {
      toast.error(`Invalid id "${malformed[0]}". ${EXTENSION_ID_HINT}`)
      next = { ...next, vscodeExtensions: next.vscodeExtensions.filter((id) => !malformed.includes(id)) }
    }
    setValue({ ...next, repositories: withUniqueRepoIds(next.repositories) })
    for (const id of added) if (isExtensionId(id)) void verifyExtension(id)
  }

  /**
   * Checks a hand-typed id against the registry. The point is to say "unknown
   * extension" here and now rather than let the user find out from a build log
   * ten minutes later. If the registry itself can't be reached we keep the id
   * with a warning — a network blip shouldn't reject a valid one.
   */
  async function verifyExtension(id: string) {
    if (searched.current.has(id)) return
    try {
      const verdict = await api.get<ExtensionLookup>(`/api/extensions?id=${encodeURIComponent(id)}`)
      if (verdict.found) return
      setValue((cur) => ({ ...cur, vscodeExtensions: cur.vscodeExtensions.filter((x) => x !== id) }))
      toast.error(`"${id}" doesn't exist on Open VSX — code-server wouldn't be able to install it`)
    } catch (e) {
      toast.warning(`Couldn't verify "${id}" against Open VSX (${(e as Error).message}) — added without checking`)
    }
  }

  /**
   * The picker's search callback. Open VSX is the same registry code-server
   * installs from, so anything it returns is installable (see lib/open-vsx.ts).
   */
  async function searchExtensions(query: string): Promise<VscodeExtensionEntry[]> {
    const hits = await api.get<ExtensionSuggestion[]>(`/api/extensions?q=${encodeURIComponent(query)}`)
    for (const hit of hits) searched.current.add(hit.id)
    return hits.map(toExtensionEntry)
  }

  function applyImport(spec: ProjectExport) {
    setValue(fromExport(spec))
    // `formKey` remounts the form (see `key` below). The advanced fold decides
    // whether to open from the value it is *mounted* with — deliberately, so a
    // later keystroke can't yank it open under the cursor — and an import arrives
    // after mount. Without the remount, a spec bringing ports, prewarm or
    // lifecycle commands would land entirely behind a shut drawer.
    setImported((prev) => ({
      name: spec.project.name,
      secretNames: spec.project.secretNames,
      formKey: (prev?.formKey ?? 0) + 1,
    }))
  }

  // Import started from the dashboard: the file was already read and validated
  // there, then handed over through sessionStorage across the navigation.
  useEffect(() => {
    if (editing) return
    const stashed = sessionStorage.getItem(PROJECT_IMPORT_HANDOFF_KEY)
    if (!stashed) return
    sessionStorage.removeItem(PROJECT_IMPORT_HANDOFF_KEY)
    try {
      applyImport(parseProjectExport(stashed))
    } catch (e) {
      toast.error((e as Error).message)
    }
    // Runs once, on mount — the handoff is consumed immediately.
  }, [])

  async function importFile(file: File) {
    try {
      applyImport(parseProjectExport(await file.text()))
      toast.success("Project spec imported — review and create")
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  async function submit(submitted: ProjectFormValue) {
    const payload = toProjectPayload(submitted)
    const invalid = validateProjectPayload(payload)
    if (invalid) {
      setError(invalid)
      toast.error(invalid)
      return
    }
    setSaving(true)
    setError(null)
    try {
      const saved = editing
        ? await api.patch<Project>(`/api/projects/${initial!.id}`, payload)
        : await api.post<Project>("/api/projects", payload)
      toast.success(editing ? "Project updated" : "Project created")
      router.push(`/projects/${saved.id}`)
      router.refresh()
    } catch (e) {
      setError((e as Error).message)
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">
            {editing ? `Edit ${initial!.name}` : "New project"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Define a devcontainer-style spec. Workers spawn from it as isolated Docker containers.
          </p>
        </div>
        {!editing && (
          <>
            <Button variant="outline" size="sm" className="shrink-0" onClick={() => fileInput.current?.click()}>
              <Upload /> Import JSON
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
          </>
        )}
      </div>

      {imported && (
        <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          Fields pre-filled from the export of <span className="font-medium text-foreground">{imported.name}</span>.
          {imported.secretNames.length > 0 && (
            <>
              {" "}
              Secret values aren&apos;t exported — add{" "}
              <span className="font-mono text-foreground">{imported.secretNames.join(", ")}</span> by hand below.
            </>
          )}
        </p>
      )}

      <DesignSystemProjectForm
        key={imported?.formKey ?? 0}
        value={value}
        onChange={handleChange}
        onSubmit={submit}
        sections={editing ? EDIT_FORM_SECTIONS : CREATE_FORM_SECTIONS}
        images={images}
        features={features}
        onSearchExtensions={searchExtensions}
        // Lite has no GitHub App and no repo combobox of its own, so the package's
        // `<input list>` + `<datalist>` fallback is exactly right — `renderRepoField`
        // stays unset rather than wrapping a plain input in a slot.
        extras={{
          repositories: (
            <RepoBranches
              repos={value.repositories}
              onChange={(repositories) => handleChange({ ...value, repositories })}
            />
          ),
          features: (
            <FeatureVersions
              selections={value.features}
              catalog={features}
              onChange={(f) => handleChange({ ...value, features: f })}
            />
          ),
        }}
        submitLabel={editing ? "Save changes" : "Create project"}
        submitting={saving}
        error={error}
        manifestCaption={
          editing
            ? "Saving bumps the project version — existing workers pick it up once rebuilt."
            : "Nothing is built yet; workers are created from this spec afterwards."
        }
        manifestFooter={
          <Button type="button" variant="ghost" className="w-full" onClick={() => router.back()}>
            Cancel
          </Button>
        }
      />
    </div>
  )
}

/**
 * The branch each repository is cloned on. Lite's `Repository` has one and the
 * package's `ProjectRepo` doesn't, so it gets a row under the package's repo list
 * instead of a hand-drawn section of its own: the day `RepoList` grows a branch
 * field, this component is the only thing to delete.
 */
function RepoBranches({ repos, onChange }: { repos: ProjectRepo[]; onChange: (repos: ProjectRepo[]) => void }) {
  const rows = repos as LiteRepo[]
  if (rows.length === 0) return null
  return (
    <div className="mt-4 space-y-2 border-t border-dashed border-border pt-3">
      <Label className="text-xs text-muted-foreground">Branch to clone — empty for the remote&apos;s default</Label>
      {rows.map((repo) => (
        <div key={repo.id} className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
            {repo.project || repo.cloneUrl || "new repository"}
          </span>
          <Input
            className="h-8 w-44 font-mono text-xs"
            placeholder="default"
            aria-label={`Branch for ${repo.project || repo.cloneUrl || "new repository"}`}
            value={repo.branch ?? ""}
            onChange={(e) =>
              onChange(rows.map((r) => (r.id === repo.id ? { ...r, branch: e.target.value } : r)))
            }
          />
        </div>
      ))}
      <p className="text-xs text-muted-foreground">Each workspace can override it at creation.</p>
    </div>
  )
}

/**
 * The `version` option of a selected feature. `FeaturePicker` renders the options
 * a feature will be installed with as chips but has no editor for them
 * (`FeatureCard.optionsSlot` is the package's seam and the picker doesn't expose
 * it), so the one option Lite's catalog declares gets its own row here.
 */
function FeatureVersions({
  selections,
  catalog,
  onChange,
}: {
  selections: ProjectFeatureSelection[]
  catalog: DevcontainerFeatureEntry[]
  onChange: (selections: ProjectFeatureSelection[]) => void
}) {
  const versioned = selections.flatMap((selection) => {
    const entry = catalog.find((c) => c.id === selection.id)
    const option = entry?.options?.find((o) => o.name === "version")
    return option ? [{ selection, label: entry?.label ?? selection.id, fallback: option.default }] : []
  })
  if (versioned.length === 0) return null
  return (
    <div className="mt-4 space-y-2 border-t border-dashed border-border pt-3">
      <Label className="text-xs text-muted-foreground">Versions — empty for the feature&apos;s default</Label>
      {versioned.map(({ selection, label, fallback }) => (
        <div key={selection.id} className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{label}</span>
          <Input
            className="h-8 w-44 font-mono text-xs"
            placeholder={fallback}
            aria-label={`${label} version`}
            value={selection.options?.version ?? ""}
            onChange={(e) =>
              onChange(
                selections.map((s) =>
                  s.id === selection.id
                    ? { ...s, options: e.target.value ? { ...s.options, version: e.target.value } : undefined }
                    : s,
                ),
              )
            }
          />
        </div>
      ))}
    </div>
  )
}

/** An /api/extensions hit, as the package's cards read it. */
function toExtensionEntry(e: ExtensionSuggestion): VscodeExtensionEntry {
  return {
    id: e.id,
    displayName: e.label,
    description: e.description,
    version: e.version,
    iconUrl: e.iconUrl,
    downloadCount: e.downloads,
    verified: e.verified,
  }
}
