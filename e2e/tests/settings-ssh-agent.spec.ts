import { test, expect } from "@playwright/test"

// The SSH agent endpoint (lib/ssh-agent.ts): status of the selected key, unlock, lock. HTTP-only —
// it never selects a key (settings are one global row other specs read), so it only checks what
// holds whatever the key: the status shape and the validation of an unlock request. Unlocking a
// real passphrase-protected key inside a worker is `scripts/test-ssh-passphrase.sh` (real Docker).

test.describe("settings / ssh agent", () => {
  test("GET reports how workers authenticate", async ({ request }) => {
    const res = await request.get("/api/settings/ssh-agent")
    expect(res.status()).toBe(200)
    const status = await res.json()
    expect(typeof status.workerSocket).toBe("boolean")
    expect(typeof status.unlocked).toBe("boolean")
    expect(typeof status.usable).toBe("boolean")
    expect(typeof status.hostAgent.reachable).toBe("boolean")
    expect(status.key === null || typeof status.key.encrypted === "boolean").toBe(true)
  })

  test("POST rejects an empty passphrase", async ({ request }) => {
    const res = await request.post("/api/settings/ssh-agent", { data: { passphrase: "" } })
    expect(res.status()).toBe(400)
  })

  test("POST rejects a body without passphrase", async ({ request }) => {
    const res = await request.post("/api/settings/ssh-agent", { data: {} })
    expect(res.status()).toBe(400)
  })

  test("DELETE (lock) is always safe and returns the status", async ({ request }) => {
    const res = await request.delete("/api/settings/ssh-agent")
    expect(res.status()).toBe(200)
    expect((await res.json()).unlocked).toBe(false)
  })
})
