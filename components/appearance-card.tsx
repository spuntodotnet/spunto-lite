"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "@spunto/design-system"
import { CheckIcon, PaletteIcon } from "lucide-react"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import {
  DEFAULT_DASHBOARD_COLOR,
  PALETTES,
  PRODUCT_COLORS,
  dashboardColorAttrs,
  wearDashboardColor,
} from "@/lib/appearance"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

/**
 * Settings → Appearance: the dashboard's colour (lib/appearance.ts) — Spunto Cloud's
 * `accent-picker-card.tsx`, plus the design system's 50 palettes. Saved on click, outside the
 * settings form: the pick is put on the page at once, then saved, then the server layout re-renders
 * with it (`router.refresh()`), so the next full load arrives in it too. A failed save puts the
 * previous colour back.
 *
 * Every swatch wears its own colour (`data-product` / `data-palette` on the swatch itself), whatever
 * the page is dressed in: the same `bg-field` + `bg-primary` read through the swatch's own cascade.
 */
export function AppearanceCard({ initial }: { initial?: string | null }) {
  const qc = useQueryClient()
  const router = useRouter()
  // What was picked here, ahead of the settings query; until then, what the query says.
  const [picked, setSelected] = useState<string | null>(null)
  const selected = picked ?? initial ?? DEFAULT_DASHBOARD_COLOR
  const [saving, setSaving] = useState(false)

  async function pick(id: string) {
    if (id === selected || saving) return
    const previous = selected
    setSelected(id)
    wearDashboardColor(id)
    setSaving(true)
    try {
      // Lite's own blue is stored as "nothing picked", so a later default change reaches it.
      await api.patch("/api/settings", { dashboardColor: id === DEFAULT_DASHBOARD_COLOR ? null : id })
      qc.invalidateQueries({ queryKey: ["settings"] })
      router.refresh()
    } catch (e) {
      setSelected(previous)
      wearDashboardColor(previous)
      toast.error(`Couldn't save your colour — ${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  const selectedPalette = dashboardColorAttrs(selected).palette
  const selectedName = selectedPalette
    ? PALETTES.find((p) => p.id === selectedPalette)?.name
    : PRODUCT_COLORS.find((c) => c.id === selected)?.label

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <PaletteIcon className="size-4" /> Appearance
        </CardTitle>
        <CardDescription>
          The colour of the dashboard — buttons, links, focus rings, the sidebar, the charts. Saved as soon as you
          pick one; workers and their IDE are not affected.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div role="radiogroup" aria-label="Dashboard colour" className="grid grid-cols-4 gap-2 sm:grid-cols-7">
          {PRODUCT_COLORS.map((c) => {
            const active = c.id === selected
            return (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => pick(c.id)}
                data-product={c.product}
                className={cn(
                  "flex flex-col items-center gap-1.5 rounded-md border p-2 text-xs transition-colors hover:bg-muted/60",
                  active && "border-primary bg-accent text-accent-foreground",
                )}
              >
                <Swatch active={active} size="lg" />
                {c.label}
                {c.id === DEFAULT_DASHBOARD_COLOR && <span className="-mt-1 text-[10px] text-muted-foreground">default</span>}
              </button>
            )
          })}
        </div>

        <div className="space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-xs font-medium text-muted-foreground">Palettes</p>
            {selectedPalette && <p className="text-xs text-muted-foreground">{selectedName}</p>}
          </div>
          {/* Ordered as the design system lists them: each field hue, « ton sur ton » then contrast. */}
          <div role="radiogroup" aria-label="Dashboard palette" className="grid grid-cols-10 gap-1.5">
            {PALETTES.map((p) => {
              const active = p.id === selected
              return (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={p.name}
                  title={p.name}
                  onClick={() => pick(p.id)}
                  data-palette={p.id}
                  className={cn(
                    "flex items-center justify-center rounded-md border border-transparent p-1 transition-colors hover:bg-muted/60",
                    active && "border-primary bg-accent",
                  )}
                >
                  <Swatch active={active} />
                </button>
              )
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * The field on the left; on the right, the light theme's primary over the signal — the signal is
 * what tells a palette's « ton sur ton » from its contrast twin, which share field and primary.
 * Picked: a check on the primary, in its own foreground.
 */
function Swatch({ active, size = "sm" }: { active: boolean; size?: "sm" | "lg" }) {
  return (
    <span
      className={cn(
        "relative flex items-center justify-center overflow-hidden rounded-full bg-field ring-1 ring-black/5",
        size === "lg" ? "size-8" : "size-6",
      )}
    >
      <span className="absolute top-0 right-0 h-1/2 w-1/2 bg-primary" />
      <span className="absolute bottom-0 right-0 h-1/2 w-1/2 bg-signal" />
      {active && (
        <span className="relative flex items-center justify-center rounded-full bg-primary p-0.5 text-primary-foreground ring-1 ring-primary-foreground/60">
          <CheckIcon className={size === "lg" ? "size-3.5" : "size-2.5"} />
        </span>
      )}
    </span>
  )
}
