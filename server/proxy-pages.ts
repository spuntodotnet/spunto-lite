/**
 * The pages the worker proxy serves itself, in place of a bare « 502 Not reachable » — Cloud's
 * `apps/proxy/proxy-pages.js` (BAC-74, Cloud 1caae256), in Lite's colours.
 *
 * The one that matters is `kind: "stopped"`: opening ANY port of a stopped worker
 * (`worker-<id>-3000.<domain>`, its IDE…) offers a **Start workspace** button, which starts it
 * through the proxy's own `/__spunto/*` endpoints on that same host, polls until it is ready and
 * reloads the page that was asked for. Starting is on the click only, never on the visit: a
 * worker stopped by a park, by hand or by a crash stays so until someone says otherwise.
 *
 * Everything is inlined (CSS and JS, no asset): the page must render with the worker behind it
 * completely down.
 */

export type ProxyPageKind = "stopped" | "starting" | "unavailable" | "notfound"

export const STATE_LABELS: Record<string, string> = {
  provisioning: "Provisioning…",
  building: "Building image…",
  starting: "Starting…",
  ready: "Ready",
  stopped: "Stopped",
  error: "Error",
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
}

// Tokens copied from `@spunto/design-system/styles.css` — the base layer and the `lite` product
// paint (ink blue / sky), light and dark — so the page looks like the rest of Lite without Tailwind.
const STYLES = `
:root {
  --background: oklch(0.975 0.012 82);
  --foreground: oklch(0.20 0.018 55);
  --card: oklch(0.995 0.006 86);
  --muted: oklch(0.955 0.012 80);
  --muted-foreground: oklch(0.51 0.032 60);
  --primary: oklch(0.49 0.14 258);
  --primary-foreground: oklch(0.99 0.006 255);
  --destructive: oklch(0.577 0.245 27.325);
  --border: oklch(0.89 0.016 76);
  --radius: 0.25rem;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --background: oklch(0.155 0.011 52);
    --foreground: oklch(0.95 0.009 78);
    --card: oklch(0.195 0.012 52);
    --muted: oklch(0.23 0.014 52);
    --muted-foreground: oklch(0.67 0.022 66);
    --primary: oklch(0.85 0.10 228);
    --primary-foreground: oklch(0.27 0.06 255);
    --destructive: oklch(0.704 0.191 22.216);
    --border: oklch(0.92 0.03 70 / 11%);
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1.5rem;
  background: var(--background); color: var(--foreground);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  font-size: 15px; line-height: 1.55;
}
.wrap { width: 100%; max-width: 30rem; }
.brand { margin: 0 0 1rem 0.125rem; font-size: 0.8125rem; font-weight: 600; letter-spacing: -0.01em; color: var(--muted-foreground); }
.card {
  background: var(--card); border: 1px solid var(--border); border-radius: calc(var(--radius) * 2); padding: 2rem;
  box-shadow: 0 1px 2px oklch(0 0 0 / 6%), 0 8px 24px -12px oklch(0 0 0 / 12%);
}
.subject {
  display: inline-flex; align-items: center; gap: 0.4rem; margin-bottom: 1rem; padding: 0.2rem 0.5rem;
  font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.75rem; word-break: break-all;
  color: var(--muted-foreground); background: var(--muted); border: 1px solid var(--border); border-radius: var(--radius);
}
h1 { font-size: 1.375rem; line-height: 1.25; letter-spacing: -0.02em; margin: 0 0 0.5rem; }
p { margin: 0 0 0.75rem; color: var(--muted-foreground); }
p:last-of-type { margin-bottom: 0; }
.dot { width: 0.5rem; height: 0.5rem; border-radius: 999px; flex: none; background: var(--muted-foreground); }
.dot.live { background: var(--primary); animation: pulse 1.6s ease-in-out infinite; }
.dot.bad { background: var(--destructive); }
@keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.25 } }
@media (prefers-reduced-motion: reduce) { .dot.live { animation: none } .spinner { animation-duration: 3s } }
.actions { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 1.5rem; }
button, a.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 0.45rem; padding: 0.5rem 0.9rem;
  font: inherit; font-size: 0.875rem; font-weight: 500; text-decoration: none; cursor: pointer;
  border-radius: var(--radius); border: 1px solid transparent; transition: opacity 0.15s ease, background-color 0.15s ease;
}
button.primary { background: var(--primary); color: var(--primary-foreground); }
button.primary:hover:not(:disabled) { opacity: 0.9; }
button:disabled { opacity: 0.6; cursor: default; }
button.ghost, a.btn.ghost { background: transparent; color: var(--foreground); border-color: var(--border); }
button.ghost:hover, a.btn.ghost:hover { background: var(--muted); }
.status { display: none; align-items: center; gap: 0.5rem; margin-top: 1rem; font-size: 0.8125rem; color: var(--muted-foreground); }
.status.show { display: flex; }
.status.bad { color: var(--destructive); }
.spinner {
  width: 0.875rem; height: 0.875rem; flex: none; border: 2px solid var(--border); border-top-color: var(--primary);
  border-radius: 999px; animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg) } }
.detail {
  margin-top: 1rem; padding-top: 0.875rem; border-top: 1px solid var(--border); word-break: break-word;
  font-size: 0.75rem; font-family: ui-monospace, "SF Mono", Menlo, monospace; color: var(--muted-foreground);
}
`

export type ProxyPage = {
  kind: ProxyPageKind
  title: string
  message: string
  /** A monospace chip of context: the worker and port. */
  subject?: string
  /** A small technical footnote — the error Docker gave, say. */
  detail?: string | null
  /** Draw the Start button (a worker that can be started). */
  canStart?: boolean
  /** Poll `/__spunto/status` straight away: the worker is already on its way. */
  autoPoll?: boolean
  /** The worker's state now — what the poll compares against. */
  state?: string | null
  /** Draw a Retry button (a plain reload). */
  canRetry?: boolean
  /** The worker's page in Lite. */
  dashboardUrl: string
}

/** A branded page, its controller inlined when it has something to do. */
export function renderPage(opts: ProxyPage): string {
  const { kind, title, message, subject, detail, canStart = false, autoPoll = false, state = null, canRetry = false, dashboardUrl } = opts
  const dotClass = kind === "starting" ? "dot live" : kind === "unavailable" || kind === "notfound" ? "dot bad" : "dot"

  const buttons: string[] = []
  if (canStart) {
    buttons.push(
      `<button id="start" class="primary" type="button">` +
        `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.14v13.72a1 1 0 0 0 1.53.85l10.79-6.86a1 1 0 0 0 0-1.7L9.53 4.29A1 1 0 0 0 8 5.14Z"/></svg>` +
        `Start workspace</button>`,
    )
  }
  if (canRetry) buttons.push(`<button id="retry" class="ghost" type="button">Retry</button>`)
  buttons.push(`<a class="btn ghost" href="${escapeHtml(dashboardUrl)}">Open in Spunto Lite</a>`)

  const needsScript = canStart || autoPoll || canRetry
  // `<` escaped so a label can never close the script tag.
  const cfg = JSON.stringify({ state, autoPoll, labels: STATE_LABELS }).replace(/</g, "\\u003c")

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · Spunto Lite</title>
<style>${STYLES}</style>
</head>
<body>
<div class="wrap">
  <div class="brand">Spunto Lite</div>
  <div class="card">
    ${subject ? `<div class="subject"><span class="${dotClass}"></span>${escapeHtml(subject)}</div>` : ""}
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    <div class="actions">${buttons.join("")}</div>
    <div class="status" id="status"><span class="spinner"></span><span id="status-text"></span></div>
    ${detail ? `<div class="detail">${escapeHtml(detail)}</div>` : ""}
  </div>
</div>
${needsScript ? `<script>${CLIENT_SCRIPT.replace("__CFG__", cfg)}</script>` : ""}
</body>
</html>
`
}

// The controller: POST /__spunto/start, then poll /__spunto/status until the worker is ready and
// reload the URL that was asked for. Same as Cloud's.
const CLIENT_SCRIPT = `
(function () {
  var CFG = __CFG__;
  var startBtn = document.getElementById("start");
  var retryBtn = document.getElementById("retry");
  var statusEl = document.getElementById("status");
  var statusText = document.getElementById("status-text");
  var expected = CFG.state;
  var polling = false;

  function setStatus(text, isBad) {
    statusText.textContent = text;
    statusEl.classList.add("show");
    statusEl.classList.toggle("bad", !!isBad);
    statusEl.querySelector(".spinner").style.visibility = isBad ? "hidden" : "visible";
  }
  function label(state) { return CFG.labels[state] || state; }

  async function poll() {
    if (polling) return;
    polling = true;
    var deadline = Date.now() + 15 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise(function (r) { setTimeout(r, 2000); });
      var data;
      try {
        var res = await fetch("/__spunto/status", { headers: { Accept: "application/json" }, cache: "no-store" });
        data = await res.json();
      } catch (e) { continue; }
      if (data.state === "ready") { setStatus("Workspace ready — reloading…"); location.reload(); return; }
      // Any other move (back to stopped, an error…) is best drawn again by the server.
      if (data.state !== expected) { location.reload(); return; }
      setStatus(label(data.state));
    }
    polling = false;
    setStatus("Still not ready after 15 min — look at it in Spunto Lite.", true);
  }

  if (startBtn) {
    startBtn.addEventListener("click", async function () {
      startBtn.disabled = true;
      setStatus("Starting the workspace…");
      var data = {};
      try {
        var res = await fetch("/__spunto/start", { method: "POST", headers: { Accept: "application/json" } });
        data = await res.json().catch(function () { return {}; });
        if (!res.ok) {
          startBtn.disabled = false;
          setStatus(data.error || "Start failed.", true);
          return;
        }
      } catch (e) {
        startBtn.disabled = false;
        setStatus("Start failed (network error).", true);
        return;
      }
      expected = data.state || "starting";
      setStatus(label(expected));
      poll();
    });
  }

  if (retryBtn) retryBtn.addEventListener("click", function () { location.reload(); });

  if (CFG.autoPoll) { setStatus(label(CFG.state)); poll(); }
})();
`
