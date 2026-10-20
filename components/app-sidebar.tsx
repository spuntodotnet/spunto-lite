"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { FolderGit2, Server, Settings, KeyRound, Activity, MessagesSquare } from "lucide-react"
import { SpuntoLogo } from "@spunto/design-system/brand"
import { cn } from "@/lib/utils"

const NAV = [
  { href: "/projects", label: "Projects", icon: FolderGit2 },
  // Delegated work across every project: what the agents are doing, and which one needs you.
  { href: "/agents", label: "Agents", icon: MessagesSquare },
  // Shared services: long-lived dependencies (Postgres, Elasticsearch…) mutualised
  // across every project's workers — a sibling of Projects, not a sub-page of one.
  { href: "/services", label: "Services", icon: Server },
  { href: "/resources", label: "Resources", icon: Activity },
  { href: "/secrets", label: "Global secrets", icon: KeyRound },
  { href: "/settings", label: "Settings", icon: Settings },
]

export function AppSidebar() {
  const pathname = usePathname()
  return (
    <aside className="w-56 shrink-0 border-r border-border bg-sidebar flex flex-col">
      <Link href="/" className="flex items-center gap-2 px-4 h-14 border-b border-border">
        {/* The Spunto logo in Lite's declension (sky tile, ink blue) — the one the site shows for Lite. */}
        <SpuntoLogo tone="build" size={28} className="rounded-[4px]" />
        <span className="font-display tracking-tight">Spunto Lite</span>
      </Link>
      <nav className="flex-1 p-2 space-y-1">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(href + "/")
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
              )}
            >
              <Icon className="size-4" /> {label}
            </Link>
          )
        })}
      </nav>
      <div className="p-3 text-xs text-muted-foreground border-t border-border">
        Local control plane · <span className="font-mono">Docker</span>
      </div>
    </aside>
  )
}
