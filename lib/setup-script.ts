// Container CMD script builders, ported from apps/api/src/lib/setup-script.ts.
// Simplified for the local single-machine model: no OpenTelemetry spans, no SSH
// gateway (the terminal is a `docker exec` tmux bridge, not sshd). The three-script
// split is preserved: buildImageScript (prebuild), buildSetupScript (first boot),
// buildStartScript (every boot), assembled by buildWorkerScript.

import type { ProjectFeature, Repository, SetupStatus } from "../db/schema"
import { AVAILABLE_FEATURES } from "./catalogs"
import { CODE_SERVER_EXTENSIONS_GALLERY, registryInfo } from "./extension-registry"
import { EXTENSION_FAILED_MARKER } from "./extensions"

// ─── Shell helpers ────────────────────────────────────────────────────────────

function shQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`
}

function envPrefix(secrets?: Record<string, string>): string {
  if (!secrets || Object.keys(secrets).length === 0) return ""
  const pairs = Object.entries(secrets).map(([k, v]) => `${k}=${shQuote(v)}`).join(" ")
  return `env ${pairs} `
}

type RS = { name: string; state: "pending" | "cloning" | "done" | "error" }
type LS = "pending" | "running" | "done" | "error" | null

function mkStatus(phase: string, repos: RS[], postCreate: LS, postStart: LS): string {
  return JSON.stringify({ phase, repos, postCreate, postStart } as SetupStatus)
}

function banner(title: string): string[] {
  return [
    "",
    `echo "###########################################################"`,
    `echo "### ${title}"`,
    `echo "###########################################################"`,
  ]
}

// ─── Feature install (OCI) ────────────────────────────────────────────────────

function buildFeatureInstallScript(ociRef: string, options?: Record<string, string>): string {
  const match = ociRef.match(/^([^/]+)\/(.+):(.+)$/)
  if (!match) return `echo "[feature] Invalid OCI ref: ${ociRef}"`
  const [, registry, repo, tag] = match
  const featureId = repo.split("/").pop()

  const lines = [
    `echo "[feature] Installing ${featureId}..."`,
    `_FEAT_DIR=$(mktemp -d)`,
    `_FEAT_TOKEN=$(curl -fsSL "https://${registry}/token?scope=repository:${repo}:pull" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)`,
    `_FEAT_MANIFEST=$(curl -fsSL -H "Authorization: Bearer $_FEAT_TOKEN" -H "Accept: application/vnd.oci.image.manifest.v1+json" "https://${registry}/v2/${repo}/manifests/${tag}")`,
    `_FEAT_DIGEST=$(echo "$_FEAT_MANIFEST" | grep -o '"digest":"sha256:[^"]*"' | tail -1 | cut -d'"' -f4)`,
    `curl -fsSL -H "Authorization: Bearer $_FEAT_TOKEN" "https://${registry}/v2/${repo}/blobs/$_FEAT_DIGEST" -o "$_FEAT_DIR/feature.tar"`,
    `(tar xzf "$_FEAT_DIR/feature.tar" -C "$_FEAT_DIR" 2>/dev/null || tar xf "$_FEAT_DIR/feature.tar" -C "$_FEAT_DIR")`,
    `rm -f "$_FEAT_DIR/feature.tar"`,
    `cd "$_FEAT_DIR"`,
  ]

  if (options) {
    for (const [k, v] of Object.entries(options)) lines.push(`export ${k.toUpperCase()}=${JSON.stringify(v)}`)
  }

  lines.push(
    `chmod +x install.sh`,
    `set +e`,
    `./install.sh`,
    `_FEAT_EXIT=$?`,
    `set -e`,
    `if [ -f "$_FEAT_DIR/devcontainer-feature.json" ]; then`,
    `  _EP=$(grep -o '"entrypoint"[[:space:]]*:[[:space:]]*"[^"]*"' "$_FEAT_DIR/devcontainer-feature.json" | head -1 | cut -d'"' -f4)`,
    `  if [ -n "$_EP" ]; then echo "$_EP" >> /tmp/mp-feature-entrypoints; fi`,
    `fi`,
    `cd /`,
    `rm -rf "$_FEAT_DIR"`,
    `if [ $_FEAT_EXIT -ne 0 ]; then echo "[feature] ${featureId} FAILED (exit $_FEAT_EXIT)"; exit $_FEAT_EXIT; fi`,
    `echo "[feature] ${featureId} installed"`,
  )
  return lines.join("\n")
}

type ResolvedFeature = { id: string; script: string }

function resolveFeatures(features: ProjectFeature[]): ResolvedFeature[] {
  const resolved: ResolvedFeature[] = []
  for (const f of features) {
    if (!f.ociRef) {
      console.warn(`[worker] Feature "${f.id}" has no ociRef, skipping`)
      continue
    }
    // Re-merge the catalog defaults on top of the stored options (same as spunto's
    // resolveFeatures). Project creation already bakes defaults in, but merging again here
    // is the safety net that keeps e.g. docker-in-docker's `moby:false` (required on the
    // node:24 / Debian-trixie base, where moby packages are unavailable) even for a feature
    // that reached the DB without going through the create-time resolver (seed, migration,
    // template, direct write). Without it, `moby` falls back to true and dockerd breaks.
    const merged = { ...AVAILABLE_FEATURES.find((c) => c.id === f.id)?.defaultOptions, ...f.options }
    const options = Object.keys(merged).length > 0 ? merged : undefined
    resolved.push({ id: f.id, script: buildFeatureInstallScript(f.ociRef, options) })
  }
  return resolved
}

// ─── The two features every workspace image is made of ────────────────────────
//
// A workspace needs three things its base image doesn't have: a non-root user with sudo, an
// in-browser VS Code, and a terminal that survives a disconnect. That used to be ~60 lines of
// shell here — and the same ~60 lines, forked and already drifting, in the Spunto cloud
// codebase. Both speak the devcontainer feature spec already (`buildFeatureInstallScript`
// above), so that spec is the seam: the shared half is published as features and consumed
// identically on both sides, and nothing private has to be released to share it.
//
//   common-utils (upstream)  →  spunto-pack (ours)  →  the project's own features
//
// spunto-pack is one feature rather than three (code-server / tmux / sshd) because the fetcher
// above reads nothing but `entrypoint` out of a devcontainer-feature.json: `installsAfter` is
// ignored, so features run in array order and nothing resolves an ordering for us. Inside a
// single install.sh the order is guaranteed by construction — and it costs one OCI round-trip
// instead of three.
//
// Source and tests: github.com/coderhammer/features, src/spunto-pack.
const COMMON_UTILS_REF = "ghcr.io/devcontainers/features/common-utils:2"
const SPUNTO_PACK_REF = "ghcr.io/coderhammer/features/spunto-pack:1"

/**
 * common-utils replaces the old user block: it creates `vscode`, drops a `/etc/sudoers.d/vscode`
 * at 0440 (rather than appending to /etc/sudoers) and installs the base toolchain — on Debian,
 * RedHat, Alpine and azurelinux alike, which is more than the shim it replaces covered.
 *
 * None of these can be left at its default: `username` because `automatic` picks from a candidate
 * list that starts with users the base image may already have (`node` on a node:* base);
 * `upgradePackages` because on by default it runs a full distro upgrade in every image build;
 * `configureZshAsDefaultShell` because the block it replaces made zsh the login shell; and
 * `installOhMyZsh` because oh-my-zsh lives in a home directory, which buildSetupScript already
 * populates per workspace, at a point where it knows about the user's dotfiles.
 */
const COMMON_UTILS_OPTIONS: Record<string, string> = {
  username: "vscode",
  upgradePackages: "false",
  installZsh: "true",
  configureZshAsDefaultShell: "true",
  installOhMyZsh: "false",
  installOhMyZshConfig: "false",
}

/**
 * spunto-pack replaces the code-server and tmux blocks — including the system-wide /etc/tmux.conf
 * (mouse, OSC 52 clipboard, 50k scrollback, warm status bar) that used to live here as TMUX_CONF,
 * with the same version guard and one more: tmux rejects a config file as a whole, so each recent
 * option is gated on the version that introduced it (`window-size` 3.1, `terminal-features` 3.2)
 * and the result is loaded for real before the build moves on.
 *
 * `terminalBackend: tmux` — the pack also ships dtach, which only the cloud product has a terminal
 * backend for. No SSH server: the terminal here is a `docker exec` tmux bridge, not sshd.
 */
const SPUNTO_PACK_OPTIONS: Record<string, string> = {
  terminalBackend: "tmux",
  installSshd: "false",
}

// ─── VS Code settings ─────────────────────────────────────────────────────────

function defaultVscodeUserSettings(projectName?: string): Record<string, unknown> {
  return {
    "chat.disableAIFeatures": true,
    "security.workspace.trust.enabled": false,
    "workbench.secondarySideBar.defaultVisibility": "hidden",
    "window.title": projectName
      ? `${projectName}\${separator}\${activeEditorShort}`
      : "${rootName}${separator}${activeEditorShort}",
  }
}

// ─── VS Code extensions (prebuild) ────────────────────────────────────────────

// Installs one extension and *reports* the outcome. Two things it does that the
// previous bare `set +e; code-server --install-extension …; set -e` did not:
//
//  1. it never swallows a failure — every miss is printed with the
//     EXTENSION_FAILED_MARKER prefix, which the project page greps out of the
//     build log to flag the extension in the UI;
//  2. it checks the extension actually landed on disk. code-server doesn't
//     reliably exit non-zero on an unknown id, so exit code alone lets a
//     "Extension 'x' not found" scroll past as a success.
//
// A failed extension still doesn't break the build — it's a nice-to-have, not a
// prerequisite — but it is now impossible to miss in the logs.
/**
 * `export EXTENSIONS_GALLERY=…` lines, or nothing when the default (Open VSX)
 * registry is in play. Emitted into the generated scripts rather than relied on
 * from the ambient environment: `docker build` doesn't inherit the daemon's env
 * at all, and the code-server loop runs under `su`, which is free to strip it.
 */
function galleryExport(): string[] {
  if (!CODE_SERVER_EXTENSIONS_GALLERY) return []
  return [`export EXTENSIONS_GALLERY=${shQuote(CODE_SERVER_EXTENSIONS_GALLERY)}`]
}

/** Registry name, flattened to something safe to echo from a shell script. */
function registryLabel(): string {
  return registryInfo().name.replace(/[^\w .:/-]/g, "") || "the configured registry"
}

const extensionInstaller = () => [
  "MP_EXT_FAILED=''",
  "mp_install_extension() {",
  '  _ext="$1"',
  "  if ! command -v code-server >/dev/null 2>&1; then",
  `    echo "${EXTENSION_FAILED_MARKER} $_ext — code-server isn't installed in this image, so no extension can be pre-installed."`,
  '    MP_EXT_FAILED="$MP_EXT_FAILED $_ext"',
  "    return 0",
  "  fi",
  '  echo "[build] Installing extension: $_ext"',
  "  set +e",
  '  code-server --extensions-dir /opt/mp-extensions --install-extension "$_ext" 2>&1',
  "  _rc=$?",
  "  set -e",
  // VS Code lays extensions out as <publisher>.<name>-<version>/ (lowercased).
  `  _dir=$(find /opt/mp-extensions -maxdepth 1 -iname "$_ext-*" 2>/dev/null | head -1)`,
  '  if [ "$_rc" -ne 0 ] || [ -z "$_dir" ]; then',
  `    echo "${EXTENSION_FAILED_MARKER} $_ext (exit $_rc) — not installed."`,
  `    echo "[build]   Extensions are resolved against ${registryLabel()}; an id that isn't published there can't be installed. Continuing without it."`,
  '    MP_EXT_FAILED="$MP_EXT_FAILED $_ext"',
  "  else",
  '    echo "[build] Extension installed: $_ext"',
  "  fi",
  "}",
]

const EXTENSION_INSTALL_SUMMARY = [
  'if [ -n "$MP_EXT_FAILED" ]; then',
  `  echo "[build] WARNING: VS Code extension(s) that failed to install:$MP_EXT_FAILED"`,
  // Left in the image so the worker can tell what's missing without the build log.
  `  echo "$MP_EXT_FAILED" | tr ' ' '\\n' | sed '/^$/d' > /etc/mp-extension-failures`,
  "else",
  '  echo "[build] All VS Code extensions installed"',
  "fi",
]

// ─── 1. buildImageScript (prebuild) ───────────────────────────────────────────

/**
 * What the baked layer is made of, as a version. Part of the image tag (`services/workers.ts`,
 * `imageRefFor`), so bumping it makes the "is this image already built?" lookup miss and the
 * image get rebuilt — otherwise a project whose config never changed keeps spawning workers on
 * an image baked by an older release, indefinitely and invisibly.
 *
 * 1 → the hand-written blocks (vscode user, code-server, tmux).
 * 2 → common-utils + spunto-pack.
 */
export const IMAGE_RECIPE_VERSION = 2

export function buildImageScript(params: {
  features: ProjectFeature[]
  vscodeExtensions?: string[]
  dind?: boolean
}): { script: string; hasDinD: boolean } {
  const lines: string[] = [
    "set -e",
    // Devcontainer feature env (spec). First, before any feature runs: common-utils reads these to
    // decide which user it creates and configures, so exporting them later would have it fall back
    // to its own detection — which on a node:* base picks the pre-existing `node` user.
    "export HOME=/root",
    "export _REMOTE_USER=vscode",
    "export _REMOTE_USER_HOME=/home/vscode",
    "export _CONTAINER_USER=vscode",
    "export _CONTAINER_USER_HOME=/home/vscode",
    "",
    // curl can't become a feature: `buildFeatureInstallScript` *is* a curl script (OCI token,
    // manifest, blob), so a base image without one (node:*-slim and friends) can't fetch the very
    // feature that would install it. Chicken and egg — it stays inline, and first.
    "if ! command -v curl >/dev/null 2>&1; then",
    '  echo "[build] Installing curl (the feature fetcher\'s own dependency)..."',
    "  (",
    "    set +e",
    "    if command -v apt-get >/dev/null 2>&1; then",
    "      DEBIAN_FRONTEND=noninteractive apt-get update -qq 2>&1 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends curl ca-certificates 2>&1",
    "    elif command -v apk >/dev/null 2>&1; then apk add --no-cache curl ca-certificates 2>&1",
    "    elif command -v dnf >/dev/null 2>&1; then dnf install -y curl ca-certificates 2>&1",
    "    elif command -v yum >/dev/null 2>&1; then yum install -y curl ca-certificates 2>&1",
    "    fi",
    "    set -e",
    "  )",
    "fi",
    'command -v curl >/dev/null 2>&1 || echo "[build] WARNING: curl unavailable — feature installs will fail"',
  ]

  const hasDinD = params.features.some((f) => f.id === "docker-in-docker") || !!params.dind

  // The two features every image is made of, ahead of the project's own. A project that picked
  // common-utils itself gets its options merged over ours rather than a second install.
  const userCommonUtils = params.features.find((f) => f.id === "common-utils")
  const baseFeatures: ProjectFeature[] = [
    {
      id: "common-utils",
      ociRef: userCommonUtils?.ociRef ?? COMMON_UTILS_REF,
      options: { ...COMMON_UTILS_OPTIONS, ...userCommonUtils?.options },
    },
    { id: "spunto-pack", ociRef: SPUNTO_PACK_REF, options: SPUNTO_PACK_OPTIONS },
  ]

  const allFeatures = [...baseFeatures, ...params.features.filter((f) => f.id !== "common-utils")]
  for (const { id, script } of resolveFeatures(allFeatures)) {
    lines.push(`echo "[build] Installing feature: ${id}..."`, script)
  }

  lines.push(
    "",
    "if [ -f /tmp/mp-feature-entrypoints ]; then",
    "  touch /etc/mp-feature-entrypoints",
    "  cat /tmp/mp-feature-entrypoints >> /etc/mp-feature-entrypoints",
    "  sort -u /etc/mp-feature-entrypoints -o /etc/mp-feature-entrypoints",
    "  rm -f /tmp/mp-feature-entrypoints",
    "fi",
  )

  if (params.vscodeExtensions && params.vscodeExtensions.length > 0) {
    lines.push(
      "",
      'echo "[build] Installing VS Code extensions..."',
      "mkdir -p /opt/mp-extensions",
      // Must precede the first install: this is what makes `--install-extension`
      // resolve ids against the configured gallery instead of the default one.
      ...galleryExport(),
      ...extensionInstaller(),
    )
    for (const ext of params.vscodeExtensions) {
      lines.push(`mp_install_extension ${shQuote(ext)}`)
    }
    lines.push(...EXTENSION_INSTALL_SUMMARY)
  }

  lines.push("", "chown -R vscode:vscode /home/vscode 2>/dev/null || true", 'echo "[build] Image build complete"')
  return { script: lines.join("\n"), hasDinD }
}

// ─── 2. buildSetupScript (first boot) ─────────────────────────────────────────

export type SetupScriptParams = {
  project: {
    repositories: Repository[]
    features: ProjectFeature[] | null
    dind?: boolean | null
    postCreateCommand: string | null
  }
  userInfo?: { name: string; email?: string | null }
  userSshPrivateKey?: string
  userEnvSecrets?: Record<string, string>
  projectDeployKey?: string
  /** Personal dotfiles repo: "owner/repo" shorthand or a full http(s)/ssh/git@ URL. */
  dotfilesRepo?: string
  /**
   * Branch to check out for every repository, overriding each repo's own default.
   * Chosen per worker at spawn time; empty/absent falls back to `repository.branch`,
   * then to the remote's default (HEAD).
   */
  branch?: string
}

/** owner/repo → https://github.com/owner/repo; a full URL (http.../git@.../ssh://) is kept as-is. */
function normalizeDotfilesUrl(raw: string): string {
  const v = raw.trim()
  if (/^(https?:\/\/|ssh:\/\/|git@)/.test(v)) return v
  return `https://github.com/${v.replace(/^\/+|\/+$/g, "")}`
}

export function buildSetupScript(params: SetupScriptParams): { script: string } {
  const { project, userInfo, userSshPrivateKey, userEnvSecrets, projectDeployKey, dotfilesRepo } = params
  const workerBranch = params.branch?.trim() || undefined
  const homeDir = "/home/vscode"
  const username = "vscode"

  const repoNames = project.repositories.map((r) => r.project)
  const hasPostCreate = !!project.postCreateCommand
  const pc0: LS = hasPostCreate ? "pending" : null
  const allReposPending: RS[] = repoNames.map((n) => ({ name: n, state: "pending" }))
  const allReposDone: RS[] = repoNames.map((n) => ({ name: n, state: "done" }))
  const reposAtClone = (i: number, cur: "cloning" | "done"): RS[] =>
    repoNames.map((n, j) => ({ name: n, state: j < i ? "done" : j === i ? cur : "pending" }))

  const lines: string[] = []
  const push = (...l: string[]) => lines.push(...l)
  const mp = (json: string) => push(`_mp ${JSON.stringify(json)}`)

  // ── 1. Ownership ──
  push(...banner("SETUP: OWNERSHIP"))
  push(`chown -R ${username}:${username} /workspace`, `chown -R ${username}:${username} ${homeDir}`)

  // ── 2. Credentials ──
  const hasCredentials = !!(userInfo || userSshPrivateKey || projectDeployKey)
  if (hasCredentials) {
    push(...banner("SETUP: CREDENTIALS"))
    mp(mkStatus("credentials", allReposPending, pc0, null))
  }
  if (userInfo) {
    push(`git config --global user.name ${JSON.stringify(userInfo.name)}`)
    if (userInfo.email) push(`git config --global user.email ${JSON.stringify(userInfo.email)}`)
  }
  if (userSshPrivateKey) {
    push(
      'echo "Configuring user SSH key..."',
      `mkdir -p ${homeDir}/.ssh`,
      `printf '%s' ${shQuote(userSshPrivateKey)} > ${homeDir}/.ssh/mp_user_key`,
      `chmod 600 ${homeDir}/.ssh/mp_user_key`,
    )
  }
  if (projectDeployKey) {
    push(
      'echo "Configuring project deploy key..."',
      `mkdir -p ${homeDir}/.ssh`,
      `printf '%s' ${shQuote(projectDeployKey)} > ${homeDir}/.ssh/mp_deploy_key`,
      `chmod 600 ${homeDir}/.ssh/mp_deploy_key`,
    )
  }
  // Single ~/.ssh/config governing every host. The user's selected key is listed
  // FIRST, so it is the default identity for all git-over-SSH (github, gitlab,
  // dotfiles, manual clones); the per-project deploy key follows only as a fallback
  // for repos that authorise it exclusively. No `IdentitiesOnly yes` — that would
  // pin ssh to the single first key and stop it falling through user → deploy.
  if (userSshPrivateKey || projectDeployKey) {
    const identityFiles = [
      ...(userSshPrivateKey ? [`  IdentityFile ${homeDir}/.ssh/mp_user_key`] : []),
      ...(projectDeployKey ? [`  IdentityFile ${homeDir}/.ssh/mp_deploy_key`] : []),
    ]
    const sshConfig = ["Host *", "  StrictHostKeyChecking no", ...identityFiles, ""].join("\n")
    push(
      `mkdir -p ${homeDir}/.ssh`,
      `echo ${JSON.stringify(Buffer.from(sshConfig).toString("base64"))} | base64 -d > ${homeDir}/.ssh/config`,
      `chmod 600 ${homeDir}/.ssh/config`,
    )
    // These files are created here as root; the final home chown only runs at the
    // very end of setup. The dotfiles step (and postCreate) run as `vscode` before
    // that, so hand ~/.ssh to vscode now — otherwise it can't read the keys and any
    // git-over-SSH performed as the user fails with "identity file not accessible".
    push(`chown -R ${username}:${username} ${homeDir}/.ssh`)
  }

  // ── 2b. Shell setup ──
  // Runs BEFORE dotfiles (same order as spunto/apps/api) so a user's dotfiles
  // layer on top of the Spunto base: oh-my-zsh + theme + aliases + auto-cd. At this
  // point the home is fresh (no .zshrc yet), so oh-my-zsh drops its default and we
  // apply our tweaks unconditionally; the dotfiles step then appends or overrides.
  const landInWorkspace = [
    ``,
    `if [ "$PWD" = "$HOME" ] && [ -d /workspace ]; then`,
    `  __mp_dirs=$(find /workspace -mindepth 1 -maxdepth 1 -type d -not -name '.*' 2>/dev/null)`,
    `  __mp_n=$(printf '%s\\n' "$__mp_dirs" | grep -c .)`,
    `  if [ "$__mp_n" = 1 ]; then cd "$__mp_dirs" 2>/dev/null; else cd /workspace 2>/dev/null; fi`,
    `  unset __mp_dirs __mp_n`,
    `fi`,
  ].join("\n")

  // Put ~/.local/bin on PATH. devcontainer features that install per-user (e.g. claude-code →
  // ~/.local/bin) add this line to the user's rc files at build time, but the oh-my-zsh install
  // below runs with KEEP_ZSHRC=no and OVERWRITES ~/.zshrc, dropping the feature's line — so on a
  // bare base (node:24, where we install zsh ourselves and make it the login shell) the terminal
  // ends up without ~/.local/bin and `claude` isn't found. Re-adding it in the snippets we append
  // AFTER the clobber makes it survive. (On spunto this never bites: its devcontainer base image
  // already ships oh-my-zsh, so the KEEP_ZSHRC=no install is skipped and ~/.zshrc is never wiped.)
  const localBinOnPath = `export PATH="$HOME/.local/bin:$PATH"`

  const bashrcSnippet = [
    ``,
    localBinOnPath,
    `__mp_ps1_git() { local b; b=$(git symbolic-ref --short HEAD 2>/dev/null || git rev-parse --short HEAD 2>/dev/null) || return; printf ' \\e[0;33m(%s)\\e[0m' "$b"; }`,
    `PS1='\\n\\[\\e[0;2m\\]\\u@\\h\\[\\e[0m\\] \\[\\e[1;34m\\]\\w\\[\\e[0m\\]$(__mp_ps1_git)\\n\\[\\e[1;32m\\]❯\\[\\e[0m\\] '`,
    `alias ll='ls -lah --color=auto'`,
    `alias gs='git status'`,
    `alias gd='git diff'`,
    `alias gl='git log --oneline --graph --decorate -20'`,
    landInWorkspace,
  ].join("\n")

  // zsh gets its own alias block (oh-my-zsh already provides the theme/prompt).
  const zshrcAliasSnippet = [
    ``,
    localBinOnPath,
    `setopt NO_BANG_HIST`,
    `alias ll='ls -lah --color=auto'`,
    `alias gs='git status'`,
    `alias gd='git diff'`,
    `alias gl='git log --oneline --graph --decorate -20'`,
    landInWorkspace,
  ].join("\n")

  push(...banner("SETUP: SHELL"))
  push(
    `echo ${JSON.stringify(Buffer.from(bashrcSnippet).toString("base64"))} | base64 -d >> ${homeDir}/.bashrc`,
    `if command -v zsh >/dev/null 2>&1; then`,
    `  if [ ! -d "${homeDir}/.oh-my-zsh" ]; then`,
    `    _OMZ_TMP=$(mktemp)`,
    `    curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh -o "$_OMZ_TMP" 2>&1 || true`,
    `    chmod 644 "$_OMZ_TMP"`,
    `    su ${username} -c "HOME=${homeDir} RUNZSH=no CHSH=no KEEP_ZSHRC=no bash $_OMZ_TMP" 2>&1 || true`,
    `    rm -f "$_OMZ_TMP"`,
    `  fi`,
    `  sed -i 's/ZSH_THEME="robbyrussell"/ZSH_THEME="af-magic"/' ${homeDir}/.zshrc 2>/dev/null || true`,
    `  echo ${JSON.stringify(Buffer.from(zshrcAliasSnippet).toString("base64"))} | base64 -d >> ${homeDir}/.zshrc`,
    `fi`,
    `echo ${JSON.stringify(Buffer.from(landInWorkspace).toString("base64"))} | base64 -d >> ${homeDir}/.profile`,
  )

  // ── 2c. Dotfiles (Codespaces-style) ──
  // Runs after the shell base (so dotfiles layer on top of it) and after credentials
  // (so ~/.ssh/mp_user_key is ready for private clones), before repo cloning.
  // Everything is best-effort (clone/install failures are logged, never fatal) and
  // guarded by a first-boot marker.
  if (dotfilesRepo && dotfilesRepo.trim()) {
    const url = normalizeDotfilesUrl(dotfilesRepo)
    const sshPrefix = userSshPrivateKey
      ? `GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${homeDir}/.ssh/mp_user_key" `
      : ""
    // Inner script runs as `vscode` (cwd ~/dotfiles) so install scripts and symlinks
    // land in the user's home with the right ownership. Always exits 0.
    const dotfilesInner = [
      "set +e",
      `DOTFILES_DIR="$HOME/dotfiles"`,
      `echo "Cloning dotfiles from ${url} ..."`,
      `if [ ! -d "$DOTFILES_DIR/.git" ]; then`,
      `  ${sshPrefix}git clone ${shQuote(url)} "$DOTFILES_DIR"`,
      `fi`,
      `if [ -d "$DOTFILES_DIR/.git" ]; then`,
      `  cd "$DOTFILES_DIR" || exit 0`,
      `  _mp_installed=0`,
      `  for _cand in install.sh bootstrap.sh setup.sh script/setup; do`,
      `    if [ -f "$DOTFILES_DIR/$_cand" ]; then`,
      `      echo "[dotfiles] Running install script: $_cand"`,
      `      chmod +x "$DOTFILES_DIR/$_cand" 2>/dev/null || true`,
      `      "$DOTFILES_DIR/$_cand"`,
      `      echo "[dotfiles] install script exited $?"`,
      `      _mp_installed=1`,
      `      break`,
      `    fi`,
      `  done`,
      `  if [ "$_mp_installed" = 0 ]; then`,
      `    echo "[dotfiles] No install script found, symlinking dotfiles into $HOME"`,
      `    for _f in "$DOTFILES_DIR"/.*; do`,
      `      _base=$(basename "$_f")`,
      `      case "$_base" in .|..|.git|.gitignore|.gitmodules) continue ;; esac`,
      `      ln -sf "$_f" "$HOME/$_base"`,
      `    done`,
      `  fi`,
      `else`,
      `  echo "[dotfiles] clone failed, continuing"`,
      `fi`,
      `exit 0`,
    ].join("\n")
    push(...banner("SETUP: DOTFILES"))
    mp(mkStatus("dotfiles", allReposPending, pc0, null))
    push(
      `if [ ! -f "${homeDir}/.mp-dotfiles-done" ]; then`,
      `  echo ${JSON.stringify(Buffer.from(dotfilesInner).toString("base64"))} | base64 -d > /tmp/mp_dotfiles.sh`,
      `  chmod +x /tmp/mp_dotfiles.sh`,
      `  su ${username} -c "${envPrefix(userEnvSecrets)}bash /tmp/mp_dotfiles.sh" 2>&1 || true`,
      `  rm -f /tmp/mp_dotfiles.sh`,
      `  touch "${homeDir}/.mp-dotfiles-done"`,
      `fi`,
    )
  }

  // ── 4. Clone repos ──
  if (project.repositories.length > 0) push(...banner(`SETUP: CLONE REPOSITORIES (${project.repositories.length})`))
  // Generic "git" repo (e.g. GitLab): offer the user's global SSH key FIRST — the
  // same key the dotfiles clone uses — then the per-project deploy key as a fallback.
  // Why explicit `-i` rather than relying on ~/.ssh/config (which already lists both
  // in this order): this clone runs as root, and ssh locates ~/.ssh/config via the
  // *passwd-database* home of the running user (/root), NOT $HOME. So the user key in
  // /home/vscode/.ssh/config is never read here, and without listing it explicitly the
  // clone would only ever try the deploy key — the exact "mon repo GitLab n'utilise pas
  // ma clé SSH" symptom. Listing user-then-deploy keeps deploy-key-only repos working
  // (their key is offered second) while making a user-key-authorised repo just work.
  const gitCloneIdentities = [
    ...(userSshPrivateKey ? [`-i ${homeDir}/.ssh/mp_user_key`] : []),
    ...(projectDeployKey ? [`-i ${homeDir}/.ssh/mp_deploy_key`] : []),
  ].join(" ")
  project.repositories.forEach((r, i) => {
    // Same credentials for the clone and for the fetch of an already-cloned repo.
    const gitEnv =
      r.provider === "git" && r.cloneUrl
        ? `GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${gitCloneIdentities}" `
        : r.provider === "github" && userSshPrivateKey
        ? `GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${homeDir}/.ssh/mp_user_key" `
        : ""
    const cloneUrl =
      r.provider === "git" && r.cloneUrl
        ? r.cloneUrl
        : r.provider === "github" && userSshPrivateKey
        ? `git@github.com:${r.project}.git`
        : `https://github.com/${r.project}`
    // Worker-level branch wins over the repository's own default; neither = remote HEAD.
    const branch = workerBranch ?? (r.branch?.trim() || undefined)
    const dir = `/workspace/${r.workspacePath}`
    const cloneCmd = `${gitEnv}git clone ${branch ? `--branch ${shQuote(branch)} ` : ""}${shQuote(cloneUrl)} ${dir}`
    push("", `echo "--- Cloning ${r.project}${branch ? ` (branch ${branch})` : ""} (${i + 1}/${project.repositories.length}) ---"`)
    mp(mkStatus("cloning", reposAtClone(i, "cloning"), pc0, null))
    push(
      `if [ ! -d "${dir}/.git" ]; then`,
      // `|| { …; false; }` keeps the readable message *and* the failure: `set -e` +
      // the ERR trap then flip the setup status to error instead of carrying on with
      // an empty workspace. A typo'd branch dies here, right under its own log line.
      `  ${cloneCmd} || { echo "ERROR: clone of ${r.project} failed${branch ? ` — does the branch '${branch}' exist on the remote?` : ""}"; false; }`,
      `else`,
      `  echo "${r.project}: already present, skipping clone"`,
    )
    if (branch) {
      // Existing workspace (rebuild keeps the /workspace volume): land on the requested
      // branch rather than leaving the worker on whatever HEAD the volume carried, but
      // never at the cost of local work — git refuses a clobbering checkout, and we only
      // warn so a rebuild is not lost over it.
      // `safe.directory`: setup runs as root while /workspace belongs to vscode, and
      // git refuses to touch a repo it sees as someone else's ("dubious ownership").
      const git = `git -c safe.directory=${dir} -C ${dir}`
      push(
        `  _mp_cur=$(${git} rev-parse --abbrev-ref HEAD 2>/dev/null || true)`,
        `  if [ "$_mp_cur" != ${shQuote(branch)} ]; then`,
        `    echo "${r.project}: switching from '$_mp_cur' to branch '${branch}'"`,
        `    ${gitEnv}${git} fetch origin ${shQuote(branch)} 2>&1 || echo "${r.project}: could not fetch '${branch}' from origin"`,
        `    ${git} checkout ${shQuote(branch)} 2>&1 || echo "WARNING: ${r.project}: could not check out '${branch}' (local changes, or unknown branch) — left on '$_mp_cur'"`,
        `  fi`,
      )
    }
    push(`fi`)
    mp(mkStatus("cloning", reposAtClone(i, "done"), pc0, null))
  })
  if (project.repositories.length > 0) push("", `chown -R ${username}:${username} /workspace`)

  // ── 5. postCreateCommand ──
  const hasDinDFeature = (project.features?.some((f) => f.id === "docker-in-docker") ?? false) || !!project.dind
  if (project.postCreateCommand && ((project.features && project.features.length > 0) || project.dind)) {
    push(
      "",
      "if [ -f /etc/mp-feature-entrypoints ]; then",
      '  echo "--- Starting feature entrypoints for postCreate ---"',
      "  while IFS= read -r _ep; do",
      '    if [ -f "$_ep" ]; then "$_ep" & fi',
      "  done < /etc/mp-feature-entrypoints",
      "fi",
    )
    if (hasDinDFeature) {
      push(
        'echo "Waiting for Docker daemon..."',
        "for _i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done",
      )
    }
  }
  if (project.postCreateCommand) {
    const dir = project.repositories.length === 1 ? `/workspace/${project.repositories[0].workspacePath}` : "/workspace"
    push(...banner("SETUP: POST CREATE"))
    mp(mkStatus("lifecycle", allReposDone, "running", null))
    push(
      `if [ ! -f "${homeDir}/.mp-post-create-done" ]; then`,
      `  echo ${JSON.stringify(Buffer.from(project.postCreateCommand).toString("base64"))} | base64 -d > /tmp/mp_postcreate.sh`,
      `  chmod +x /tmp/mp_postcreate.sh`,
      `  su ${username} -c "cd ${dir} && ${envPrefix(userEnvSecrets)}bash /tmp/mp_postcreate.sh" 2>&1`,
      `  rm -f /tmp/mp_postcreate.sh`,
      `  touch "${homeDir}/.mp-post-create-done"`,
      `fi`,
    )
    mp(mkStatus("lifecycle", allReposDone, "done", null))
  }

  // ── 6. Final marker ──
  push(
    "",
    `chown -R ${username}:${username} ${homeDir}`,
    `chown -R ${username}:${username} /workspace`,
    `touch ${homeDir}/.mp-setup-done`,
    'echo "[setup] First-start setup complete"',
  )
  return { script: lines.join("\n") }
}

// ─── 3. buildStartScript (every boot) ─────────────────────────────────────────

export type StartScriptParams = {
  project: {
    name?: string
    features: ProjectFeature[] | null
    dind?: boolean | null
    postCreateCommand: string | null
    postStartCommand: string | null
    repositories: { project: string; workspacePath: string }[]
  }
}

export function buildStartScript(params: StartScriptParams): { script: string; hasDinD: boolean } {
  const { project } = params
  const homeDir = "/home/vscode"
  const username = "vscode"

  const features = project.features ?? []
  const hasPostCreate = !!project.postCreateCommand
  const hasPostStart = !!project.postStartCommand
  const hasDinD = features.some((f) => f.id === "docker-in-docker") || !!project.dind
  const allReposDone: RS[] = project.repositories.map((r) => ({ name: r.project, state: "done" }))

  const lines: string[] = []
  const push = (...l: string[]) => lines.push(...l)
  const mp = (json: string) => push(`_mp ${JSON.stringify(json)}`)

  push(
    `printf '\\033[2m%s\\033[0m\\n' "$(printf '─%.0s' {1..42})"`,
    `printf '\\033[2m  ↺  Session · %s\\033[0m\\n' "$(date +%H:%M:%S)"`,
  )
  if (hasPostStart) mp(mkStatus("lifecycle", allReposDone, hasPostCreate ? "done" : null, "pending"))

  // Feature entrypoints (e.g. dockerd)
  push(
    "",
    "if [ -f /etc/mp-feature-entrypoints ]; then",
    '  echo "--- Starting feature entrypoints ---"',
    "  while IFS= read -r _ep; do",
    '    if [ -f "$_ep" ]; then "$_ep" & fi',
    "  done < /etc/mp-feature-entrypoints",
    "fi",
  )

  // Persist worker env for login shells
  push(
    "",
    "for _var in WORKER_SLUG BASE_DOMAIN PUBLIC_PROTOCOL; do",
    '  _val=$(printenv "$_var" 2>/dev/null || true)',
    '  [ -n "$_val" ] && echo "${_var}=${_val}" >> /etc/environment || true',
    "done",
  )

  // Copy the extensions baked into the image at build time. Runs on every boot,
  // `-n` so an extension the user installed themselves from inside code-server
  // is never clobbered. Consequence worth knowing: editing a project's extension
  // list bumps its version, so the new set only reaches a worker once it runs on
  // the freshly built image — i.e. after a spawn or a **rebuild**, not a restart.
  push(
    "",
    'if [ -d /opt/mp-extensions ] && [ "$(ls -A /opt/mp-extensions 2>/dev/null)" ]; then',
    `  mkdir -p ${homeDir}/.local/share/code-server/extensions`,
    `  cp -rn /opt/mp-extensions/. ${homeDir}/.local/share/code-server/extensions/ 2>/dev/null || true`,
    `  chown -R ${username}:${username} ${homeDir}/.local`,
    "fi",
  )

  // Seed code-server settings (no-clobber)
  const vscodeSettings = JSON.stringify(defaultVscodeUserSettings(project.name), null, 2)
  push(
    "",
    `mkdir -p ${homeDir}/.local/share/code-server/User`,
    `if [ ! -f ${homeDir}/.local/share/code-server/User/settings.json ]; then`,
    `  echo ${JSON.stringify(Buffer.from(vscodeSettings).toString("base64"))} | base64 -d > ${homeDir}/.local/share/code-server/User/settings.json`,
    `  chown -R ${username}:${username} ${homeDir}/.local`,
    "fi",
  )

  // Start code-server (restart loop, as vscode)
  const codeServerLoop = [
    "#!/bin/bash",
    "export SHELL=$(command -v zsh 2>/dev/null || echo /bin/bash)",
    // Makes the extensions view inside the worker's editor search the same
    // registry the picker and the image build used.
    ...galleryExport(),
    "while true; do",
    '  VSCODE_PROXY_URI="${PUBLIC_PROTOCOL}://${WORKER_SLUG}-{{port}}.${BASE_DOMAIN}" \\',
    "    PORT=8080 code-server --bind-addr 0.0.0.0:8080 --auth none /workspace 2>&1",
    '  echo "[start] code-server exited ($?), restarting in 3s..."',
    "  sleep 3",
    "done",
  ].join("\n")
  push(
    ...banner("START: CODE-SERVER"),
    `echo ${JSON.stringify(Buffer.from(codeServerLoop).toString("base64"))} | base64 -d > ${homeDir}/.mp_codeserver.sh`,
    `chmod +x ${homeDir}/.mp_codeserver.sh`,
    `su ${username} -s /bin/bash -c "${homeDir}/.mp_codeserver.sh" &`,
  )

  // postStartCommand
  if (project.postStartCommand) {
    push(
      "",
      "if [ -f /etc/mp-feature-entrypoints ]; then",
      "  for _i in 1 2 3 4 5; do [ -S /var/run/docker.sock ] && break || sleep 1; done",
      "  if [ -S /var/run/docker.sock ]; then",
      "    for _i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done",
      "  fi",
      "fi",
    )
    const dir = project.repositories.length === 1 ? `/workspace/${project.repositories[0].workspacePath}` : "/workspace"
    push(...banner("START: POST START"))
    mp(mkStatus("lifecycle", allReposDone, hasPostCreate ? "done" : null, "running"))
    push(
      `echo ${JSON.stringify(Buffer.from(project.postStartCommand).toString("base64"))} | base64 -d > /tmp/mp_poststart.sh`,
      `chmod +x /tmp/mp_poststart.sh`,
      `su ${username} -c "cd ${dir} && bash /tmp/mp_poststart.sh" 2>&1`,
      `rm -f /tmp/mp_poststart.sh`,
    )
    mp(mkStatus("lifecycle", allReposDone, hasPostCreate ? "done" : null, "done"))
  }

  // Ready
  push(...banner("READY"))
  mp(mkStatus("ready", allReposDone, hasPostCreate ? "done" : null, hasPostStart ? "done" : null))
  push("_MP_DONE=1", "", "wait")
  return { script: lines.join("\n"), hasDinD }
}

// ─── buildWorkerScript (assembles the full CMD) ───────────────────────────────

export function buildWorkerScript(params: {
  setupScript: string
  startScript: string
  project: { postCreateCommand: string | null; postStartCommand: string | null; repositories: { project: string }[] }
}): string {
  const { setupScript, startScript, project } = params
  const hasPostCreate = !!project.postCreateCommand
  const hasPostStart = !!project.postStartCommand
  const allReposPending: RS[] = project.repositories.map((r) => ({ name: r.project, state: "pending" }))
  const initialStatus = mkStatus("initializing", allReposPending, hasPostCreate ? "pending" : null, hasPostStart ? "pending" : null)
  const homeDir = "/home/vscode"

  return [
    "set -e",
    "export HOME=/home/vscode",
    "",
    // Status writer: dumps JSON to a file the control plane reads via `docker exec`.
    "_MP_DONE=0; _MP_LAST=''",
    "_mp() {",
    `  _MP_LAST="$1"`,
    `  printf '%s' "$1" > ${homeDir}/.mp-status.json || true`,
    "}",
    // Failure trap: re-emit the last status with phase=error appended. The duplicate
    // "phase" key means JSON.parse keeps the last one ("error") while repos/postCreate/
    // postStart progress is preserved. Disarmed once setup+start reach ready (_MP_DONE=1).
    "_mp_fail() {",
    '  [ "$_MP_DONE" = 1 ] && return 0',
    '  if [ -n "$_MP_LAST" ]; then',
    `    printf '%s' "\${_MP_LAST%?},\\"phase\\":\\"error\\"}" > ${homeDir}/.mp-status.json || true`,
    "  else",
    `    printf '%s' '{"phase":"error","repos":[],"postCreate":null,"postStart":null}' > ${homeDir}/.mp-status.json || true`,
    "  fi",
    "}",
    "trap _mp_fail ERR",
    "",
    `_mp ${JSON.stringify(initialStatus)}`,
    "",
    "# ── First-boot setup (guarded by marker) ──",
    `if [ ! -f ${homeDir}/.mp-setup-done ]; then`,
    setupScript,
    "fi",
    "",
    "# ── Every-boot start ──",
    startScript,
  ].join("\n")
}
