"use client"

import { Menu as MenuPrimitive } from "@base-ui/react/menu"
import { cn } from "@/lib/utils"

/**
 * Dropdown menu, on Base UI — the `⋯` menus of the cards and tables.
 *
 * Exists for one reason: the popup is **portalled out of the DOM**. The design
 * system's `WorkerCard` (like every card here) is `overflow-hidden` — it has to
 * be, that's what clips its inner bands to the rounded border. A menu drawn as
 * an absolutely-positioned child of the card is inside that clip, so it gets cut
 * off at the card's edge. Portalled, it's a sibling of `<body>` and simply
 * floats above everything, and Base UI's positioner flips/shifts it when the
 * card sits near the bottom or the right of the viewport.
 *
 * Not in `@spunto/design-system` (yet): the package exports no menu primitive,
 * and its `useOverlayContainer` portal target is internal. Base UI's default
 * target is `document.body`, which is fine here — `next-themes` puts `.dark` on
 * `<html>`, so the tokens cascade to portalled content anyway.
 */
function Menu(props: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="menu" {...props} />
}

/** The button that opens the menu. Use `render` to keep your own trigger element. */
function MenuTrigger({ className, ...props }: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="menu-trigger" className={className} {...props} />
}

/** Portal + positioned popup. Wraps `MenuItem`/`MenuLinkItem` children. */
function MenuContent({
  className,
  children,
  side = "bottom",
  align = "end",
  sideOffset = 4,
  ...props
}: MenuPrimitive.Popup.Props & Pick<MenuPrimitive.Positioner.Props, "side" | "align" | "sideOffset">) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        data-slot="menu-positioner"
        className="z-50 outline-none"
        side={side}
        align={align}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          data-slot="menu-content"
          className={cn(
            "max-h-[var(--available-height)] min-w-52 overflow-y-auto overscroll-contain rounded-lg border border-border bg-popover p-1 text-xs text-popover-foreground shadow-lg shadow-black/[0.06] outline-none",
            "origin-[var(--transform-origin)] transition-[transform,opacity] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0",
            className,
          )}
          {...props}
        >
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

// `data-highlighted` rather than `hover:` — it covers the pointer *and* the
// keyboard, so arrowing through the menu highlights like hovering does.
const ITEM_CLASS =
  "flex cursor-default select-none items-center gap-2 rounded-md px-3 py-2 outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50"

/** An action. Closes the menu on click. */
function MenuItem({ className, ...props }: MenuPrimitive.Item.Props) {
  return <MenuPrimitive.Item data-slot="menu-item" className={cn(ITEM_CLASS, className)} {...props} />
}

/** A destructive action — same shape, red. */
function MenuItemDestructive({ className, ...props }: MenuPrimitive.Item.Props) {
  return (
    <MenuPrimitive.Item
      data-slot="menu-item"
      className={cn(ITEM_CLASS, "text-destructive data-highlighted:bg-destructive/10 data-highlighted:text-destructive", className)}
      {...props}
    />
  )
}

/** A navigation entry — renders an `<a>`. `closeOnClick` defaults to false in Base UI. */
function MenuLinkItem({ className, ...props }: MenuPrimitive.LinkItem.Props) {
  return <MenuPrimitive.LinkItem data-slot="menu-link-item" className={cn(ITEM_CLASS, className)} {...props} />
}

function MenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return <MenuPrimitive.Separator data-slot="menu-separator" className={cn("-mx-1 my-1 h-px bg-border/60", className)} {...props} />
}

export { Menu, MenuTrigger, MenuContent, MenuItem, MenuItemDestructive, MenuLinkItem, MenuSeparator }
