#!/usr/bin/env bash
# End-to-end check of SSH keys in workers — with and without a passphrase (README § SSH keys with
# a passphrase). Real Docker, real keys, real git over SSH:
#
#   - generates throwaway keys with `ssh-keygen -N` into a fake $HOME/.ssh: one without passphrase,
#     one OpenSSH-format and one legacy PEM, both with a passphrase;
#   - runs a local git SSH server (`gitsshd`, alpine + sshd + a bare repo) on the workers' shared
#     network, authorizing all three;
#   - brings the compose stack up on that fake $HOME, then for each case spawns a worker of a
#     project that clones from that server, and runs `ssh -T` / `git ls-remote` / `git push` inside.
#
# Scenarios: no passphrase (non-regression) · passphrase + nothing unlocked (fails, and says so) ·
# wrong passphrase refused · unlocked in Settings (an already-running worker picks it up) · PEM
# key · lock · host agent forwarded instead of unlocking · restart forgets the passphrase.
#
#   scripts/test-ssh-passphrase.sh            # uses the already-built image
#   BUILD=1 scripts/test-ssh-passphrase.sh    # docker compose build first
#
# Leaves the stack running (http://localhost) for a look at Settings; `KEEP=0` tears it down.
set -euo pipefail

cd "$(dirname "$0")/.."
WORK=${WORK:-/tmp/spunto-ssh-passphrase-test}
PASS="correct horse battery staple"
BASE=${BASE:-http://localhost}
IMAGE=${IMAGE:-mcr.microsoft.com/devcontainers/base:bookworm}
export HOME_FAKE="$WORK/home"

fails=0
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
ko() { printf '  \033[31m✗\033[0m %s\n' "$*"; fails=$((fails + 1)); }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
api() { local m=$1 p=$2; shift 2; curl -sS -X "$m" -H 'content-type: application/json' "$BASE$p" "$@"; }
compose() { HOME="$HOME_FAKE" docker compose -f docker-compose.yml "$@"; }

# ── Keys + git server ──────────────────────────────────────────────────────────
step "keys and git server"
rm -rf "$WORK" && mkdir -p "$HOME_FAKE/.ssh" "$WORK/gitsshd" "$WORK/hostagent"
ssh-keygen -q -t ed25519 -N ""      -C plain       -f "$HOME_FAKE/.ssh/id_plain"
ssh-keygen -q -t ed25519 -N "$PASS" -C pass-ed25519 -f "$HOME_FAKE/.ssh/id_pass"
ssh-keygen -q -t rsa -b 3072 -m PEM -N "$PASS" -C pass-pem -f "$HOME_FAKE/.ssh/id_pem"
grep -q "Proc-Type: 4,ENCRYPTED" "$HOME_FAKE/.ssh/id_pem" && ok "keys generated (plain, OpenSSH+passphrase, PEM+passphrase)"

cat > "$WORK/gitsshd/Dockerfile" <<'EOF'
FROM alpine:3.20
RUN apk add --no-cache openssh git \
 && adduser -D -s /usr/bin/git-shell git && passwd -u git \
 && mkdir -p /home/git/.ssh /srv/git && ssh-keygen -A \
 && git init -q --bare -b main /srv/git/repo.git && chown -R git:git /home/git /srv/git
COPY entry.sh /entry.sh
CMD ["sh", "/entry.sh"]
EOF
cat > "$WORK/gitsshd/entry.sh" <<'EOF'
printf '%s\n' "$AUTHORIZED_KEYS" > /home/git/.ssh/authorized_keys
chown git:git /home/git/.ssh/authorized_keys && chmod 600 /home/git/.ssh/authorized_keys
d=$(mktemp -d) && chown git:git "$d"
su git -s /bin/sh -c "cd $d && git init -q -b main && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init && git push -q /srv/git/repo.git main"
exec /usr/sbin/sshd -D -e -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no
EOF
docker build -q -t spunto-test-gitsshd "$WORK/gitsshd" >/dev/null
docker network inspect mp-shared-net >/dev/null 2>&1 || docker network create mp-shared-net >/dev/null
docker rm -f gitsshd >/dev/null 2>&1 || true
docker run -d --name gitsshd --network mp-shared-net \
  -e AUTHORIZED_KEYS="$(cat "$HOME_FAKE"/.ssh/id_plain.pub "$HOME_FAKE"/.ssh/id_pass.pub "$HOME_FAKE"/.ssh/id_pem.pub)" \
  spunto-test-gitsshd >/dev/null
ok "gitsshd running on mp-shared-net"
REPO="ssh://git@gitsshd/srv/git/repo.git"

# ── Stack ──────────────────────────────────────────────────────────────────────
start_stack() {
  compose "$@" up -d --force-recreate spunto-lite >/dev/null 2>&1
  for _ in $(seq 1 60); do curl -sf -o /dev/null "$BASE/api/health" && return 0; sleep 1; done
  echo "app did not come up"; compose logs spunto-lite | tail -30; exit 1
}
step "stack"
[ "${BUILD:-0}" = 1 ] && compose build spunto-lite
start_stack
ok "spunto-lite up at $BASE"
docker pull -q "$IMAGE" >/dev/null

PROJECT=$(api POST /api/projects -d "$(jq -n --arg img "$IMAGE" --arg url "$REPO" \
  '{name: "ssh-passphrase-\(now|floor)", image: $img,
    repositories: [{id: "r1", provider: "git", project: "test/repo", workspacePath: "repo", cloneUrl: $url}]}')" | jq -r .id)
ok "project $PROJECT (clones $REPO)"

select_key() { api PATCH /api/settings -d "{\"sshKeyPath\":\"$1\"}" >/dev/null; }
status() { api GET /api/settings/ssh-agent; }
spawn() {
  local id; id=$(api POST "/api/projects/$PROJECT/workers" -d '{}' | jq -r .id)
  for _ in $(seq 1 300); do
    local s; s=$(api GET "/api/workers/$id" | jq -r .state)
    case "$s" in ready|error) echo "$id $s"; return 0 ;; esac
    sleep 2
  done
  echo "$id timeout"
}
container() { api GET "/api/workers/$1" | jq -r .containerId; }
in_worker() { docker exec -u vscode "$(container "$1")" bash -lc "$2" </dev/null; }
# What a user types in the worker's terminal (docker exec, no TTY behind ssh's back).
remote_ok() {
  in_worker "$1" "ssh -o BatchMode=yes -T git@gitsshd 2>&1 | grep -q 'git-shell\|interactive git shell\|fatal' && git ls-remote $REPO | grep -q refs/heads/main"
}

# ── 1. No passphrase — non-regression ─────────────────────────────────────────
step "1. key without passphrase (non-regression)"
select_key id_plain
[ "$(status | jq -r .key.encrypted)" = false ] && ok "detected as not encrypted"
read -r W1 S1 < <(spawn)
[ "$S1" = ready ] && ok "worker ready, repo cloned by the setup script" || ko "worker state: $S1"
remote_ok "$W1" && ok "ssh -T + git ls-remote inside the worker" || ko "git over SSH failed"
in_worker "$W1" "cd /workspace/repo && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m plain && git push -q origin HEAD:refs/heads/plain" \
  && ok "git push" || ko "git push failed"

# ── 2. Passphrase, nothing unlocked ────────────────────────────────────────────
step "2. key with passphrase, nothing unlocked"
select_key id_pass
st=$(status)
[ "$(jq -r .key.encrypted <<<"$st")" = true ] && ok "detected as encrypted"
[ "$(jq -r .usable <<<"$st")" = false ] && ok "status says unusable (UI banner shows)" || ko "status: $st"
[ "$(jq -r .workerSocket <<<"$st")" = true ] && ok "agent socket shared with workers" || ko "no worker socket: $st"
read -r W2 S2 < <(spawn)
[ "$S2" = error ] && ok "worker fails its clone (expected: no agent holds the key)" || ko "worker state: $S2 (expected error)"

# ── 3. Wrong then right passphrase ─────────────────────────────────────────────
step "3. unlock in Settings"
code=$(api POST /api/settings/ssh-agent -d '{"passphrase":"nope"}' -o /dev/null -w '%{http_code}')
[ "$code" = 400 ] && ok "wrong passphrase refused (400)" || ko "wrong passphrase → $code"
st=$(api POST /api/settings/ssh-agent -d "$(jq -n --arg p "$PASS" '{passphrase: $p}')")
[ "$(jq -r .unlocked <<<"$st")" = true ] && [ "$(jq -r .usable <<<"$st")" = true ] && ok "unlocked" || ko "unlock: $st"
docker logs spunto-lite 2>&1 | grep -qF "$PASS" && ko "passphrase found in the app logs!" || ok "passphrase absent from the app logs"
docker exec spunto-lite grep -rqsF "$PASS" /app/data /tmp && ko "passphrase found on disk!" || ok "passphrase absent from /app/data and /tmp"
W1C=$(container "$W1")
docker exec -u vscode "$W1C" bash -lc 'ssh-add -l' | grep -q pass-ed25519 \
  && ok "an already-running worker sees the unlocked key (ssh-add -l)" || ko "running worker doesn't see the key"
read -r W3 S3 < <(spawn)
[ "$S3" = ready ] && ok "new worker ready, repo cloned with the passphrase-protected key" || ko "worker state: $S3"
remote_ok "$W3" && ok "ssh -T + git ls-remote" || ko "git over SSH failed"
in_worker "$W3" "cd /workspace/repo && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m pass && git push -q origin HEAD:refs/heads/pass" \
  && ok "git push" || ko "git push failed"
in_worker "$W3" "grep -q ENCRYPTED ~/.ssh/mp_user_key || grep -q 'BEGIN OPENSSH' ~/.ssh/mp_user_key" && ok "the key in the worker is still the encrypted file"

# ── 4. Legacy PEM key ──────────────────────────────────────────────────────────
step "4. legacy PEM key with passphrase"
select_key id_pem
[ "$(status | jq -r .unlocked)" = false ] && ok "switching key: the new one is locked"
st=$(api POST /api/settings/ssh-agent -d "$(jq -n --arg p "$PASS" '{passphrase: $p}')")
[ "$(jq -r .unlocked <<<"$st")" = true ] && ok "unlocked" || ko "unlock: $st"
read -r W4 S4 < <(spawn)
[ "$S4" = ready ] && ok "worker ready" || ko "worker state: $S4"
remote_ok "$W4" && ok "ssh -T + git ls-remote" || ko "git over SSH failed"

# ── 5. Lock ────────────────────────────────────────────────────────────────────
step "5. lock"
st=$(api DELETE /api/settings/ssh-agent)
[ "$(jq -r .unlocked <<<"$st")" = false ] && [ "$(jq -r .usable <<<"$st")" = false ] && ok "locked" || ko "lock: $st"
remote_ok "$W4" && ko "still works after lock" || ok "git over SSH refused again in the running worker"

# ── 6. Host agent forwarding ───────────────────────────────────────────────────
step "6. host agent forwarded (no unlock in Spunto Lite)"
select_key id_pass
eval "$(ssh-agent -s -a "$WORK/hostagent/agent.sock")" >/dev/null
printf '#!/bin/sh\nexec head -n 1\n' > "$WORK/askpass" && chmod +x "$WORK/askpass"
echo "$PASS" | SSH_ASKPASS="$WORK/askpass" SSH_ASKPASS_REQUIRE=force ssh-add -q "$HOME_FAKE/.ssh/id_pass"
chmod 666 "$WORK/hostagent/agent.sock"
cat > "$WORK/compose.hostagent.yml" <<EOF
services:
  spunto-lite:
    volumes:
      - $WORK/hostagent/agent.sock:/run/host-services/ssh-auth.sock
EOF
start_stack -f "$WORK/compose.hostagent.yml"
st=$(status)
[ "$(jq -r .hostAgent.hasKey <<<"$st")" = true ] && [ "$(jq -r .usable <<<"$st")" = true ] && [ "$(jq -r .unlocked <<<"$st")" = false ] \
  && ok "host agent holds the key, usable without unlocking" || ko "status: $st"
read -r W6 S6 < <(spawn)
[ "$S6" = ready ] && ok "worker ready" || ko "worker state: $S6"
remote_ok "$W6" && ok "ssh -T + git ls-remote through the host agent" || ko "git over SSH failed"
kill "$SSH_AGENT_PID"

# ── 7. Restart forgets ─────────────────────────────────────────────────────────
step "7. restart forgets the passphrase"
api POST /api/settings/ssh-agent -d "$(jq -n --arg p "$PASS" '{passphrase: $p}')" | jq -e .unlocked >/dev/null && ok "unlocked"
start_stack
[ "$(status | jq -r .unlocked)" = false ] && ok "locked again after restart" || ko "still unlocked after restart"

# ── Cleanup ────────────────────────────────────────────────────────────────────
for w in "$W1" "$W2" "$W3" "$W4" "$W6"; do api DELETE "/api/workers/$w" >/dev/null || true; done
api DELETE "/api/projects/$PROJECT" >/dev/null || true
select_key id_pass
if [ "${KEEP:-1}" = 0 ]; then compose down >/dev/null 2>&1; docker rm -f gitsshd >/dev/null; fi

echo
[ "$fails" = 0 ] && printf '\033[32mall checks passed\033[0m\n' || { printf '\033[31m%s check(s) failed\033[0m\n' "$fails"; exit 1; }
