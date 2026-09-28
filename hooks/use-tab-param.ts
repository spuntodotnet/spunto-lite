"use client"

import { useCallback, useState } from "react"
import { usePathname, useSearchParams } from "next/navigation"

/**
 * Tab state that survives a page refresh by persisting the active tab in the URL
 * (`?tab=...` by default). Reading the initial value from the URL means a hard
 * refresh — or a shared/bookmarked link — lands back on the same tab instead of
 * always resetting to the default.
 *
 * The URL is updated with `history.replaceState` (not the Next router) so that
 * switching tabs doesn't add history entries, doesn't refetch server data, and
 * doesn't reset scroll — it's a client-side view toggle, not a navigation.
 */
export function useTabParam<T extends string>(
  validTabs: readonly T[],
  defaultTab: T,
  paramKey = "tab",
): [T, (tab: T) => void] {
  const searchParams = useSearchParams()
  const pathname = usePathname()

  const [activeTab, setActiveTabState] = useState<T>(() => {
    const fromUrl = searchParams.get(paramKey)
    return fromUrl && validTabs.includes(fromUrl as T) ? (fromUrl as T) : defaultTab
  })

  const setActiveTab = useCallback(
    (tab: T) => {
      setActiveTabState(tab)
      const params = new URLSearchParams(window.location.search)
      if (tab === defaultTab) params.delete(paramKey)
      else params.set(paramKey, tab)
      const query = params.toString()
      window.history.replaceState(null, "", query ? `${pathname}?${query}` : pathname)
    },
    [pathname, paramKey, defaultTab],
  )

  return [activeTab, setActiveTab]
}
