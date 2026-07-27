/** Central place for env-derived config, with local-friendly defaults. */

export const DATA_DIR = process.env.DATA_DIR || "./data"
export const DB_PATH = process.env.DB_PATH || `${DATA_DIR}/spunto-lite.db`

/** AES-256-GCM key material for secrets. Generated on first run if unset (dev only). */
export const DATA_ENCRYPTION_KEY = process.env.DATA_ENCRYPTION_KEY || "spunto-lite-dev-insecure-key"

/** Base host for worker subdomains. Workers are reachable at worker-<slug>.<BASE_DOMAIN>. */
export const BASE_DOMAIN = process.env.BASE_DOMAIN || "localhost"

/** Host directory (inside the control-plane container) where the user's SSH keys are mounted. */
export const HOST_SSH_DIR = process.env.HOST_SSH_DIR || "/host-ssh"

/** Port the custom server listens on (serves app + reverse-proxies workers). */
export const PORT = Number(process.env.PORT || 80)

/**
 * Extension registry the "VS Code extensions" picker searches. It must stay the
 * registry code-server installs from (Open VSX by default) so that "findable in
 * the UI" implies "installable in the worker" — see lib/open-vsx.ts.
 */
export const OPEN_VSX_API = (process.env.OPEN_VSX_API || "https://open-vsx.org/api").replace(/\/+$/, "")
