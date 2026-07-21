"use client"

import { SecretsCard } from "@/components/secrets-card"

export default function GlobalSecretsPage() {
  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="font-[family-name:var(--font-syne)] text-2xl font-bold tracking-tight">Global secrets</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Injected into every worker of every project. Overridden by project-level secrets of the same name.
        </p>
      </div>
      <SecretsCard
        title="Global secrets"
        description="Available to all workers as environment variables."
        basePath="/api/secrets"
        queryKey={["global-secrets"]}
      />
    </div>
  )
}
