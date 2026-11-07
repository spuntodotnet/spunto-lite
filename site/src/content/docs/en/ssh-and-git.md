---
title: SSH keys and git
description: How your own SSH key clones and pushes from every workspace — passphrase-protected keys and agent forwarding included.
group: use
order: 3
---

Lite has no forge integration. A repository is a clone URL, and **your SSH key is the only
credential**: it is the identity your commits are pushed with, and the only thing that clones. That
is also why any host works — GitHub, GitLab, Bitbucket, a self-hosted Gitea, a bare repository on a
NAS. Authorise the key once, wherever, and every project clones and pushes.

## Where the key comes from

`~/.ssh` is mounted **read-only** into the Lite container (`-v "$HOME/.ssh:/host-ssh:ro"`).
**Settings → SSH keys** lists what it found and lets you choose the key to give workers. It is copied
into each worker at creation, so `git clone`, `git pull` and `git push` work in the terminal, in
the IDE and for an agent alike.

To use another directory, mount it at `/host-ssh` — or mount it anywhere and set `HOST_SSH_DIR`.

## Keys with a passphrase

A key without a passphrase is used as is. A key **with** one can't be: nobody is there to type the
passphrase behind a `git clone` run by the setup or a `git push` run by an agent. So it signs
through an **SSH agent** instead. Settings marks such a key with a *passphrase* badge, and a banner
says so on every page as long as nothing can use it. Two ways to give it an agent:

### Unlock it in Settings

Works everywhere, nothing to configure. Type the passphrase once: Lite loads the key into its own
`ssh-agent` and drops the passphrase — it is never written to disk, never stored in the database,
never logged. The decrypted key lives only in that agent's memory, so after a restart of Lite the
key is locked again and the banner asks for it. **Lock** forgets it at once.

### Forward your host's agent

If you already `ssh-add` the key on your machine (keychain, 1Password, `gpg-agent`…), mount the
agent's socket into the Lite container at `/run/host-services/ssh-auth.sock`:

```bash
# macOS — Docker Desktop's own forwarded agent
# (the launchd socket in $SSH_AUTH_SOCK can't be bind-mounted from macOS):
-v /run/host-services/ssh-auth.sock:/run/host-services/ssh-auth.sock

# Linux:
-v "$SSH_AUTH_SOCK:/run/host-services/ssh-auth.sock"
```

On Linux, the path of `$SSH_AUTH_SOCK` changes with each login session: recreate the container
after logging in again. Settings shows whether the host agent holds the selected key. A key
unlocked in Settings takes precedence over the host agent.

## How the agent reaches the workers

Every worker mounts the `spunto-lite-ssh-agent` volume and gets
`SSH_AUTH_SOCK=/run/spunto-ssh-agent/agent.sock`, a socket served by Lite that forwards to whichever
agent holds the key. It is a named volume because Docker Desktop can't carry a Unix socket through
a bind-mounted host directory. The socket is always there, so unlocking a key reaches the workers
that are already running.

Without that volume mounted on the Lite container, Settings says so: keys without a passphrase keep
working, keys with one don't.

> Like any agent forwarding, whatever runs in a worker can ask the agent to **sign** while the key
> is unlocked — it can't read the key itself. Lock it when you hand workers to code you don't trust.

The paths can be changed with `SSH_AGENT_DIR` (default `/run/spunto-ssh-agent`) and
`HOST_SSH_AUTH_SOCK` (default `/run/host-services/ssh-auth.sock`).

## HTTPS clone URLs

An HTTPS URL clones without a key when the repository is public. For a private one over HTTPS,
put a token in the URL's credentials or switch to the SSH URL — the SSH key is the path Lite is
built around.
