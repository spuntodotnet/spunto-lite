import { AppSidebar } from "@/components/app-sidebar"
import { CommandMenu } from "@/components/command-menu"
import { ThemeToggle } from "@/components/theme-toggle"

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <AppSidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 border-b border-border flex items-center px-4 gap-3">
          {/* The ⌘K trigger doubles as the header's search field; the shortcut itself
              is bound on `document` by the palette, so it works from anywhere. */}
          <div className="flex-1 max-w-sm min-w-0">
            <CommandMenu />
          </div>
          <div className="flex-1" />
          <ThemeToggle />
        </header>
        <main className="flex-1 min-w-0">{children}</main>
      </div>
    </div>
  )
}
