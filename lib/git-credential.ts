import { createHmac, timingSafeEqual } from "node:crypto"
import { DATA_ENCRYPTION_KEY } from "./env"
import { shellQuote } from "./shell"

/**
 * Cloning and pushing over HTTPS with a forge connected in Settings → Integrations
 * (docs/integrations.md § « Cloner et pousser avec le jeton »).
 *
 * Each worker gets a small git credential helper, configured system-wide by its setup script. Git
 * runs it when an HTTPS remote asks for a password; it asks Lite for a credential **for the host
 * git is talking to**, and Lite answers only for an origin that has a connection. The forge's
 * token is never written into the worker: it lives in the one git process that asked for it.
 *
 * Cloud's helper (in `@spunto/build`, RFC 0024) sends only the repository's path, and resolves
 * the forge from it; Lite's sends the host, so a token can only ever go back to its own forge —
 * a `git clone https://elsewhere/owner/repo` gets nothing.
 *
 * The worker's token is derived, not stored: an HMAC of its id under the data key. The script is
 * rebuilt at every start of the worker (`planFor`), and the same token comes out of it every time;
 * it stops being honoured when the worker row is gone.
 */

const PREFIX = "lgc_"
const HELPER_PATH = "/usr/local/bin/git-credential-spunto-lite"

const mac = (workerId: string) =>
  createHmac("sha256", DATA_ENCRYPTION_KEY).update(`git-credential:${workerId}`).digest("hex").slice(0, 40)

export function gitCredentialToken(workerId: string): string {
  return `${PREFIX}${workerId}_${mac(workerId)}`
}

/** The worker id a token was made for, or null if it was not made by this Lite. */
export function workerOfGitCredentialToken(token: string): string | null {
  const m = /^lgc_([a-z0-9]+)_([0-9a-f]{40})$/.exec(token)
  if (!m) return null
  const expected = Buffer.from(mac(m[1]))
  return timingSafeEqual(expected, Buffer.from(m[2])) ? m[1] : null
}

/**
 * Only `get` is answered: nothing to store, nothing to erase. Silent when Lite has nothing for the
 * host — git then goes on as it would have (another helper, or a prompt).
 */
function helperScript(apiUrl: string, token: string): string {
  return `#!/bin/sh
# Spunto Lite: a token of Settings -> Integrations, for the host git is talking to.
[ "$1" = "get" ] || exit 0
PROTOCOL=""
HOST=""
while IFS= read -r line; do
  case "$line" in
    protocol=*) PROTOCOL="\${line#protocol=}" ;;
    host=*) HOST="\${line#host=}" ;;
    "") break ;;
  esac
done
[ -n "$HOST" ] || exit 0
command -v curl >/dev/null 2>&1 || exit 0
RESPONSE=$(curl -sS -m 15 -X POST ${shellQuote(`${apiUrl}/api/workers/git-credential`)} -H ${shellQuote(`Authorization: Bearer ${token}`)} -H "Content-Type: application/json" -d "{\\"protocol\\":\\"$PROTOCOL\\",\\"host\\":\\"$HOST\\"}" 2>/dev/null) || exit 0
PASSWORD=$(printf "%s" "$RESPONSE" | sed -n 's/.*"password":"\\([^"]*\\)".*/\\1/p')
[ -n "$PASSWORD" ] || exit 0
USERNAME=$(printf "%s" "$RESPONSE" | sed -n 's/.*"username":"\\([^"]*\\)".*/\\1/p')
echo "username=$USERNAME"
echo "password=$PASSWORD"
`
}

/**
 * The lines the worker script starts with, as root: the helper, and git told to use it — in the
 * system config, so it holds for every user and survives a dotfiles repo replacing ~/.gitconfig.
 * Added next to any helper already there, never in place of one.
 */
export function gitCredentialSetup(workerId: string, apiUrl: string): string {
  return [
    `cat > ${HELPER_PATH} <<'SPUNTO_LITE_HELPER'`,
    helperScript(apiUrl, gitCredentialToken(workerId)).trimEnd(),
    "SPUNTO_LITE_HELPER",
    `chmod 755 ${HELPER_PATH}`,
    `if command -v git >/dev/null 2>&1; then git config --system --get-all credential.helper 2>/dev/null | grep -qxF ${HELPER_PATH} || git config --system --add credential.helper ${HELPER_PATH}; fi`,
    "",
  ].join("\n")
}
