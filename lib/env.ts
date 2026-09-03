/** Central place for env-derived config, with local-friendly defaults. */

export const DATA_DIR = process.env.DATA_DIR || "./data"
export const DB_PATH = process.env.DB_PATH || `${DATA_DIR}/spunto-lite.db`

/** AES-256-GCM key material for secrets. Generated on first run if unset (dev only). */
export const DATA_ENCRYPTION_KEY = process.env.DATA_ENCRYPTION_KEY || "spunto-lite-dev-insecure-key"

/**
 * Base host(s) for worker/service subdomains — workers are reachable at
 * `worker-<slug>.<BASE_DOMAIN>`.
 *
 * Comma-separated, because one deployment legitimately answers on several: the
 * host browser reaches the stack over `*.localhost` (which every modern browser
 * resolves to 127.0.0.1 on its own), while containers on the compose network —
 * `browser-remote`, the e2e runner — reach it over a real wildcard domain served
 * by the local CoreDNS (see `docs/local-domain.md`). Both must be accepted by the
 * reverse proxy or one of the two audiences loses worker URLs.
 *
 * `BASE_DOMAINS` is what the proxy matches against; `BASE_DOMAIN` is the *canonical*
 * one (first entry) — used for the boot log and for the `BASE_DOMAIN` handed to each
 * worker, which needs a single value for code-server's `VSCODE_PROXY_URI`.
 */
export const BASE_DOMAINS: string[] = (process.env.BASE_DOMAIN || "localhost")
  .split(",")
  .map((d) => d.trim().replace(/^\.+|\.+$/g, "").toLowerCase())
  .filter(Boolean)

export const BASE_DOMAIN = BASE_DOMAINS[0] || "localhost"

/** Host directory (inside the control-plane container) where the user's SSH keys are mounted. */
export const HOST_SSH_DIR = process.env.HOST_SSH_DIR || "/host-ssh"

/** Port the custom server listens on (serves app + reverse-proxies workers). */
export const PORT = Number(process.env.PORT || 80)

/**
 * Optional TLS. Point both at a cert/key pair and the same server also listens on
 * `TLS_PORT`, serving the app and the worker proxy over HTTPS — plain HTTP on `PORT`
 * keeps working either way. Unset (the default), nothing changes.
 *
 * The intended pair is the local mkcert wildcard from `local-https/generate-certs.sh`
 * (see `docs/local-domain.md`): it's what lets `https://worker-<id>-code.<domain>`
 * work from `browser-remote`, whose entrypoint trusts the matching rootCA.
 */
export const TLS_CERT_FILE = process.env.TLS_CERT_FILE?.trim() || ""
export const TLS_KEY_FILE = process.env.TLS_KEY_FILE?.trim() || ""
export const TLS_PORT = Number(process.env.TLS_PORT || 443)

/**
 * Extension registry the "VS Code extensions" picker searches when no custom
 * gallery is configured. It must stay the registry code-server installs from so
 * that "findable in the UI" implies "installable in the worker" — see
 * lib/open-vsx.ts.
 */
export const OPEN_VSX_API = (process.env.OPEN_VSX_API || "https://open-vsx.org/api").replace(/\/+$/, "")

/**
 * Custom VS Code extension gallery, in the JSON shape code-server expects in its
 * own `EXTENSIONS_GALLERY` variable:
 *
 *   EXTENSIONS_GALLERY='{"serviceUrl":"https://gallery.example.com/_apis/public/gallery","itemUrl":"https://gallery.example.com/items"}'
 *
 * Set on the control plane, it drives *all three* places an extension id is
 * resolved — the picker's search, the `--install-extension` calls in the image
 * build, and the code-server running in each worker — so the three can't drift
 * apart. Left unset, everything falls back to Open VSX. Which gallery to point
 * it at is the operator's call: nothing in this repo assumes a particular one.
 * Parsed and validated in lib/extension-registry.ts; kept raw here because the
 * string is also what gets handed to code-server.
 */
export const EXTENSIONS_GALLERY_RAW = process.env.EXTENSIONS_GALLERY?.trim() || null
