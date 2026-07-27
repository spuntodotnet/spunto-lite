"use client"

import type { ReactNode } from "react"
import { useState } from "react"
import Link from "next/link"
import { useQuery } from "@tanstack/react-query"
import { useTheme } from "next-themes"
import {
  CommandPalette,
  CommandPaletteEmpty,
  CommandPaletteFooter,
  CommandPaletteGroup,
  CommandPaletteInput,
  CommandPaletteItem,
  CommandPaletteList,
  CommandPaletteLoading,
  CommandPaletteSeparator,
  CommandPaletteTrigger,
  Kbd,
  type CommandPaletteLinkProps,
} from "@spunto/design-system"
import {
  Activity,
  Container,
  FolderGit2,
  Globe,
  KeyRound,
  Layers,
  Moon,
  Plus,
  Rocket,
  Settings,
  Sun,
} from "lucide-react"
import { api } from "@/lib/api"
import type { SearchHit, SearchIndex, SearchKind } from "@/lib/types"
import { workerBaseUrl } from "@/lib/worker-url"

// The app's ⌘K: the design-system `CommandPalette` (input + groups + items, all
// keyboard behaviour included) fed by `/api/search`. Everything domain-specific
// lives here — the palette itself knows nothing of projects or workers.
//
// The whole index is fetched on open and filtered in the browser, so typing never
// waits on the network. See `services/search.ts` for why that's the right shape
// for a local control plane.

/**
 * The design system deliberately never imports `next/link` (it must stay usable
 * outside Next), so the app hands its own navigator to every link-ish item.
 */
const LINK_RENDER = { link: (props: CommandPaletteLinkProps) => <Link {...props} /> }

/** Result groups, in the order they're shown. Headings mirror the sidebar's wording. */
const KIND_GROUPS: { kind: SearchKind; heading: string; icon: ReactNode }[] = [
  { kind: "project", heading: "Projects", icon: <FolderGit2 /> },
  { kind: "worker", heading: "Workers", icon: <Container /> },
  { kind: "service", heading: "Services", icon: <Globe /> },
  { kind: "build", heading: "Builds", icon: <Layers /> },
  { kind: "secret", heading: "Secrets", icon: <KeyRound /> },
  { kind: "template", heading: "Templates", icon: <Rocket /> },
]

/** Static destinations — the sidebar's nav, reachable without leaving the keyboard. */
const PAGES: { href: string; label: string; icon: ReactNode; keywords: string[] }[] = [
  { href: "/projects", label: "Projects", icon: <FolderGit2 />, keywords: ["dashboard", "home"] },
  { href: "/resources", label: "Resources", icon: <Activity />, keywords: ["containers", "volumes", "images", "cpu", "memory"] },
  { href: "/secrets", label: "Global secrets", icon: <KeyRound />, keywords: ["env", "variables"] },
  { href: "/settings", label: "Settings", icon: <Settings />, keywords: ["git", "ssh", "dotfiles", "registry"] },
]

/** One search hit. `service` hits open the worker's own host; everything else is an in-app route. */
function HitItem({ hit, icon }: { hit: SearchHit; icon: ReactNode }) {
  const shared = {
    value: hit.id,
    label: hit.label,
    description: hit.description,
    meta: hit.meta,
    keywords: hit.keywords,
    icon,
  }

  // A worker's code-server / forwarded port lives on `worker-<id>.<host>`, a URL
  // only the browser can build — so it's a click that opens a tab, not a <Link>.
  if (hit.target) {
    const { workerId, port } = hit.target
    return (
      <CommandPaletteItem
        {...shared}
        onSelect={() =>
          window.open(workerBaseUrl(workerId, port !== undefined ? { port } : {}), "_blank", "noopener,noreferrer")
        }
      />
    )
  }
  return <CommandPaletteItem {...shared} href={hit.href} render={LINK_RENDER} />
}

export function CommandMenu() {
  const [open, setOpen] = useState(false)
  const { theme, setTheme } = useTheme()

  const { data, isLoading } = useQuery({
    queryKey: ["search-index"],
    queryFn: () => api.get<SearchIndex>("/api/search"),
    // Pulled only when the palette opens, and re-pulled on every open: a worker
    // that started or stopped in the meantime must show its real state. The
    // cached index keeps showing (no skeleton flash) while the refetch lands.
    enabled: open,
    staleTime: 0,
  })
  const hits = data?.hits ?? []
  const dark = theme === "dark"

  return (
    <>
      <CommandPaletteTrigger onClick={() => setOpen(true)}>Search…</CommandPaletteTrigger>

      <CommandPalette open={open} onOpenChange={setOpen} loading={isLoading} label="Command palette">
        <CommandPaletteInput placeholder="Search projects, workers, services…" escHint />
        <CommandPaletteList>
          <CommandPaletteEmpty>No results</CommandPaletteEmpty>
          <CommandPaletteLoading />

          <CommandPaletteGroup heading="Go to">
            {PAGES.map((p) => (
              <CommandPaletteItem
                key={p.href}
                value={`page:${p.href}`}
                label={p.label}
                icon={p.icon}
                keywords={p.keywords}
                href={p.href}
                render={LINK_RENDER}
              />
            ))}
          </CommandPaletteGroup>

          <CommandPaletteGroup heading="Actions">
            <CommandPaletteItem
              value="action:new-project"
              label="New project"
              icon={<Plus />}
              keywords={["create", "devcontainer", "spec"]}
              href="/projects/new"
              render={LINK_RENDER}
            />
            <CommandPaletteItem
              value="action:new-from-template"
              label="New project from template"
              icon={<Rocket />}
              keywords={["create", "starter", "stack", "scaffold"]}
              href="/projects/new-from-template"
              render={LINK_RENDER}
            />
            <CommandPaletteItem
              value="action:toggle-theme"
              label={dark ? "Switch to light theme" : "Switch to dark theme"}
              icon={dark ? <Sun /> : <Moon />}
              keywords={["theme", "dark", "light", "appearance"]}
              onSelect={() => setTheme(dark ? "light" : "dark")}
            />
          </CommandPaletteGroup>

          <CommandPaletteSeparator />

          {KIND_GROUPS.map(({ kind, heading, icon }) => (
            <CommandPaletteGroup key={kind} heading={heading}>
              {hits
                .filter((h) => h.kind === kind)
                .map((hit) => (
                  <HitItem key={hit.id} hit={hit} icon={icon} />
                ))}
            </CommandPaletteGroup>
          ))}
        </CommandPaletteList>

        {/* The design system's own hints are French; this app's UI is English. */}
        <CommandPaletteFooter hints={false} className="justify-start gap-3">
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            <span className="hidden sm:inline">navigate</span>
          </span>
          <span className="flex items-center gap-1">
            <Kbd>↵</Kbd> open
          </span>
          <span className="hidden items-center gap-1 sm:flex">
            <Kbd>esc</Kbd> close
          </span>
        </CommandPaletteFooter>
      </CommandPalette>
    </>
  )
}
