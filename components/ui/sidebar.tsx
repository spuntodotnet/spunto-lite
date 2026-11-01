"use client"

import * as React from "react"
import { usePathname } from "next/navigation"
import { SidebarProvider as DsSidebarProvider } from "@spunto/design-system"

// The sidebar lives in the design system; this file only adds what it can't know — the router.
// On mobile the sheet closes when the pathname changes.
export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "@spunto/design-system"

export function SidebarProvider(props: React.ComponentProps<typeof DsSidebarProvider>) {
  return <DsSidebarProvider mobileCloseKey={usePathname()} {...props} />
}
