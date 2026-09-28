"use client"

import { useEffect, useState } from "react"

const MOBILE_BREAKPOINT = 768

/** Below `md`: the cockpit switches to its own phone layout rather than a squeezed desktop one. */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false)
  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => setIsMobile(mql.matches)
    onChange()
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [])
  return isMobile
}
