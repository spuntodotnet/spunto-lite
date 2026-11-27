# Lite Connect : les tâches de ce Lite sur les appareils de son propriétaire

Lite tourne derrière un NAT, sans authentification. **Lite Connect** le rend joignable depuis les
appareils où son propriétaire est connecté à Spunto, l'app iPhone « Spunto Lite » d'abord :

- Lite **ouvre un tunnel** WebSocket vers Spunto Cloud ;
- Cloud y **relaie** une courte liste de routes de tâches ;
- Lite **revérifie** chaque requête, la sert par ses propres routes, et **émet** un événement quand
  une tâche rend la main ou échoue (Cloud en fait une notification).

Décision : RFC 0072 de `coderhammer/spunto`. Le contrat côté Cloud : son
[`docs/lite-connect.md`](https://github.com/coderhammer/spunto/blob/main/docs/lite-connect.md)
(module `apps/api/src/modules/lite/`). Ici :

| Fichier | Rôle |
|---|---|
| `lib/lite-relay.ts` | la liste blanche, copie exacte de celle de Cloud (`lite.relay.ts`) |
| `lib/lite-relay-url.ts` | l'URL locale où une requête permise est servie, rien d'autre |
| `services/lite-connect.ts` | la ligne `lite_connect`, l'appairage OAuth, les jetons |
| `services/lite-tunnel.ts` | le tunnel : `hello`, relais, reconnexions |
| `lib/lite-connect-hooks.ts` | les commandes du tunnel sur `globalThis`, pour les routes |
| `components/lite-connect-card.tsx` | Settings → **Connect to Spunto** |
| `scripts/fake-spunto-cloud.ts` | un faux Cloud (OAuth, révocation, tunnel), pour les tests et l'essai à la main |

## Coupé par défaut

Rien ne se connecte sans le bouton **Connect to Spunto**. Le tunnel ne s'ouvre au démarrage
(`startLiteTunnel`, `server.ts`) que si un refresh token est en base, et seul le retour du
consentement en écrit un. **Disconnect** le rend à Spunto, l'efface et ferme le tunnel.

La capacité par défaut est `read`. `reply` et `create` se cochent à la main ; `create` avertit qu'un
agent démarre alors sur cette machine, depuis un téléphone, avec la clé SSH et les secrets.

## L'appairage : un client OAuth public, scope `lite`

Comme un client MCP, contre le serveur d'autorisation de Spunto (`{spuntoUrl}`, `https://spunto.net`
par défaut, modifiable tant qu'on n'est pas connecté — pour le dev) :

1. **Inscription** `POST /api/oauth/register` : `{ client_name: <nom de la machine>, redirect_uris:
   [<origine de Lite>/api/lite-connect/callback], scope: "lite", token_endpoint_auth_method: "none" }`.
   Le `client_id` est gardé, avec l'URL de Spunto et le redirect URI pour lesquels il a été
   inscrit ; on ne réinscrit que si l'un des deux change (Lite ouvert depuis une autre origine).
   Les jetons encore en main sont alors ceux de l'ancien client, inutiles avec le nouveau : son
   refresh token est **rendu** (révocation, ci-dessous) puis oublié, avant l'inscription.
2. **Autorisation** : `GET /api/oauth/authorize` dans le navigateur, code + PKCE S256 + `state`
   (gardés 15 min dans la ligne, le verifier chiffré). Spunto montre sa page de consentement
   (« Spunto Lite », nom non vérifié) ; il faut y être connecté.
3. **Retour** sur `GET /api/lite-connect/callback` : `state` vérifié puis effacé quoi qu'il arrive,
   code échangé (`POST /api/oauth/token`, form-urlencoded), retour sur Settings avec un toast.

**Le redirect URI** est l'origine sous laquelle le navigateur voit Lite : Spunto n'accepte que
`https://…` ou `http://` en loopback (`localhost`, `127.0.0.1`). `http://localhost` (l'install par
défaut) et `https://<worker>-3000.spunto.net` passent ; `http://spunto-lite` ou une IP du LAN en
http sont refusés à l'inscription, avec le message de Spunto.

**Les jetons** : accès `spo_` (1 h), refresh `spr_` (30 j, **tourné à chaque usage** : le nouveau
est écrit aussitôt, l'ancien est mort). Chiffrés par `lib/crypto.ts` dans `lite_connect`, jamais
renvoyés par une route ni écrits dans un log. Seul le tunnel rafraîchit, une fois à la fois.

## Le tunnel

`wss://{host}/api/lite/connect` (`ws://` pour un Spunto en `http://`). Premier message :

```json
{ "type": "hello", "token": "spo_…", "name": "MacBook de Mathieu", "version": "0.1.0", "capabilities": ["read"] }
```

- **Avant chaque `hello`** le jeton d'accès est rafraîchi s'il lui reste moins de 5 minutes.
- `welcome` → `online` ; le `connectionId` (`lc_…`) est gardé et affiché.
- **Changer les capacités** ferme le tunnel et en rouvre un : Cloud les reprend à chaque `hello`.
  Le nom, lui, n'est pris par Cloud qu'à la création (renommer dans Spunto) : un nouveau nom vaut
  pour le prochain appairage.
- Cloud pinge toutes les 25 s ; 60 s sans rien entendre et le socket est tenu pour mort.

| Fermeture | Ce que fait Lite |
|---|---|
| `4401` jeton refusé | rafraîchit (forcé) et redit `hello` tout de suite ; refusé encore → délai croissant |
| refresh refusé (4xx du token endpoint) | **déconnecté** : jetons oubliés, la raison dans Settings |
| `4403` déconnecté depuis Spunto | **jetons oubliés, pas de reconnexion** ; « reconnecte depuis Settings ». Pendant la révocation de Disconnect, c'en est l'écho : le tunnel s'éteint, sans erreur |
| `4409` remplacé par un tunnel plus récent | attend 30 s : deux Lite qui partagent un lien ne se relaient pas chaque seconde |
| autre (coupure, redéploiement) | 1 s, 2 s, 4 s… jusqu'à 30 s ; remis à 1 s au `welcome` |

L'état (`off`, `connecting`, `online`, `retrying` + la dernière erreur) est lu par `GET
/api/lite-connect` ; la carte le relit toutes les 3 s tant qu'elle est connectée.

## Les requêtes relayées

```json
← { "type": "request", "id": "…", "method": "GET", "path": "/api/tasks/t_1/events", "query": "?since=42" }
→ { "type": "response", "id": "…", "status": 200, "contentType": "application/json", "body": "<base64>" }
```

Pour chaque requête, dans cet ordre :

1. **La liste** (`relayCapability`, la même que Cloud, avec ses tests) : méthode + chemin exacts,
   aucun segment `.`/`..`, aucun `%2f`/`%5c`/`\`. Hors liste → `403 { "error": "not_relayed" }`.
2. **La capacité** de la route, parmi celles **annoncées à ce `hello`** → sinon
   `403 { "error": "capability_not_granted", "capability": "reply" }`.
3. **L'URL locale** (`localRequestUrl`) : `http://127.0.0.1:{PORT}{path}?{query}`, et seulement si
   le chemin obtenu est exactement celui qui a passé la liste (une query avec `#` ou commençant par
   `/` est refusée).
4. `fetch` vers ce Lite lui-même — les mêmes routes que le dashboard —, sans suivre de redirection,
   coupé à 28 s (Cloud répond 504 à 30 s). La réponse repart telle quelle (statut, `content-type`,
   corps en base64) ; au-delà de 11 Mo → `502 response_too_large` (limite de 16 Mo par message côté
   Cloud). Route injoignable → `502 lite_route_failed`.

| Capacité | Routes |
|---|---|
| `read` | `GET /api/projects`, `/api/projects/:id`, `/api/projects/:id/tasks`, `/api/tasks`, `/api/tasks/:id`, `/events`, `/diff`, `/diff/patch`, `/attachments/:aid` |
| `reply` | `POST /api/tasks/:id/messages`, `/interrupt`, `/answer`, `/validate`, `/cancel` |
| `create` | `POST /api/projects/:id/tasks` |

Jamais relayé : secrets, réglages (la clé SSH), `lite-connect` lui-même, workers, terminaux,
services, et tout le reste.

## Événements : `task.state`

Quand une tâche **passe** à `in-review` ou `failed`, Lite envoie dans le tunnel :

```json
{ "type": "event", "event": "task.state", "taskId": "…", "projectId": "…", "state": "in-review", "title": "…", "lastMessage": "…" }
```

- Émis par `emitTaskState` (`services/tasks.ts`) aux mêmes endroits que le signal au parent d'une
  sous-tâche : juste après l'écriture conditionnelle qui fait la transition (`refreshTask`, machine
  tombée, `failTask`). **Une fois par passage**, jamais à un simple rafraîchissement ; un nouveau
  tour qui rend la main en émet un nouveau.
- `lastMessage` : le dernier message de l'agent (le sien, pas d'un sous-agent), espaces réduits,
  coupé à 200 caractères ; à défaut, pour `failed`, l'erreur de la tâche. Absent sinon.
- **Pas émis** pour un Drop (c'est le geste du propriétaire, pas une nouvelle), ni quand le tunnel
  n'est pas `online` : l'événement est perdu, pas mis en file.
- Un Cloud qui ne connaît pas `event` l'ignore.

## Deux graphes de modules

Le tunnel tourne dans le graphe de `server.ts` (tsx) ; les routes de réglages et les transitions de
tâches lues par l'API dans celui de Next. Comme `lib/agent.ts`, le tunnel pose ses commandes
(`restart`, `stop`, `status`, `emit`) et son état sur `globalThis` (`lib/lite-connect-hooks.ts`) :
une connexion depuis Settings redémarre le seul tunnel, et une tâche passée en revue par une
lecture de l'API émet dans le même socket. Sans tunnel (un `next build`), tout est sans effet.

## API

```
GET  /api/lite-connect             — { spuntoUrl, machineName, defaultMachineName, capabilities, connected, connectedAt, connectionId, lastError, tunnel }
PATCH /api/lite-connect            — { spuntoUrl? (déconnecté seulement, sinon 409), machineName?, capabilities? }
POST /api/lite-connect/connect     — { url } : la page de consentement (inscrit le client si besoin)
GET  /api/lite-connect/callback    — retour du consentement → /settings?liteConnected=1 | ?liteError=…
POST /api/lite-connect/disconnect  — rend le refresh token à Spunto, oublie les jetons, ferme le tunnel → { …vue, revoked }
```

## Déconnecter : rendre le jeton (RFC 7009)

**Disconnect** (`disconnectLiteConnect`) rend d'abord le refresh token au Spunto qui l'a émis
(celui de l'inscription du client), comme le contrat de Cloud le prévoit (son `docs/lite-connect.md`
§ Déconnecter, coderhammer/spunto#876) :

```
POST {spuntoUrl}/api/oauth/revoke
Content-Type: application/x-www-form-urlencoded

token=spr_…&client_id=mcp_…          (client public : pas de secret)
```

Spunto révoque alors **tout le consentement du client** : ses jetons, la machine dans
`GET /api/users/me/lite` (elle quitte la liste du membre) et le tunnel ouvert, fermé en `4403`.

- **Puis**, quoi qu'ait répondu Spunto, les jetons sont oubliés et le tunnel fermé.
- **Le tunnel reste ouvert pendant l'appel** : le `4403` qui arrive alors est l'écho de la
  révocation (`liteTunnel().revoking()`), pas un « déconnecté depuis Spunto » — le tunnel s'éteint
  sans écrire d'erreur, Disconnect fait le reste.
- **Rendu** : `200` (aussi pour un jeton déjà inconnu) ou `401 invalid_client` (Spunto ne connaît
  plus le client : il n'y a rien à retirer). La carte dit « Disconnected from Spunto ».
- **Pas rendu** : Spunto injoignable (10 s au plus), `5xx`, un Spunto sans la route (`404`)… Lite
  oublie quand même ; la route répond `revoked: false`, et `lastError` (sous « Disconnected ») dit
  pourquoi, que **la machine reste peut-être listée dans Spunto, à retirer depuis Account Settings
  → Connected apps**.

Le même rendu sert quand **l'inscription est refaite** (ci-dessus) : le refresh token de l'ancien
client part avant qu'un autre ne le remplace. Jamais pour un nouvel appairage du *même* client :
révoquer l'ancien jeton emporterait le consentement tout neuf avec lui.

Reconnecter réutilise le même client ; Cloud recrée la connexion au premier `hello`.

## Tests

```bash
npm test     # node:test via tsx : lib/lite-relay.test.ts (la liste) + services/lite-tunnel.test.ts (faux Cloud)
```

Le test d'intégration monte le faux Cloud et un faux « Lite local » (pour voir exactement ce qui
atteint les routes), puis : coupé par défaut, appairage OAuth complet (inscription, PKCE, callback),
`hello` en `read`, relais d'une lecture avec sa query, refus hors liste (sans rien atteindre),
refus d'une capacité non donnée puis nouveau `hello` après l'avoir cochée, reconnexion après
coupure, 4401 → refresh (jeton tourné), `task.state`, 4409, 4403 qui arrête tout, refresh refusé,
réinscription qui rend l'ancien jeton, Disconnect qui le rend (le corps exact de l'appel, le `4403`
qui suit sans erreur, jetons oubliés), Disconnect avec Spunto injoignable ou en `503` (oublié quand
même, et dit).

À la main, contre une vraie instance :

```bash
npx tsx scripts/fake-spunto-cloud.ts --port 4999      # consentement accordé d'office
# Settings → Connect to Spunto → Spunto URL : http://localhost:4999, puis Connect
curl -XPOST localhost:4999/_fake/relay -d '{"method":"GET","path":"/api/tasks"}'
curl localhost:4999/_fake/state                       # hellos, événements, révocations
curl -XPOST localhost:4999/_fake/close -d '{"code":4403}'
```
