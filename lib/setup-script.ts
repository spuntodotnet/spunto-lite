// Container CMD script builders, ported from apps/api/src/lib/setup-script.ts.
// Simplified for the local single-machine model: no OpenTelemetry spans, no SSH
// gateway (the terminal is a `docker exec` tmux bridge, not sshd). The three-script
// split is preserved: buildImageScript (prebuild), buildSetupScript (first boot),
// buildStartScript (every boot), assembled by buildWorkerScript.

import type { ProjectFeature, Repository, SetupStatus } from "../db/schema"

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
    const options = f.options && Object.keys(f.options).length > 0 ? f.options : undefined
    resolved.push({ id: f.id, script: buildFeatureInstallScript(f.ociRef, options) })
  }
  return resolved
}

// ─── tmux + VS Code settings ──────────────────────────────────────────────────

const TMUX_CONF = [
  "set -g mouse on",
  "set -g set-clipboard on",
  'set -as terminal-features ",screen-256color:clipboard"',
  "set -g history-limit 50000",
  "set -g base-index 1",
  "setw -g pane-base-index 1",
  "set -g renumber-windows on",
  "set -sg escape-time 10",
  'set -g default-terminal "screen-256color"',
  'set -ga terminal-overrides ",*256col*:Tc,xterm*:Tc"',
  'set -g status-style "bg=#18181b,fg=#a1a1aa"',
  'set -g status-left "#[fg=#ea5400,bold] #S #[default]"',
  "set -g status-left-length 40",
  'set -g status-right "#[fg=#52525b]%H:%M "',
  'setw -g window-status-current-style "fg=#ea5400,bold"',
  "set -g status-justify left",
].join("\n")

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

// ─── 1. buildImageScript (prebuild) ───────────────────────────────────────────

export function buildImageScript(params: {
  features: ProjectFeature[]
  vscodeExtensions?: string[]
  dind?: boolean
}): { script: string; hasDinD: boolean } {
  const lines: string[] = [
    "set -e",
    "useradd -m -s /bin/bash vscode 2>/dev/null || true",
    "echo 'vscode ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers",
    "if command -v zsh >/dev/null 2>&1; then",
    "  _ZSH=$(command -v zsh)",
    '  grep -qF "$_ZSH" /etc/shells 2>/dev/null || echo "$_ZSH" >> /etc/shells',
    '  usermod -s "$_ZSH" vscode 2>/dev/null || chsh -s "$_ZSH" vscode 2>/dev/null || true',
    "fi",
    "export HOME=/root",
    "export _REMOTE_USER=vscode",
    "export _REMOTE_USER_HOME=/home/vscode",
    "export _CONTAINER_USER=vscode",
    "export _CONTAINER_USER_HOME=/home/vscode",
    "",
    'if ! command -v code-server >/dev/null 2>&1; then',
    '  echo "[build] Installing code-server..."',
    '  curl -fsSL https://code-server.dev/install.sh | sh -s -- --method standalone --prefix /usr/local',
    'fi',
    "(",
    "  set +e",
    "  if ! command -v tmux >/dev/null 2>&1; then",
    '    echo "[build] Installing tmux..."',
    "    if command -v apt-get >/dev/null 2>&1; then",
    "      DEBIAN_FRONTEND=noninteractive apt-get update -qq 2>&1 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tmux 2>&1",
    "    elif command -v apk >/dev/null 2>&1; then apk add --no-cache tmux 2>&1",
    "    elif command -v yum >/dev/null 2>&1; then yum install -y tmux 2>&1",
    "    elif command -v dnf >/dev/null 2>&1; then dnf install -y tmux 2>&1",
    "    fi",
    "  fi",
    "  set -e",
    ")",
    `echo ${JSON.stringify(Buffer.from(TMUX_CONF).toString("base64"))} | base64 -d > /etc/tmux.conf`,
  ]

  const hasDinD = params.features.some((f) => f.id === "docker-in-docker") || !!params.dind

  for (const { id, script } of resolveFeatures(params.features)) {
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
    lines.push("", 'echo "[build] Installing VS Code extensions..."', "mkdir -p /opt/mp-extensions")
    for (const ext of params.vscodeExtensions) {
      lines.push(
        `set +e`,
        `code-server --extensions-dir /opt/mp-extensions --install-extension ${JSON.stringify(ext)} 2>&1`,
        `set -e`,
      )
    }
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
}

/** owner/repo → https://github.com/owner/repo; a full URL (http.../git@.../ssh://) is kept as-is. */
function normalizeDotfilesUrl(raw: string): string {
  const v = raw.trim()
  if (/^(https?:\/\/|ssh:\/\/|git@)/.test(v)) return v
  return `https://github.com/${v.replace(/^\/+|\/+$/g, "")}`
}

export function buildSetupScript(params: SetupScriptParams): { script: string } {
  const { project, userInfo, userSshPrivateKey, userEnvSecrets, projectDeployKey, dotfilesRepo } = params
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
  }

  // ── 2b. Dotfiles (Codespaces-style) ──
  // Runs after credentials (so ~/.ssh/mp_user_key is ready for private clones) and
  // before repo cloning — same order as the SetupStatus enum. Everything is best-effort
  // (clone/install failures are logged, never fatal) and guarded by a first-boot marker.
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

  // ── 3. Shell setup ──
  const landInWorkspace = [
    ``,
    `if [ "$PWD" = "$HOME" ] && [ -d /workspace ]; then`,
    `  __mp_dirs=$(find /workspace -mindepth 1 -maxdepth 1 -type d -not -name '.*' 2>/dev/null)`,
    `  __mp_n=$(printf '%s\\n' "$__mp_dirs" | grep -c .)`,
    `  if [ "$__mp_n" = 1 ]; then cd "$__mp_dirs" 2>/dev/null; else cd /workspace 2>/dev/null; fi`,
    `  unset __mp_dirs __mp_n`,
    `fi`,
  ].join("\n")

  const bashrcSnippet = [
    ``,
    `__mp_ps1_git() { local b; b=$(git symbolic-ref --short HEAD 2>/dev/null || git rev-parse --short HEAD 2>/dev/null) || return; printf ' \\e[0;33m(%s)\\e[0m' "$b"; }`,
    `PS1='\\n\\[\\e[0;2m\\]\\u@\\h\\[\\e[0m\\] \\[\\e[1;34m\\]\\w\\[\\e[0m\\]$(__mp_ps1_git)\\n\\[\\e[1;32m\\]❯\\[\\e[0m\\] '`,
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
    `  echo ${JSON.stringify(Buffer.from(landInWorkspace).toString("base64"))} | base64 -d >> ${homeDir}/.zshrc`,
    `fi`,
    `echo ${JSON.stringify(Buffer.from(landInWorkspace).toString("base64"))} | base64 -d >> ${homeDir}/.profile`,
  )

  // ── 4. Clone repos ──
  if (project.repositories.length > 0) push(...banner(`SETUP: CLONE REPOSITORIES (${project.repositories.length})`))
  project.repositories.forEach((r, i) => {
    const cloneCmd =
      r.provider === "git" && r.cloneUrl
        ? `GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${homeDir}/.ssh/mp_deploy_key" git clone ${shQuote(r.cloneUrl)} /workspace/${r.workspacePath}`
        : r.provider === "github" && userSshPrivateKey
        ? `GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${homeDir}/.ssh/mp_user_key" git clone git@github.com:${r.project}.git /workspace/${r.workspacePath}`
        : `git clone https://github.com/${r.project} /workspace/${r.workspacePath}`
    push("", `echo "--- Cloning ${r.project} (${i + 1}/${project.repositories.length}) ---"`)
    mp(mkStatus("cloning", reposAtClone(i, "cloning"), pc0, null))
    push(
      `if [ ! -d "/workspace/${r.workspacePath}/.git" ]; then`,
      `  ${cloneCmd}`,
      `else`,
      `  echo "${r.project}: already present, skipping clone"`,
      `fi`,
    )
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

  // Copy prebuilt extensions
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
