import { eq } from "drizzle-orm"
import { db } from "../db/index"
import { settings, type Settings } from "../db/schema"

const SINGLETON = "singleton"

export function getSettings(): Settings {
  const row = db.select().from(settings).where(eq(settings.id, SINGLETON)).get()
  if (row) return row
  const fresh: Settings = { id: SINGLETON, gitUserName: null, gitUserEmail: null, sshKeyPath: null, dotfilesRepo: null }
  db.insert(settings).values(fresh).run()
  return fresh
}

export function updateSettings(patch: Partial<Omit<Settings, "id">>): Settings {
  getSettings() // ensure the row exists
  db.update(settings).set(patch).where(eq(settings.id, SINGLETON)).run()
  return getSettings()
}
