import { parentPort } from "node:worker_threads"
import { usageReport, type UsagePeriod } from "./usage"

/**
 * The thread `services/usage-runner.ts` computes the Usage report on. `better-sqlite3` is
 * synchronous: on the server's own thread, the seconds the report takes on a large `task_events`
 * were seconds every other request — the whole app — waited. Here it has its own connection
 * (WAL: reads alongside the server's writes) and blocks nothing but itself.
 */
parentPort!.on("message", (job: { id: number; days: UsagePeriod; timeZone: string }) => {
  try {
    parentPort!.postMessage({ id: job.id, report: usageReport(job.days, job.timeZone) })
  } catch (err) {
    parentPort!.postMessage({ id: job.id, error: err instanceof Error ? err.message : String(err) })
  }
})
