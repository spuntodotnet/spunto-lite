"use client"

import { useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "@spunto/design-system"
import { Plus, Trash2, KeyRound } from "lucide-react"
import { api } from "@/lib/api"
import type { SecretMeta } from "@/lib/types"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"

/** Reusable write-only secrets manager for a given endpoint (project or global). */
export function SecretsCard({
  title,
  description,
  basePath,
  queryKey,
}: {
  title: string
  description: string
  basePath: string // e.g. /api/projects/:id/secrets or /api/secrets
  queryKey: string[]
}) {
  const qc = useQueryClient()
  const { data: secrets = [] } = useQuery({ queryKey, queryFn: () => api.get<SecretMeta[]>(basePath) })
  const [name, setName] = useState("")
  const [value, setValue] = useState("")

  const add = useMutation({
    mutationFn: () => api.post(basePath, { name, value }),
    onSuccess: () => {
      setName("")
      setValue("")
      qc.invalidateQueries({ queryKey })
      toast.success("Secret saved")
    },
    onError: (e) => toast.error((e as Error).message),
  })
  const del = useMutation({
    mutationFn: (id: string) => api.del(`${basePath}/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey }),
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <KeyRound className="size-4" /> {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {secrets.length > 0 && (
          <div className="space-y-1.5">
            {secrets.map((s) => (
              <div key={s.id} className="flex items-center justify-between rounded-md border border-border px-3 py-1.5">
                <span className="font-mono text-xs">{s.name}</span>
                <Button variant="ghost" size="icon" className="size-7" onClick={() => del.mutate(s.id)}>
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <Input
            className="h-8 font-mono text-xs"
            placeholder="UPPER_SNAKE_CASE"
            value={name}
            onChange={(e) => setName(e.target.value.toUpperCase())}
          />
          <Input
            className="h-8 font-mono text-xs"
            type="password"
            placeholder="value"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <Button size="sm" onClick={() => add.mutate()} disabled={!name || !value || add.isPending}>
            <Plus /> Add
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
