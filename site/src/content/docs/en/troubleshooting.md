---
title: Troubleshooting
description: The usual suspects — URLs that don't resolve, a port already taken, a clone that fails, a worker stuck in starting.
group: operate
order: 3
---

Start with Lite's own logs, and the worker page — its **Setup** steps say where a worker stopped:

```bash
docker logs -f spunto-lite
```

## `http://localhost` doesn't answer

- Is the container up? `docker ps --filter name=spunto-lite`.
- Is port 80 taken by something else (another web server, AirPlay Receiver on some macOS versions)?
  Run Lite on another port with `-p 8080:8080 -e PORT=8080`.

## `worker-….localhost` doesn't resolve

`*.localhost` is resolved by the browser itself in Chrome, Edge and Firefox. Safari, `curl` and
some tools don't always do it: use one of those browsers, or add the name to `/etc/hosts`. From
*inside* a container, `localhost` is the container itself — see
[Configuration](/docs/configuration#https-and-another-domain).

## The clone fails: `Permission denied (publickey)`

- **Settings → SSH keys**: is the key you expect selected, and is its public half on the git host?
- Does it have a *passphrase* badge? Unlock it in Settings, or forward your host's agent
  ([SSH keys and git](/docs/ssh-and-git)).
- Is the `spunto-lite-ssh-agent` volume mounted on the Lite container? Settings says so if not.
- From the worker's terminal: `ssh -T git@github.com` (or your host) shows what the server sees.

## A worker is stuck in `starting`, or in `error`

- The worker page shows the setup's steps and the one that failed: a feature that didn't install,
  a hook that exited non-zero, a clone that was refused.
- A `postCreateCommand` that never ends (a dev server started there instead of in
  `postStartCommand`) keeps the worker in `starting`: move long-running processes to
  `postStartCommand`, in the background.
- `error` with an exit code after it was `ready`: the container died on its own — often memory.
  Check the worker's logs and **Resources**.
- After an upgrade, a worker created by a much older Lite may need a **Rebuild** to get the
  current in-box agent and the SSH agent volume.

## The image build fails

Open the build's log from the project page. Usual causes: a base image that can't be pulled
(private registry — see [Configuration](/docs/configuration#private-base-images)), a feature whose
options don't fit the base image (e.g. one that expects Debian on an Alpine image), or no network.

## A secret, or a service's variable, isn't in the environment

Both are set when a worker is created. **Rebuild** the worker — `/workspace` is kept.

## The disk fills up

**Resources** lists every container, image and volume Lite owns, with its size. Delete the
workspaces you don't use; old project images go with their project. `docker system df` shows the
rest of the host's usage.

## Still stuck

Open an issue on [GitHub](https://github.com/spuntodotnet/spunto-lite/issues) with Lite's logs and
the worker's setup steps.
