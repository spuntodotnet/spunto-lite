# dev-workflow — spunto-lite

> **Fichier lu par l'agent qui tourne sur le worker Spunto** dans le pipeline
> idée→prod (voir `workflows/idea-to-prod.md` du sandbox `work`). Le service
> `automations` ne fait que **créer** ce worker (au passage de la carte Notion en
> `running`) et **l'arrêter** (au merge de la PR → `completed`). Tout le reste —
> implémenter, tester, faire avancer la carte, ouvrir la PR — c'est **toi**,
> l'agent, qui le pilotes en suivant ce fichier.
>
> Vérification attendue : **`build` + `lint` verts**, plus la **suite e2e** quand
> ton changement touche l'API ou l'UI. La suite vit dans [`e2e/`](../e2e/README.md)
> (Playwright — projet `api` HTTP-only + projet `browser` pilotant `browser-remote`
> via CDP). Rapide : booter l'app (`PORT=3900 DATA_DIR=./.e2e-data npm run dev`) puis
> `cd e2e && E2E_BASE_URL=http://localhost:3900 npm run test:api`. Voir
> `e2e/README.md` pour le suite navigateur et le cycle de vie worker.

## Contexte de départ (déjà en place quand tu démarres)

- Tu es sur une branche dédiée déjà créée et checkout : `notion/{pageId}-{slug}`.
- `$NOTION_PAGE_ID` (id de ta carte) et `$NOTION_TOKEN` sont dans ton env.
- `gh` est authentifié (compte `coderhammer`).
- Le worker est jetable et dédié à cette seule tâche.
- Dépendances installées (`npm install` via `postCreate`).

## La stack

Un seul process : un serveur Next.js custom (`server.ts`, lancé par `tsx`) qui
parle directement au socket Docker local. Persistance SQLite (Drizzle) sous
`DATA_DIR`. Voir `README.md` pour l'architecture.

| Besoin | Commande |
|---|---|
| Dev (watch, hot reload) | `npm run dev` |
| Build de prod | `npm run build` |
| Lint | `npm run lint` |
| Générer une migration Drizzle | `npm run db:generate` (après avoir édité le schéma) |
| Stack complète en conteneur | `docker compose up -d --build` (app sur le port **80**) |
| Stack + navigateur de test | `docker compose --profile browser up -d --build` (ajoute `browser-remote`) |

Pour **tester l'UI toi-même** (Claude), tu disposes des outils MCP `browser_*`
(navigate / snapshot / click / type / screenshot) — voir la section
[« Tester l'UI »](#tester-lui-avec-les-outils-browser_-claude) plus bas.

## 1. Implémenter

Réalise la demande (titre + description de la carte, rappelés dans ton prompt).
Commit au fur et à mesure sur la branche courante.

- **Schéma / DB** : toute modif du schéma Drizzle passe par une migration
  générée (`npm run db:generate`) — jamais de DDL inline non versionné.
- **Secrets** : `DATA_ENCRYPTION_KEY` chiffre les secrets stockés — ne jamais la
  logger ni committer une vraie valeur.
- Suis le style du code existant (composants, `lib/`, `services/`, `server/`).

Pour voir tes changements : `npm run dev` (watch) suffit pour l'itération ; pour
valider le comportement réel « comme en prod », `docker compose up -d --build`
puis ouvrir l'app sur le port 80 du worker.

## 2. Vérifier (obligatoire avant de faire avancer la carte)

Ces trois points ne sont pas optionnels :

- [ ] **`npm run build`** passe (aucune erreur TypeScript / Next).
- [ ] **`npm run lint`** passe.
- [ ] **Smoke test manuel** de ta feature, de bout en bout, sur la stack lancée
      — pas un test partiel ni un screenshot d'une itération précédente. Pour une
      feature **UI**, pilote-la vraiment avec les outils `browser_*` (voir la
      section suivante) et joins une **preuve** à la carte (capture) ; pour un
      changement **backend**, le résultat de la vérification.

Le worker expose l'app sur le port 80 → le lien « App » du channel de la carte
pointe dessus (voir `spuntoProjects.ts` côté `automations`).

## Tester l'UI avec les outils `browser_*` (Claude)

Ce repo embarque un **serveur MCP** qui te donne un navigateur pilotable
directement depuis Claude Code — pas de Playwright ni de script à écrire. Les
outils sont exposés via [`.mcp.json`](../.mcp.json) (détail :
[`mcp/README.md`](../mcp/README.md)) :

| Outil | Rôle |
|---|---|
| `browser_snapshot` | état de la page + éléments interactifs (chacun un `ref` stable). **À appeler avant de cliquer/saisir.** |
| `browser_navigate` | aller à une URL |
| `browser_click` | cliquer par `ref` (recommandé) / `text` / `x,y` |
| `browser_type` | saisir dans un champ, `submit:true` presse Entrée |
| `browser_screenshot` | capture PNG (pour la preuve à joindre à la carte) |

Déroulé type pour vérifier une feature UI :

1. Lancer la stack **avec le navigateur** :
   `docker compose --profile browser up -d --build`.
   (Le service `browser-remote` est lancé à la demande — image ~1,4 Go, pas au
   boot.)
2. `browser_navigate` vers **`http://spunto-lite`** — le navigateur atteint
   l'app par son nom de service sur le réseau compose (pas `localhost`, qui
   depuis le conteneur navigateur ne pointerait pas sur l'app).
3. `browser_snapshot` pour lire la page et récupérer les `ref`, puis
   `browser_click` / `browser_type` pour reproduire le parcours de ta feature.
4. `browser_screenshot` sur l'état final → joins l'image à la carte Notion
   comme preuve de test.

Si les outils `browser_*` n'apparaissent pas : c'est que les dépendances du
serveur MCP ne sont pas encore installées — un `npm install` puis relancer la
session Claude suffit (voir dépannage dans [`mcp/README.md`](../mcp/README.md)).

## 3. Faire avancer la carte + ouvrir la PR

Une fois les trois cases cochées :

1. Passe la carte Notion en **`to be tested`** puis **`in review`** (via l'API
   Notion, `$NOTION_TOKEN` / `$NOTION_PAGE_ID`), en commentant la carte avec le
   résumé de ce que tu as fait + la preuve de test.
2. `git push` la branche.
3. `gh pr create` vers `main` de `spuntodotnet/spunto-lite`, avec un descriptif
   clair (quoi, pourquoi, comment testé).

Au **merge** de cette PR, le webhook `pull_request` du repo repasse la carte en
`completed` et arrête le worker — tu n'as rien à faire de plus après la PR.
