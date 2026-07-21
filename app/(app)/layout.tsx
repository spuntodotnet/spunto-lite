import { AppSidebar } from "@/components/app-sidebar"
import { ThemeToggle } from "@/components/theme-toggle"

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <AppSidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 border-b border-border flex items-center justify-end px-4 gap-2">
          <ThemeToggle />
        </header>
        <main className="flex-1 min-w-0">{children}</main>
      </div>
    </div>
  )
}
