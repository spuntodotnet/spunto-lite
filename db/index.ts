import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import Database from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { migrate } from "drizzle-orm/better-sqlite3/migrator"
import { DB_PATH } from "../lib/env"
import * as schema from "./schema"

mkdirSync(dirname(DB_PATH), { recursive: true })

const sqlite = new Database(DB_PATH)
sqlite.pragma("journal_mode = WAL")
sqlite.pragma("foreign_keys = ON")

export const db = drizzle(sqlite, { schema })

let migrated = false
/** Applies pending SQL migrations from ./drizzle. Idempotent, called once at boot. */
export function runMigrations() {
  if (migrated) return
  migrate(db, { migrationsFolder: "./drizzle" })
  migrated = true
}

export { schema }
