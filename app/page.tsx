import Link from "next/link"
import { Flame, FolderGit2, TerminalSquare } from "lucide-react"

export default function Home() {
  return (
    <main className="min-h-screen dot-grid flex items-center justify-center px-6">
      <div className="max-w-xl w-full text-center">
        <div className="inline-flex items-center justify-center size-14 rounded-xl bg-primary text-primary-foreground mb-6">
          <Flame className="size-7" />
        </div>
        <h1 className="font-[family-name:var(--font-syne)] text-4xl font-bold tracking-tight">
          Spunto&nbsp;Lite
        </h1>
        <p className="mt-3 text-muted-foreground">
          Ton control plane de dev local. Crée des projets, lance des conteneurs Docker
          avec VS Code, terminal, hooks et secrets — le tout sur ta machine.
        </p>
        <div className="mt-8 flex items-center justify-center gap-3">
          <Link
            href="/projects"
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90 transition"
          >
            <FolderGit2 className="size-4" /> Mes projets
          </Link>
          <Link
            href="/settings"
            className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2.5 text-sm font-medium hover:bg-accent transition"
          >
            <TerminalSquare className="size-4" /> Réglages
          </Link>
        </div>
      </div>
    </main>
  )
}
