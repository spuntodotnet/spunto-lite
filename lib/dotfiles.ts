// Cloning a *private* dotfiles repo over SSH.
//
// Two things `buildSetupScript` (@spunto/build) does not do for us, both invisible unless the
// dotfiles repo is private and reached over SSH — which is a Lite-shaped setup, where the host's
// `~/.ssh` is mounted and handed to the worker. Spunto Cloud reaches its repos with forge app
// tokens over HTTPS, where the SSH identity never comes up, so neither gap shows there.
//
// Both belong upstream. Until then, this is what keeps the feature working; it is pure string
// work, deliberately kept out of `services/workers.ts` so it can be tested without a database.

/** Where `buildSetupScript` writes the user's key, one step before it clones the dotfiles. */
const USER_KEY = "/home/vscode/.ssh/mp_user_key"

/**
 * The dotfiles URL, in a form the generator recognises as already absolute.
 *
 * It only treats a value as a URL when it starts with `http` or `git@`, and prefixes everything
 * else with `https://github.com/` — so `ssh://git@host/me/dotfiles.git` came out as
 * `https://github.com/ssh://git@host/me/dotfiles.git`, which clones nothing. The scp-like form it
 * does accept is equivalent, so that is what an `ssh://` URL is rewritten to.
 *
 * A port (`ssh://host:2222/…`) has no scp-like equivalent and is left as-is: it would still be
 * mangled, and that case can only be fixed in the package.
 */
export function normalizeDotfilesRepo(raw: string | null | undefined): string | undefined {
  const v = raw?.trim()
  if (!v) return undefined
  const m = /^ssh:\/\/(?:([^@/]+)@)?([^/:]+)\/(.+)$/.exec(v)
  return m ? `${m[1] ?? "git"}@${m[2]}:${m[3]}` : v
}

/**
 * Shell that lets the dotfiles clone authenticate with the user's key. Empty when there is no key
 * to offer, in which case nothing about the clone changes.
 *
 * The whole setup script runs as root, and so do the repo clones — but those pass
 * `GIT_SSH_COMMAND=… -i mp_user_key` on the command line, and the dotfiles clone does not. Root
 * has no `~/.ssh`, so a `git@host:…` dotfiles URL authenticates with no key at all and dies on
 * "Permission denied (publickey)" — silently, a failed dotfiles clone being deliberately
 * non-fatal.
 *
 * Root is therefore given a config pointing at the key the generator writes for `vscode`. ssh
 * reads a key owned by another user as long as the mode is tight, and it is (0600). Prepended to
 * the generated script rather than patched into it, so it keeps working whichever way the package
 * chooses to clone later — and harmless if the package starts passing an identity of its own,
 * since an explicit `-i` wins over this config.
 */
export function rootSshConfigFor(userSshPrivateKey?: string): string {
  if (!userSshPrivateKey) return ""
  return [
    "# --- spunto-lite: let root's git reach a private dotfiles repo (see lib/dotfiles.ts) ---",
    "mkdir -p /root/.ssh && chmod 700 /root/.ssh",
    `printf 'Host *\\n  IdentityFile ${USER_KEY}\\n  StrictHostKeyChecking no\\n  UserKnownHostsFile /dev/null\\n  IdentitiesOnly yes\\n' > /root/.ssh/config`,
    "chmod 600 /root/.ssh/config",
    "",
  ].join("\n")
}
