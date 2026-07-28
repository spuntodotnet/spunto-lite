import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import Database from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { migrate } from "drizzle-orm/better-sqlite3/migrator"
import { DB_PATH } from "../lib/env"
import * as schema from "./schema"

type Db = ReturnType<typeof open>

function open() {
  mkdirSync(dirname(DB_PATH), { recursive: true })
  const sqlite = new Database(DB_PATH)
  sqlite.pragma("journal_mode = WAL")
  sqlite.pragma("foreign_keys = ON")
  return drizzle(sqlite, { schema })
}

let connection: Db | undefined
function connect(): Db {
  connection ??= open()
  return connection
}

/**
 * La connexion s'ouvre au premier **accès**, pas à l'import du module.
 *
 * Why: `next build` évalue chaque module de route dans plusieurs workers en
 * parallèle pour en collecter la configuration. Ouvrir la base ici, au niveau du
 * module, faisait donc que N process convertissaient la même base neuve en WAL en
 * même temps — le perdant attendait son busy timeout (5 s) puis levait
 * `SQLITE_BUSY: database is locked`, et le build échouait sur une route au hasard
 * (`Failed to collect page data for /api/projects/[id]/builds`). C'était d'autant
 * plus probable que la machine était lente : le build amd64 émulé sous QEMU de la
 * CI multi-arch tombait dessus alors que l'arm64 natif passait.
 *
 * En différant l'ouverture, un build ne touche plus jamais la base : il n'y a plus
 * de course, et l'image ne contient plus une base vide créée au moment du build.
 */
export const db = new Proxy({} as Db, {
  get(_target, property) {
    const real = connect() as unknown as Record<string | symbol, unknown>
    const value = real[property]
    // Lié à la vraie instance : sans ça `this` vaudrait le Proxy dans les méthodes de drizzle.
    return typeof value === "function" ? value.bind(real) : value
  },
})

let migrated = false
/** Applies pending SQL migrations from ./drizzle. Idempotent, called once at boot. */
export function runMigrations() {
  if (migrated) return
  migrate(db, { migrationsFolder: "./drizzle" })
  migrated = true
}

export { schema }
