"use client"

import type { ComponentType, ReactNode } from "react"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
} from "@spunto/design-system"

/**
 * The "are you sure" half of an action, controlled by the caller.
 *
 * Purely presentational: it never runs the mutation. `onConfirm` does, and the
 * dialog closes the moment it fires — deliberately, because the feedback already
 * lives where the action does (the row disappears, the rebuild banner spins, a
 * failure raises a toast). Holding it open on a spinner would mean every caller
 * threading a close through its mutation's `onSettled` for nothing visible.
 *
 * `DeleteProjectDialog` stays hand-written beside this one: it gates on a
 * checkbox and owns its own mutation. This is for the plain confirmation — which
 * is every `confirm()` the worker surfaces used to call.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  icon: Icon,
  destructive = false,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description: ReactNode
  confirmLabel: string
  /** Leading icon of the confirm button. */
  icon?: ComponentType<{ className?: string }>
  destructive?: boolean
  onConfirm: () => void
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            onClick={() => {
              onOpenChange(false)
              onConfirm()
            }}
          >
            {Icon && <Icon />}
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
