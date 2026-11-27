"use client"

import { useState } from "react"
import type { GitRepoOption } from "@spunto/design-system/projects"
import { Lock, Search } from "lucide-react"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"

/** How many matches the list shows at once: past that, typing narrows faster than scrolling. */
const SHOWN = 8

/**
 * The repository field of a row picked from a connected forge — the package's `renderRepoField`
 * slot (RepoList), in place of its `<datalist>` fallback, which cannot say which forge a match is
 * on nor that it is private. A text field and the matches under it, by substring, keyboard
 * included. Picking hands the option back; the form turns the row into its clone URL.
 */
export function RepositoryPickerField({
  id,
  value,
  onChange,
  options,
  placeholder,
  sourceLabel,
}: {
  id: string
  value: string
  onChange: (value: string, option?: GitRepoOption) => void
  options: GitRepoOption[]
  placeholder: string
  /** The forge and host an option is listed by — shown when more than one is connected. */
  sourceLabel: (option: GitRepoOption) => string | null
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const query = value.trim().toLowerCase()
  const matches = options.filter((o) => o.fullName.toLowerCase().includes(query)).slice(0, SHOWN)
  const pick = (option: GitRepoOption) => {
    onChange(option.fullName, option)
    setOpen(false)
  }

  return (
    <div className="relative">
      <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        id={`repo-picker-${id}`}
        className="pl-8 font-mono text-xs"
        placeholder={placeholder}
        value={value}
        autoComplete="off"
        role="combobox"
        aria-expanded={open && matches.length > 0}
        aria-controls={`repo-picker-${id}-list`}
        aria-label="Repository"
        onFocus={() => setOpen(true)}
        // Late enough for a click on a match to land first.
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onChange={(e) => {
          onChange(e.target.value)
          setActive(0)
          setOpen(true)
        }}
        onKeyDown={(e) => {
          if (!open || matches.length === 0) return
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault()
            setActive((i) => (i + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length)
          } else if (e.key === "Enter") {
            e.preventDefault()
            pick(matches[Math.min(active, matches.length - 1)])
          } else if (e.key === "Escape") {
            setOpen(false)
          }
        }}
      />
      {open && matches.length > 0 && (
        <ul
          id={`repo-picker-${id}-list`}
          role="listbox"
          className="absolute z-20 mt-1 max-h-72 w-full min-w-[18rem] overflow-auto rounded-md border border-border bg-popover p-1 shadow-md"
        >
          {matches.map((o, i) => (
            <li
              key={`${o.provider}:${o.fullName}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault()
                pick(o)
              }}
              onMouseEnter={() => setActive(i)}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs",
                i === active && "bg-accent text-accent-foreground",
              )}
            >
              <span className="min-w-0 flex-1 truncate font-mono">{o.fullName}</span>
              {o.private && <Lock className="size-3 shrink-0 text-muted-foreground" aria-label="private" />}
              {sourceLabel(o) && <span className="shrink-0 text-[10px] text-muted-foreground">{sourceLabel(o)}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
