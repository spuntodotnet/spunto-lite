import { expect, type APIRequestContext } from "@playwright/test"

/**
 * `GET /api/usage` answers at once with the last report, computed in the background
 * (services/usage-runner.ts): polls until there is one — with `fresh`, one made after this call,
 * that counts what just happened (a recent one is otherwise served for up to 30 s) — and returns it.
 */
export async function usageReport(request: APIRequestContext, query: string, { fresh = false, timeout = 90_000 } = {}) {
  const since = fresh ? Date.now() : 0
  let snapshot: { report: Record<string, any> | null; computedAt: string | null; computing: boolean; error: string | null } | undefined
  await expect
    .poll(
      async () => {
        const res = await request.get(`/api/usage?${query}`)
        expect(res.status()).toBe(200)
        snapshot = await res.json()
        expect(snapshot!.error).toBeNull()
        return !!snapshot!.report && Date.parse(snapshot!.computedAt!) >= since
      },
      { timeout, intervals: [250, 500, 1000] },
    )
    .toBe(true)
  return snapshot!.report!
}
