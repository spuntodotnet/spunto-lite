# Serveurs MCP

On **déclare des serveurs MCP** par leur URL, on **s'y connecte en OAuth depuis Settings**, et les
**sessions des tâches** (Claude Code comme Codex) les ont sans une ligne de config dans le dépôt.
La session ne voit jamais le serveur de l'éditeur ni son jeton : elle appelle la **passerelle** de
Lite avec le jeton de sa tâche, et Lite relaie avec le jeton qu'il détient. C'est la
fonctionnalité *serveurs MCP d'organisation* de Spunto Cloud (RFC 0049 et `docs/mcp-servers.md`
du dépôt Cloud), portée dans Lite ; cette page dit **ce qui est pareil, ce qui diffère dans Lite,
et pourquoi**.

## Déclarer, se connecter

**Settings → MCP servers.** À la déclaration (`POST /api/mcp-servers`), Lite envoie un
`initialize` sans jeton et en déduit le mode :

| `auth` | Quand |
|---|---|
| `none` | le serveur répond |
| `oauth` | `401` + métadonnées OAuth (RFC 9728, découvertes par `WWW-Authenticate` ou au chemin bien connu) |
| `header` | on a donné un en-tête (clé d'API) — obligatoire si le serveur demande un credential sans annoncer d'OAuth. Nom et valeur chiffrés |

**Connect** (`POST /api/mcp-servers/:id/connect`) renvoie l'URL d'autorisation de l'éditeur. Le
client OAuth est :

1. enregistré par **Dynamic Client Registration** (RFC 7591) à la première connexion, et gardé
   sur le serveur ;
2. sinon un `clientId` / `clientSecret` saisi à la déclaration (option *« I registered a client
   myself »* du formulaire), enregistré à la main chez l'éditeur avec l'URI de retour
   `<origine de Lite>/api/mcp/oauth/callback`.

PKCE S256, `resource` (RFC 8707) dans les deux requêtes, `iss` vérifié au retour (RFC 9207). Le
retour arrive sur `GET /api/mcp/oauth/callback`, puis sur `/settings?mcpConnected=<nom>` ou
`?mcpError=<raison>` (un toast le dit). **Reconnect** apparaît quand la connexion est en
`needs_reauth` ; **Disconnect** oublie les jetons, effectif à l'appel suivant.

## Par projet

Chaque serveur a un **mode**, l'interrupteur de sa ligne dans Settings : `default` — donné aux
tâches de chaque projet sauf s'il l'éteint — ou `optional` — seulement aux projets qui
l'allument. Un projet s'en écarte par **Edit project → MCP servers**
(`GET/PUT /api/projects/:id/mcp-servers`, `DELETE /api/projects/:id/mcp-servers/:serverId`) : une
ligne `project_mcp_settings` n'existe que pour **différer** du mode ; remettre l'interrupteur sur
la valeur du mode efface la ligne, pour que le projet continue de suivre le serveur. Hors de la
config versionnée : ni version, ni rebuild, lu à la session suivante.

Le choix vaut **à deux endroits** : `taskMcpServers` ne met dans `SPUNTO_AGENT_MCP` que les
serveurs allumés pour le projet de la tâche, et la passerelle répond 404 à un jeton dont le projet
a le serveur éteint.

## Dans la session

À chaque démarrage de session (premier tour **et** reprise), `services/tasks.ts` pose :

- `SPUNTO_AGENT_MCP` — `taskMcpServers(projectId)`, notre vocabulaire, aucun jeton :
  `[{"name":"notion","path":"/api/mcp-gateway/<id>"}]`. Un serveur OAuth sans connexion valable
  n'y est **pas** : une session sans l'outil vaut mieux qu'une session avec un outil cassé ;
- `SPUNTO_WORKER_TOKEN` — un jeton `lmg_…` frais, `mintMcpGatewayToken(taskId, projectId)` ;
- `SPUNTO_API_URL` — l'URL par laquelle un worker joint Lite (`internalUrl()`, `lib/agent.ts`).

Les runners de `@spunto/build` traduisent, sans rien savoir de Lite : Claude →
`mcpServers[name] = { type: "http", url, headers: { Authorization: "Bearer $SPUNTO_WORKER_TOKEN" } }`,
Codex → `mcp_servers[name] = { url, bearer_token_env_var: "SPUNTO_WORKER_TOKEN" }`.

## La passerelle

`GET/POST/DELETE /api/mcp-gateway/:serverId` (`app/api/mcp-gateway/[serverId]/route.ts`) :

- authentifiée par le jeton de la tâche (`lmg_…`, comparé par son SHA-256) — **403** et non 401
  sinon, pour qu'un client MCP n'aille pas chercher un serveur OAuth chez nous ;
- le serveur doit être allumé pour le projet du jeton (404 sinon) ;
- relaie `Content-Type`, `Accept`, `Mcp-Session-Id`, `MCP-Protocol-Version`, `Last-Event-Id` ;
  **`Authorization` est remplacé** (jeton de l'éditeur ou en-tête statique), jamais transmis ; la
  réponse (JSON ou SSE) est **streamée telle quelle**, avec `Content-Type` et `Mcp-Session-Id` ;
- `401` de l'éditeur → refresh forcé et un seul nouvel essai. Refresh refusé → connexion en
  `needs_reauth` ;
- toute impossibilité répond une **erreur JSON-RPC** à l'`id` de la requête (HTTP 200), que
  l'agent peut répéter : « *notion is not connected (Settings → MCP servers → notion → Connect)* ».

## Ce qui est pareil que dans Cloud

Le client OAuth (découverte RFC 9728 / 8414 / OIDC, DCR, PKCE, `resource`, `iss`), les trois
modes `none` / `oauth` / `header`, le mode `default` / `optional` et l'écart par projet, la
passerelle et ses messages, le refresh unique sur `401`, `SPUNTO_AGENT_MCP` et les runners, qui
sont ceux du paquet partagé. Les fichiers sont le portage presque ligne à ligne de
`mcp-oauth.ts` et `mcp-servers.service.ts`.

## Ce qui diffère, et pourquoi

- **Pas d'organisation, pas de rôles, pas de flag.** Lite a un seul utilisateur : tout le monde
  déclare, connecte et règle — et la fonctionnalité est simplement là.
- **Une connexion par serveur.** Cloud distingue `member` (chaque membre connecte son compte) et
  `org` (une connexion partagée) ; avec un seul utilisateur les deux reviennent au même :
  `mcp_connections` a `server_id` pour clé, sans `user_id`, et le callback n'a pas à vérifier
  que c'est « la même personne » qui revient.
- **Pas de Client ID Metadata Document.** Le serveur d'autorisation devrait aller lire notre
  document sur une URL HTTPS publique ; Lite tourne sur `localhost`. Reste DCR, ou un client
  saisi à la main (cas de GitHub). Comme l'URI de retour est l'**origine de la requête**
  (`localhost`, un domaine local, le listener HTTPS…), un client enregistré par DCR l'est de
  nouveau si l'on se connecte depuis une autre origine.
- **Pas de restriction SSRF.** Cloud exige que chaque URL appelée résolve vers une adresse
  publique, parce que son API partage le réseau de Postgres et d'applications internes, et que
  l'URL vient de n'importe quelle org. Lite est un outil local, et c'est son utilisateur qui
  déclare ses propres serveurs : un serveur MCP sur le LAN ou sur `localhost` est un usage
  légitime. Les redirections, elles, ne sont toujours pas suivies.
- **Un jeton de passerelle par tâche, pas le jeton de la machine.** Dans Cloud, la session montre
  `SPUNTO_WORKER_TOKEN`, l'identité de son worker, qui sert aussi au credential helper git. Lite
  n'a pas d'équivalent : il frappe un `lmg_…` à chaque démarrage de session, stocké haché dans
  `mcp_gateway_tokens`, lié à la tâche (et à son projet). Les jetons précédents de la même tâche
  restent valables — une session reprise peut garder l'ancien — et meurent avec la ligne de la
  tâche (`ON DELETE CASCADE`). Le runner le lit sous le même nom de variable : rien à changer
  dans le paquet partagé.
- **Le refresh sous verrou en mémoire.** Cloud fait `SELECT … FOR UPDATE` sur la connexion (un
  refresh token est souvent à usage unique : deux refresh concurrents perdraient la connexion).
  Lite est un seul processus : une promesse par serveur, que les appels concurrents rejoignent.
  Un jeton refusé alors qu'un autre appel l'a déjà remplacé n'est pas rafraîchi une seconde fois.

## Sécurité

- **Aucun credential d'éditeur dans le worker.** Le pire pour un agent compromis : appeler les
  outils tant que sa tâche existe, ce qu'il pouvait déjà faire. *Disconnect* ou l'interrupteur du
  projet coupent à l'appel suivant.
- Les jetons, secrets de client, en-têtes et verifiers PKCE sont chiffrés (`lib/crypto.ts`) ; les
  routes ne renvoient jamais ni jeton ni valeur d'en-tête.

## Données

| Table | |
|---|---|
| `mcp_servers` | `name` (unique), `url`, `auth`, `mode`, `oauth` (métadonnées découvertes), `client_id`, secret, nom et valeur d'en-tête chiffrés |
| `mcp_connections` | une par serveur : jetons chiffrés, `expires_at`, `status` `ok` / `needs_reauth`, `scope` |
| `project_mcp_settings` | `(project_id, server_id)` unique, `enabled` : l'écart d'un projet au mode du serveur |
| `mcp_oauth_states` | une autorisation en cours (15 min) : verifier PKCE chiffré, issuer attendu, URI de retour |
| `mcp_gateway_tokens` | SHA-256 d'un `lmg_…`, sa tâche (cascade) et son projet |

## Vérifier

```bash
npx tsx scripts/test-mcp-servers.ts
```

Un faux éditeur (serveur MCP + serveur d'autorisation) en processus, une base SQLite jetable, les
route handlers appelés comme des fonctions : découverte, DCR, PKCE, `iss`, callback, passerelle
(jeton de l'éditeur et jamais `lmg_`, en-tête statique, SSE streamé), refresh unique y compris
pour des appels concurrents, `needs_reauth`, réglages par projet, jetons morts avec leur tâche.

## Où c'est

| Quoi | Où |
|---|---|
| Client OAuth MCP (découverte, enregistrement, PKCE, échange, refresh) | `lib/mcp-oauth.ts` |
| Serveurs, connexions, `accessToken`, `taskMcpServers`, `mintMcpGatewayToken` | `services/mcp-servers.ts` |
| Routes | `app/api/mcp-servers/**`, `app/api/mcp/oauth/callback`, `app/api/projects/[id]/mcp-servers/**` |
| Passerelle | `app/api/mcp-gateway/[serverId]/route.ts` |
| Pages | `components/mcp-servers-card.tsx` (Settings), `components/project-mcp-servers-card.tsx` (Edit project) |
| Test de bout en bout | `scripts/test-mcp-servers.ts` |
