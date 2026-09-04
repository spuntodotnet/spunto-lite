# Domaine local `*.local.spunto.net` (+ HTTPS)

> Porté de `coderhammer/spunto` (`local-https/`, `docs/running-locally.md`). Même
> principe, adapté à une stack qui n'a pas de Traefik.

Le proxy de spunto-lite route par sous-domaine : `worker-<id>.<domaine>` pour le
code-server d'un worker, `worker-<id>-<port>.<domaine>` pour un port forwardé,
`svc-<slug>.<domaine>` pour un service partagé. Reste à ce que le sous-domaine
**résolve**, et ça n'a pas la même réponse selon qui ouvre l'URL.

| Qui | Domaine | Comment ça résout |
|---|---|---|
| Ton navigateur, sur la machine qui fait tourner la stack | `*.localhost` | le navigateur lui-même (127.0.0.1), rien à installer |
| `browser-remote`, le runner e2e — bref, un conteneur | `*.local.spunto.net` | le service `coredns` du compose |

Les deux marchent **en même temps** : `BASE_DOMAIN` accepte une liste de suffixes
et le proxy les reconnaît tous (voir `lib/env.ts`). Le premier de la liste est le
suffixe canonique — celui passé à chaque worker pour le `VSCODE_PROXY_URI` de
code-server.

## Pourquoi un DNS rien que pour les conteneurs

Depuis un conteneur, `localhost` c'est *lui*, pas la stack — un `worker-x.localhost`
y finit systématiquement en `ECONNREFUSED`. Et `local.spunto.net` résout
publiquement vers la prod. Il faut donc un résolveur local qui réponde l'IP du
conteneur `spunto-lite` : c'est exactement ce que fait `coredns` (`local-https/Corefile`),
et c'est pourquoi `spunto-lite` et `coredns` ont des IP fixes dans le compose.

Deux écarts assumés avec spunto, tous deux commentés dans le `Corefile` :

- le catch-all est relayé vers **le resolver Docker** (`127.0.0.11`) et non vers un
  DNS public, pour que les conteneurs dont on écrase le `dns:` continuent de résoudre
  les noms de services compose — `http://spunto-lite` reste valable ;
- une réponse **NODATA explicite en AAAA**, pour ne pas laisser la requête AAAA que
  Chrome envoie en parallèle repartir en SERVFAIL.

Le sous-réseau est en `10.79.0.0/24`, hors des pools que Docker s'attribue seul
(`172.17-172.31`, `192.168.x`) : les workers créés par spunto-lite y piochent leurs
propres réseaux, et une collision les empêcherait de démarrer.

## HTTPS

`local-https/generate-certs.sh` génère, dans un conteneur jetable (aucun binaire à
installer), un cert wildcard mkcert pour `local.spunto.net` + `*.local.spunto.net`,
ainsi que le rootCA :

```bash
./local-https/generate-certs.sh          # idempotent
LOCAL_DOMAIN=local.example.test ./local-https/generate-certs.sh   # autre domaine
```

`local-https/certs/` est gitignoré. Ensuite :

- `spunto-lite` monte le cert et écoute **aussi** en TLS (`TLS_CERT_FILE` /
  `TLS_KEY_FILE` / `TLS_PORT`). Sans cert, il ne sert que du HTTP — c'est un
  avertissement, pas une erreur de démarrage.
- `browser-remote` monte le rootCA sur `/certs/extra-ca.pem` ; son entrypoint
  l'importe dans le store système **et** dans le store NSS de Chromium, donc
  `https://…local.spunto.net` est valide sans avertissement.

Contrairement à spunto, il n'y a pas de Traefik : c'est `server.ts` qui termine le
TLS, avec exactement le même routage (app, proxy worker, WebSockets) que sur le
listener HTTP.

⚠️ Le TLS n'est de confiance **que** dans `browser-remote`. Depuis ton navigateur,
utilise `http://…localhost` — le rootCA mkcert n'y est pas installé (tu peux le
faire à la main avec `mkcert -install`, mais ce n'est pas nécessaire).

## Démarrer

```bash
./local-https/generate-certs.sh
docker compose --profile browser up -d --build
```

`coredns` est dans les profils `browser` et `test` : un `docker compose up -d` nu
ne le lance pas, et la stack marche alors en `*.localhost` uniquement.

## Vérifier

```bash
# depuis browser-remote : DNS + TLS + proxy
docker exec -e NODE_EXTRA_CA_CERTS=/certs/extra-ca.pem spunto-lite-browser-remote-1 \
  node -e 'fetch("https://local.spunto.net/api/health").then(r=>console.log(r.status))'
```

Attendu : `200`. Un `worker-<id>.local.spunto.net` sur un worker démarré répond
`302` (la redirection de code-server) ; sur un id inexistant, `502` — ce qui prouve
déjà que le proxy a bien revendiqué l'hôte.

> `NODE_EXTRA_CA_CERTS` n'est utile que pour ce test : Node a son propre magasin de
> CA et ignore celui du système. Chromium, lui, n'en a pas besoin — son store NSS a
> reçu le rootCA au démarrage du conteneur.
