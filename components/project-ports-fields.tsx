"use client"

import { Input } from "@/components/ui/input"
import { PORT_LABEL_MAX, PORT_PATH_MAX, type PortAttributes, type PortsAttributes } from "@/lib/ports"

/**
 * Under the project form's port list: what each port *is* (devcontainer `portsAttributes`) — a
 * label shown in a task's Machine panel instead of the bare number, and the path a click on it
 * lands on. Ported from Spunto Cloud (`project-ports-section.tsx`, aae05edf).
 *
 * Rendered through the form's `extras.ports` slot: the ports themselves stay the package's field;
 * this only adds a row per declared port. A port removed from the list keeps no attributes
 * (`cleanPortsAttributes`, on save and in the API).
 */
export function ProjectPortsAttributesFields({
  ports,
  value,
  onChange,
}: {
  ports: number[]
  value: PortsAttributes
  onChange: (next: PortsAttributes) => void
}) {
  const declared = ports.filter((n) => Number.isInteger(n) && n > 0 && n < 65536)
  if (!declared.length) {
    return (
      <p className="mt-3 text-xs text-muted-foreground">
        Every port that listens in a worker is reachable without being declared. Declare one to give it a name and a
        landing path — it then shows in a task&apos;s Machine panel even while nothing listens on it, greyed.
      </p>
    )
  }
  const set = (port: number, key: keyof PortAttributes, v: string) => {
    const current = value[String(port)] ?? {}
    onChange({ ...value, [String(port)]: { ...current, [key]: v } })
  }
  return (
    <div className="mt-3 space-y-2">
      <p className="text-xs text-muted-foreground">
        Name each port and choose where a click on it lands — shown in a task&apos;s Machine panel, green while
        something listens, greyed while nothing does.
      </p>
      <div className="grid grid-cols-[4.5rem_1fr_1fr] items-center gap-2 text-xs">
        <span className="font-medium text-muted-foreground">Port</span>
        <span className="font-medium text-muted-foreground">Label</span>
        <span className="font-medium text-muted-foreground">Opens at</span>
        {declared.map((port) => (
          <PortRow key={port} port={port} attrs={value[String(port)] ?? {}} onChange={(k, v) => set(port, k, v)} />
        ))}
      </div>
    </div>
  )
}

function PortRow({ port, attrs, onChange }: { port: number; attrs: PortAttributes; onChange: (key: keyof PortAttributes, v: string) => void }) {
  // A path is kept only if it starts with `/` (`cleanPortsAttributes`): said while typing, not on save.
  const badPath = !!attrs.path && !attrs.path.startsWith("/")
  return (
    <>
      <span className="font-mono text-sm">:{port}</span>
      <Input
        aria-label={`Label for port ${port}`}
        placeholder={port === 3000 ? "App" : "Label"}
        maxLength={PORT_LABEL_MAX}
        className="h-8 text-xs"
        value={attrs.label ?? ""}
        onChange={(e) => onChange("label", e.target.value)}
      />
      <Input
        aria-label={`Default path for port ${port}`}
        aria-invalid={badPath || undefined}
        title={badPath ? "A path starts with /" : undefined}
        placeholder="/"
        maxLength={PORT_PATH_MAX}
        className={badPath ? "h-8 border-destructive font-mono text-xs" : "h-8 font-mono text-xs"}
        value={attrs.path ?? ""}
        onChange={(e) => onChange("path", e.target.value)}
      />
    </>
  )
}
