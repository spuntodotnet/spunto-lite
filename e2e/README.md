# E2E tests

End-to-end tests for spunto-lite, mirroring the sibling [`spunto`](https://github.com/coderhammer/spunto)
project's approach: a single [Playwright](https://playwright.dev) runner split into projects —
an HTTP-only **API** suite and a **browser** suite that drives Chrome (locally, or
[`browser-remote`](https://github.com/spuntodotnet/browser-remote)'s shared Chrome over CDP).

spunto-lite has **no auth**, so — unlike `spunto` — there's no session/JWT forging: tests just
hit the open API and drive the open UI. Persistence is SQLite, so there's no database service to
stand up either.

## Projects (Playwright `--project=…`)

| Project | What | Browser? | Docker? |
|---|---|---|---|
| `api` | HTTP-only: health, catalogs, project CRUD + validation, secrets, settings | no | no |
| `browser` | UI: landing + nav, dashboard renders a seeded project | yes | no |
| `worker-lifecycle` | spawn a real worker container → ready → stop → delete | no | **yes** (opt-in) |

## Running

### 1. Fast API suite (host, no browser)

Boot the control plane on a test port, then run the `api` project:

```bash
# terminal 1 — the app (SQLite, no Docker needed for the api/browser control-plane tests)
PORT=3900 DATA_DIR=./.e2e-data npm run dev        # from the repo root

# terminal 2
cd e2e && npm install
E2E_BASE_URL=http://localhost:3900 npm run test:api
```

This is exactly what CI runs (`.github/workflows/e2e-api.yml`), against a freshly built app.

### 2. Browser suite (host, bundled Chromium)

```bash
cd e2e && npx playwright install chromium          # one-time
E2E_BASE_URL=http://localhost:3900 npm run test:browser
```

With no `CDP_ENDPOINT` set, the browser helper launches a local Chromium.

### 3. Full suite over browser-remote (compose, no bundled browsers)

The [`test` compose profile](../docker-compose.yml) runs the whole suite inside the network, so
both the Node `request` fixture and the CDP-driven browser reach the app at `http://spunto-lite`.
It connects to `browser-remote`'s Chrome over CDP — no ~400MB Playwright browser download.

```bash
docker compose up -d spunto-lite                   # the app on the compose network
docker compose --profile test run --rm e2e         # runs api + browser
# scope it: docker compose --profile test run --rm e2e sh -c "npm ci && npx playwright test --project=browser"
```

### 4. Worker lifecycle (real Docker)

Opt-in — needs a working Docker socket and pulls a devcontainer image on first run (minutes):

```bash
cd e2e && E2E_BASE_URL=http://localhost:3900 E2E_DOCKER=1 npm run test:worker
```

Without `E2E_DOCKER=1` the spec self-skips.

### 5. Feature-conflict repro (real Docker)

`tests/feature-*.spec.ts` reproduce feature-combination bugs on a real worker. Same opt-in as
above (`E2E_DOCKER=1`) — they run in the `worker-lifecycle` project and also need the `docker`
CLI on the runner (they inspect the worker container with `docker exec`).

```bash
cd e2e && E2E_BASE_URL=http://localhost:3900 E2E_DOCKER=1 npm run test:worker
```

- **`feature-docker-claude.spec.ts`** — the reported `docker-in-docker` + `claude-code` on
  `node:24` bug. Spawns the worker, then checks — as the `vscode` user, across login/non-login
  zsh and login bash — that both `claude` is on `PATH` and the Docker daemon is up and usable.
  It logs `[repro] …` lines for each shell so you can see exactly which tool breaks in which
  shell. Leading suspects: (1) the first-boot oh-my-zsh install uses `KEEP_ZSHRC=no`, which
  overwrites `~/.zshrc` and drops the `export PATH="$HOME/.local/bin:$PATH"` line the claude
  feature added at build time (so `claude` is missing in a non-login zsh); (2) Docker daemon
  startup / `vscode` docker-group timing. The test's per-shell logs disambiguate the two.

## Environment variables

| Var | Default | Meaning |
|---|---|---|
| `E2E_BASE_URL` | `http://localhost:3900` | Base URL for both the API client and the browser |
| `CDP_ENDPOINT` | *(unset)* | If set, drive browser-remote's Chrome over CDP instead of a local Chromium |
| `E2E_DOCKER` | *(unset)* | Set to `1` to run the `worker-lifecycle` project |

## Layout

```
e2e/
  playwright.config.ts   # 3 projects: api / browser / worker-lifecycle
  helpers/browser.ts     # custom `test` — local Chromium or browser-remote over CDP
  tests/
    health.spec.ts           (api)
    catalogs.spec.ts         (api)
    projects.spec.ts         (api)
    secrets.spec.ts          (api)
    settings.spec.ts         (api)
    landing.spec.ts              (browser)
    projects-ui.spec.ts          (browser)
    feature-docker-claude.spec.ts (worker-lifecycle, opt-in — dind+claude repro)
    worker-lifecycle.spec.ts (worker-lifecycle, opt-in)
```
