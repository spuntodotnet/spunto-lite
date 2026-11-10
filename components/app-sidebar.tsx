"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { FolderGit2, Server, Settings, KeyRound, Activity, MessagesSquare, Gauge } from "lucide-react"
import { SidebarBrand } from "@spunto/design-system"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"

const NAV = [
  { href: "/projects", label: "Projects", icon: FolderGit2 },
  // Delegated work across every project: what the agents are doing, and which one needs you.
  { href: "/agents", label: "Agents", icon: MessagesSquare },
  // What those agents consumed — cost, tokens, tools — read from their sessions' events.
  { href: "/usage", label: "Usage", icon: Gauge },
  // Shared services: long-lived dependencies (Postgres, Elasticsearch…) mutualised
  // across every project's workers — a sibling of Projects, not a sub-page of one.
  { href: "/services", label: "Services", icon: Server },
  { href: "/resources", label: "Resources", icon: Activity },
  { href: "/secrets", label: "Global secrets", icon: KeyRound },
  { href: "/settings", label: "Settings", icon: Settings },
]

// Lite is a single-user local app: no organisation to switch, no account to sign out of — so the
// design system's brand and nav only, without the org switcher or the user menu.
export function AppSidebar() {
  const pathname = usePathname()
  return (
    <Sidebar className="border-sidebar-border">
      <SidebarHeader className="border-b border-sidebar-border px-2 pt-3 pb-2">
        <SidebarBrand product="Lite" href="/" render={({ href }) => <Link href={href} />} />
      </SidebarHeader>
      <SidebarContent className="py-3">
        <SidebarGroup className="px-2">
          <SidebarMenu>
            {NAV.map(({ href, label, icon: Icon }) => (
              <SidebarMenuItem key={href}>
                <SidebarMenuButton
                  isActive={pathname === href || pathname.startsWith(href + "/")}
                  render={<Link href={href} />}
                  className="font-medium"
                >
                  <Icon className="size-4" /> {label}
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border p-3 text-xs text-muted-foreground">
        <p>
          Local control plane · <span className="font-mono">Docker</span>
        </p>
      </SidebarFooter>
    </Sidebar>
  )
}
