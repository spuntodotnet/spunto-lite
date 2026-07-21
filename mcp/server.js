#!/usr/bin/env node
// Serveur MCP (stdio) pour piloter un navigateur depuis Claude Code — vendored
// depuis `spuntodotnet/browser-remote` (`mcp/server.js`) et gardé volontairement
// autonome dans ce repo pour que les outils vivent avec spunto-lite (pas de
// paquet npm à publier/installer séparément).
//
// Il expose le navigateur comme un jeu d'outils qu'un agent IA découvre
// automatiquement (`browser_snapshot`, `browser_navigate`, `browser_click`,
// `browser_type`, `browser_screenshot`, `browser_read_ax`, `browser_list_tabs`).
// Pont léger : chaque outil appelle l'API REST haut-niveau `/api/agent/*` d'une
// instance `browser-remote` (celle-ci doit tourner et être joignable — voir
// `docker-compose.yml`, service `browser-remote`, profil `browser`).
//
// Ce fichier est lancé par Claude Code via `.mcp.json` à la racine du repo
// (`node mcp/server.js`, env `BROWSER_REMOTE_URL`). Voir `mcp/README.md`.
//
// Dépendances : `@modelcontextprotocol/sdk` (devDependency) + `zod` (déjà dans
// les deps de spunto-lite). Repo en `type: module` → imports ESM natifs.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = (process.env.BROWSER_REMOTE_URL || "http://localhost:3005").replace(/\/$/, "");

// Onglet ciblé par cette session MCP :
//   - "active"      → l'onglet que l'humain regarde (co-pilotage)
//   - un id         → un onglet précis
//   - non défini    → l'agent s'ouvre SON PROPRE onglet à la 1ʳᵉ action
//                     (autonomie : découplé de ce que l'humain regarde ;
//                      plusieurs sessions = onglets distincts = parallèle).
const FIXED_TAB = process.env.BROWSER_REMOTE_TAB || "";
let ownTab = null;

async function sessionTab() {
  if (FIXED_TAB) return FIXED_TAB;
  if (ownTab) return ownTab;
  const r = await raw("tabs", {}, "POST"); // crée un onglet dédié
  ownTab = r.tab;
  console.error(`browser-remote MCP : onglet dédié ${ownTab}`);
  return ownTab;
}

// Appel bas niveau (sans injection de tab) — pour la gestion d'onglets.
async function raw(verb, body, method = "POST") {
  const res = await fetch(`${BASE}/api/agent/${verb}`, {
    method,
    headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
    body: method === "POST" ? JSON.stringify(body || {}) : undefined,
  });
  const json = await res.json().catch(() => ({ ok: false, error: `réponse non-JSON (HTTP ${res.status})` }));
  if (json.ok === false) throw new Error(json.error || "échec de l'action");
  return json;
}

// Appel d'un verbe d'action, ciblé sur l'onglet de la session (via ?tab=, qui
// marche pour GET comme pour POST).
async function call(verb, body, method = "POST") {
  const tab = await sessionTab();
  const qs = `?tab=${encodeURIComponent(tab)}`;
  const res = await fetch(`${BASE}/api/agent/${verb}${qs}`, {
    method,
    headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
    body: method === "POST" ? JSON.stringify({ ...body, tab }) : undefined,
  });
  const json = await res.json().catch(() => ({ ok: false, error: `réponse non-JSON (HTTP ${res.status})` }));
  if (json.ok === false) throw new Error(json.error || "échec de l'action");
  return json;
}

function text(obj) {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}

const server = new McpServer({ name: "browser-remote", version: "0.1.0" });

server.tool(
  "browser_snapshot",
  "Lit l'état de la page : URL, titre, texte rendu, et la liste des éléments " +
    "interactifs (liens/boutons/champs) avec un `ref` stable chacun. TOUJOURS " +
    "appeler ceci avant de cliquer/saisir : les `ref` servent à cibler les " +
    "éléments sans ambiguïté. Traverse le shadow DOM.",
  {},
  async () => text(await call("snapshot", {}, "GET")),
);

server.tool(
  "browser_navigate",
  "Ouvre une URL dans l'onglet courant et attend le chargement.",
  { url: z.string().describe("URL absolue (https://…)") },
  async ({ url }) => text(await call("navigate", { url })),
);

server.tool(
  "browser_click",
  "Clique un élément. Cible de préférence par `ref` (issu de browser_snapshot). " +
    "À défaut par `text` (libellé/aria-label, sous-chaîne) ou par coordonnées `x`/`y` " +
    "(pixels CSS). Renvoie ce qui a été cliqué.",
  {
    ref: z.string().optional().describe("ref d'un élément d'un snapshot récent (recommandé)"),
    text: z.string().optional().describe("libellé de l'élément si pas de ref"),
    x: z.number().optional(),
    y: z.number().optional(),
  },
  async (args) => text(await call("click", args)),
);

server.tool(
  "browser_type",
  "Saisit une valeur dans un champ (par `ref`, `selector` CSS, ou `field` = " +
    "placeholder/label/name). Pose la valeur via le setter DOM natif (robuste aux " +
    "raccourcis clavier). `submit:true` presse Entrée après.",
  {
    value: z.string().describe("texte à saisir"),
    ref: z.string().optional(),
    selector: z.string().optional(),
    field: z.string().optional().describe("placeholder / label / name du champ"),
    submit: z.boolean().optional(),
  },
  async (args) => text(await call("type", args)),
);

server.tool(
  "browser_screenshot",
  "Capture la page visible en PNG. Utile quand la structure (snapshot) ne suffit " +
    "pas à comprendre l'écran.",
  {},
  async () => {
    const r = await call("screenshot", {}, "GET");
    return { content: [{ type: "image", data: r.base64, mimeType: r.mimeType }] };
  },
);

server.tool(
  "browser_read_ax",
  "Arbre d'accessibilité compact (rôles + noms + valeurs). Alternative légère au " +
    "snapshot quand on ne veut que « qu'y a-t-il à l'écran » sans coordonnées.",
  {},
  async () => text(await call("ax", {}, "GET")),
);

server.tool(
  "browser_list_tabs",
  "Liste tous les onglets ouverts (id, url, titre) — y compris ceux d'autres " +
    "sessions ou de l'humain. Cette session agit par défaut sur son propre onglet.",
  {},
  async () => text((await raw("tabs", null, "GET")).tabs),
);

const transport = new StdioServerTransport();

// À la fin de la session, refermer l'onglet dédié qu'on a ouvert — ne pas
// laisser fuiter des onglets dans le navigateur partagé. On NE ferme PAS un
// onglet explicitement ciblé (FIXED_TAB : "active" ou un id fourni) qui ne nous
// appartient pas. Déclenché par tous les chemins d'arrêt possibles (le client
// peut fermer stdin OU tuer le process par signal), idempotent.
let cleaning = false;
async function cleanup() {
  if (cleaning || !ownTab) return;
  cleaning = true;
  try {
    await raw(`tabs/${encodeURIComponent(ownTab)}`, null, "DELETE");
  } catch {
    /* best-effort */
  }
}
// Un hôte MCP ferme un serveur stdio en fermant stdin, puis SIGTERM, puis
// SIGKILL — on couvre les deux premiers maillons (le 3ᵉ est non-interceptable).
transport.onclose = () => cleanup().finally(() => process.exit(0));
process.stdin.on("end", () => cleanup().finally(() => process.exit(0)));
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => cleanup().finally(() => process.exit(0)));
}

await server.connect(transport);
console.error(`browser-remote MCP prêt → ${BASE}${FIXED_TAB ? ` (tab=${FIXED_TAB})` : " (onglet dédié)"}`);
