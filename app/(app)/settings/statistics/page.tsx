import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import { Statistics } from "@/components/statistics"

/** Settings → Statistics: how long workers take to be usable, and where the time goes. */
export default function StatisticsPage() {
  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div>
        <Link href="/settings" className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3" /> Settings
        </Link>
        <h1 className="font-display text-2xl tracking-tight">Statistics</h1>
        <p className="mt-1 text-sm text-muted-foreground">How long your workers take to be usable, and where that time goes — measured on this machine, kept by Lite.</p>
      </div>
      <Statistics />
    </div>
  )
}
