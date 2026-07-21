"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Flame, FolderGit2, Settings, KeyRound } from "lucide-react"
import { cn } from "@/lib/utils"

const NAV = [
  { href: "/projects", label: "Projects", icon: FolderGit2 },
  { href: "/secrets", label: "Global secrets", icon: KeyRound },
  { href: "/settings", label: "Settings", icon: Settings },
]

export function AppSidebar() {
  const pathname = usePathname()
  return (
    <aside className="w-56 shrink-0 border-r border-border bg-sidebar flex flex-col">
      <Link href="/" className="flex items-center gap-2 px-4 h-14 border-b border-border">
        <div className="inline-flex items-center justify-center size-7 rounded-md bg-primary text-primary-foreground">
          <Flame className="size-4" />
        </div>
        <span className="font-[family-name:var(--font-syne)] font-bold tracking-tight">Spunto Lite</span>
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
