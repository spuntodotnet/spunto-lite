# spunto-lite

Plan de contrôle local de Spunto : une app Next.js (serveur `server.ts`) qui crée des workers Docker sur le socket de
la machine. Architecture et usage : `README.md` ; le site et la doc utilisateur : `site/` ; l'outillage de l'agent
(vérifications, e2e, outils `browser_*`) : `docs/dev-workflow.md`. Distribué en image Docker (`Dockerfile`, publiée
sur GHCR par `.github/workflows/docker.yml`) : c'est elle, le build.

## Faire tourner (worker Spunto)

Tout est levé à l'arrivée (`scripts/start.sh`), deux spunto-lite côte à côte, chacun avec ses données :

| Port | Ce qui sert | Pour qui |
|---|---|---|
| **3010** | le dev : `npm run dev` sous process-compose (`process-compose.yaml`) — tsx relance le serveur, `next dev` recharge l'interface à chaud ; données dans `./data` | **toi, pour itérer** |
| **3000** | le **build** : l'image Docker de production, lancée par `docker-compose.yml` (service `spunto-lite`, port 80 dans le conteneur) ; données dans le volume `spunto-lite-data` | **l'humain qui teste** : le seul lien à lui donner |

- **Itérer et vérifier sur :3010.** Rien à relancer après un changement de code.
- **À la fin de chaque tour, le hook `Stop` (`.claude/settings.json`) lance `bash scripts/start.sh`** : il refait
  l'image si ses sources ont changé (de une à cinq minutes ; :3000 sert l'ancienne pendant ce temps, puis quelques
  secondes de coupure à la recréation du conteneur) et attend que tout réponde. Un `npm run build` qui casse le fait
  échouer : tu reçois la fin de son journal, corrige avant de rendre la main. Donne le lien **:3000**
  (`https://$WORKER_SLUG-3000.spunto.net/`), jamais celui de :3010.
- **Dépendances changées** (`package.json`, lockfile) : `bash scripts/catch-up.sh --no-pull` (`npm ci`, relance du
  dev, image refaite en fond).
- **Logs** : `pc process logs dev -f` (ou `~/.process-compose/logs/dev.log`) ; `docker compose logs -f spunto-lite` ;
  le dernier passage du hook : `.git/spunto-stop-hook.log`. Attendre que ça réponde : `bash scripts/start.sh
  --no-build`, pas de `sleep`.
- **Le port du build est dans `.env`** (`LITE_PORT=3000`, écrit par `start.sh`) : un `docker compose …` lancé à la
  main (`docker compose --profile browser up -d coredns browser-remote`, `--profile test run --rm e2e`) garde :3000.
  Pas de `docker compose up --build` : il refait l'image hors du verrou de `start.sh`.
- **Un spunto-lite de plus, isolé** (base vide, suite e2e, deux variantes) : `bash scripts/instance.sh <port>
  [--fresh]`, au premier plan (lance-le en tâche de fond ; l'arrêter : `bash scripts/instance.sh <port> stop`,
  `fuser -k` laisse vivre tsx watch). Pas `PORT=… npm run dev` dans le checkout : `next dev` refuse de tourner deux
  fois dans le même dossier. Il copie l'état du checkout (non commité compris) dans `../spunto-lite-instances/<port>/`
  (relance-le pour reprendre le code) ; jamais 3000, 3005 (browser-remote), 3010. Ex. : `bash scripts/instance.sh 3900 --fresh`, puis
  `cd e2e && E2E_BASE_URL=http://localhost:3900 npm run test:api`.
- **Les URL des workers** (`worker-<id>.<hôte>`) ne passent pas par l'URL publique du worker Spunto (pas de
  sous-domaines sous `sbx-…-3000.spunto.net`) : de l'intérieur, `curl -H "Host: worker-<id>.localhost"
  localhost:3000`, ou le navigateur `browser-remote` (ci-dessus) sur `*.local.spunto.net` (`docs/local-domain.md`).
