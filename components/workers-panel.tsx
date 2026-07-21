"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Container } from "lucide-react"

// Placeholder — Phase 2 wires this to the container lifecycle (spawn/stop/logs).
export function WorkersPanel({ projectId: _projectId, projectVersion: _v }: { projectId: string; projectVersion: number }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Container className="size-4" /> Workers
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">Container lifecycle (spawn / VS Code / terminal) arrives in Phase 2.</p>
      </CardContent>
    </Card>
  )
}
