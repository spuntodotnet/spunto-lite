# dev-workflow — spunto-lite

> **Fichier lu par l'agent qui tourne sur le worker Spunto** dans le pipeline
> idée→prod (voir `workflows/idea-to-prod.md` du sandbox `work`). Le service
> `automations` ne fait que **créer** ce worker (au passage de la carte Notion en
> `running`) et **l'arrêter** (au merge de la PR → `completed`). Tout le reste —
> implémenter, tester, faire avancer la carte, ouvrir la PR — c'est **toi**,
> l'agent, qui le pilotes en suivant ce fichier.
>
> Le repo est encore jeune : pas de suite de tests automatisée. La vérification
> attendue est donc **`build` + `lint` verts + un smoke test manuel** de ce que
> tu as changé (stub, à étoffer quand une vraie suite existera).

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
      (`docker compose up -d --build`) — pas un test partiel ni un screenshot
      d'une itération précédente. Pour une feature UI, joins une **preuve** à la
      carte (capture ou courte vidéo) ; pour un changement backend, le résultat
      de la vérification.

Le worker expose l'app sur le port 80 → le lien « App » du channel de la carte
pointe dessus (voir `spuntoProjects.ts` côté `automations`).

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
