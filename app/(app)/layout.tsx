import { AppSidebar } from "@/components/app-sidebar"
import { CommandMenu } from "@/components/command-menu"
import { ThemeToggle } from "@/components/theme-toggle"
import { SshKeyLockedBanner } from "@/components/ssh-key-unlock"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <header className="h-14 border-b border-border flex items-center px-4 gap-3">
          <SidebarTrigger className="-ml-1" />
          {/* The ⌘K trigger doubles as the header's search field; the shortcut itself
              is bound on `document` by the palette, so it works from anywhere. */}
          <div className="flex-1 max-w-sm min-w-0">
            <CommandMenu />
          </div>
          <div className="flex-1" />
          <ThemeToggle />
        </header>
        <SshKeyLockedBanner />
        <main className="flex-1 min-w-0">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  )
}
