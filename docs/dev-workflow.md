# dev-workflow — spunto-lite

> **Fichier lu par l'agent qui tourne sur le worker Spunto** dans le pipeline
> idée→prod (voir `workflows/idea-to-prod.md` du sandbox `work`). Le service
> `automations` ne fait que **créer** ce worker (au passage de la carte Notion en
> `running`) et **l'arrêter** (au merge de la PR → `completed`). Tout le reste —
> implémenter, tester, faire avancer la carte, ouvrir la PR — c'est **toi**,
> l'agent, qui le pilotes en suivant ce fichier.
>
> Le repo est encore jeune : **pas de suite de tests automatisée, pas de scripts
> `reset.sh`/`restart.sh`**. La vérification attendue est donc **`build` + `lint`
> verts + un smoke test réel** de ce que tu as changé, avec **une preuve attachée
> à la carte**. (Ce fichier suit le modèle du `docs/dev-workflow.md` de
> `coderhammer/spunto`, adapté à l'outillage réellement disponible ici.)

## ✅ Check-list avant de passer la carte en `to be tested`

Ces trois points ne sont **pas optionnels**. Ne fais pas avancer la carte tant
que les trois ne sont pas vrais :

- [ ] **`npm run build` vert** — aucune erreur TypeScript / Next.
- [ ] **`npm run lint` vert.**
- [ ] **Feature rejouée en vrai, de bout en bout** — pas un test partiel ni un
      screenshot d'une itération précédente — **avec une preuve attachée à la
      carte** : capture (feature UI) ou résultat de la vérification copié dans le
      commentaire (changement backend). Voir § 3 (preuve) et § 4 (livraison).

Le reste du fichier détaille chacun de ces points.

## Contexte de départ (déjà en place quand tu démarres)

- Tu es sur une branche dédiée déjà créée et checkout : `notion/{pageId}-{slug}`.
- `$NOTION_PAGE_ID` (id de ta carte) et `$NOTION_TOKEN` sont dans ton env.
- `$WORKER_SLUG` est dans ton env (injecté par Spunto au démarrage du worker,
  persisté dans `/etc/environment`) — `echo $WORKER_SLUG` pour la valeur réelle.
  Il sert à construire les liens worker/app du commentaire de handoff (§ 5).
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

> **Dev vs « comme en prod ».** `npm run dev` (watch, hot reload) suffit pour
> itérer vite pendant que tu codes. Mais **il n'y a pas de `reset.sh` ici** : pour
> valider le comportement réel avant de faire avancer la carte, repars d'un
> conteneur neuf avec `docker compose up -d --build` (rebuild de l'image, app sur
> le port 80) — c'est l'équivalent local le plus proche d'un environnement propre
> que verra un relecteur. `--build` est ce qui garantit que ton code est bien
> repris (pas une image cachée).

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
puis ouvrir l'app sur le port 80 du worker (§ « La stack »).

## 2. Vérifier (obligatoire avant de faire avancer la carte)

Reprends les trois points de la check-list du haut — aucun n'est optionnel :

- [ ] **`npm run build`** passe (aucune erreur TypeScript / Next).
- [ ] **`npm run lint`** passe.
- [ ] **Smoke test réel de ta feature, de bout en bout**, sur la stack lancée
      (`docker compose up -d --build`) — pas un test partiel ni un screenshot
      d'une itération précédente. Pour une feature **UI**, pilote-la vraiment avec
      les outils `browser_*` (section suivante) et **joins une preuve à la carte**
      (§ 3) ; pour un changement **backend**, le résultat de la vérification, copié
      dans le commentaire de handoff (§ 4).

Si le build/lint échoue ou si le flux ne va pas jusqu'au bout, **ne fais pas
avancer la carte** : corrige et reprends cette étape.

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
4. `browser_screenshot` sur l'état final → c'est la **preuve** à attacher à la
   carte (§ 3).

Si les outils `browser_*` n'apparaissent pas : c'est que les dépendances du
serveur MCP ne sont pas encore installées — un `npm install` puis relancer la
session Claude suffit (voir dépannage dans [`mcp/README.md`](../mcp/README.md)).

## 3. Preuve — capture attachée à la carte

**La preuve accompagne systématiquement le passage en `to be tested`.** Ici, pas
d'enregistrement vidéo (spunto a un script `ffmpeg` dédié, pas ce repo) : la
preuve d'une feature UI est **la capture `browser_screenshot`** de l'état final
du parcours, attachée **directement à la carte Notion** comme bloc image.

Le PNG produit par `browser_screenshot` est un fichier sur le worker ; attache-le
via l'**API File Upload de Notion** (marche avec `$NOTION_TOKEN`, limite 5 Mo —
une capture fait quelques dizaines/centaines de Ko). Flux en 3 étapes :

```bash
PNG=chemin/vers/capture.png   # le fichier produit par browser_screenshot

# 1) créer le file_upload → récupère {id, upload_url}
CREATE=$(curl -s -X POST -H "Authorization: Bearer $NOTION_TOKEN" -H "Notion-Version: 2022-06-28" -H "Content-Type: application/json" \
  -d '{"filename":"preuve.png","content_type":"image/png"}' "https://api.notion.com/v1/file_uploads")
FID=$(echo "$CREATE" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
UPLOAD_URL=$(echo "$CREATE" | python3 -c 'import sys,json;print(json.load(sys.stdin)["upload_url"])')

# 2) envoyer les octets (multipart, champ `file`) → status "uploaded"
curl -s -X POST "$UPLOAD_URL" -H "Authorization: Bearer $NOTION_TOKEN" -H "Notion-Version: 2022-06-28" \
  -F "file=@$PNG;type=image/png" >/dev/null

# 3) référencer le file_upload dans un bloc image ajouté au corps de la carte
curl -s -X PATCH -H "Authorization: Bearer $NOTION_TOKEN" -H "Notion-Version: 2022-06-28" -H "Content-Type: application/json" \
  -d "{\"children\":[{\"object\":\"block\",\"type\":\"image\",\"image\":{\"type\":\"file_upload\",\"file_upload\":{\"id\":\"$FID\"}}}]}" \
  "https://api.notion.com/v1/blocks/$NOTION_PAGE_ID/children"
```

Le fichier est ensuite hébergé **de façon permanente** par Notion. Dans le
commentaire de handoff (§ 5), signale simplement que la capture est attachée à la
carte (elle est dans le corps de la page, pas besoin de lien).

Pour un changement **backend/infra** sans surface visuelle, la preuve est le
**résultat des vérifications** (`npm run build` / `npm run lint` / smoke test),
copié dans le commentaire de handoff — pas de capture à forcer.

## 4. Livrer

Une fois la check-list du haut satisfaite (build + lint + smoke test réel +
preuve) :

1. Commit ton travail sur la branche courante.
2. Passe la carte en `to be tested` (signal « implémenté + validé en local ») :
   ```bash
   curl -s -X PATCH -H "Authorization: Bearer $NOTION_TOKEN" -H "Notion-Version: 2022-06-28" -H "Content-Type: application/json" \
     -d '{"properties": {"Status": {"select": {"name": "to be tested"}}}}' \
     "https://api.notion.com/v1/pages/$NOTION_PAGE_ID"
   ```
3. **Poste le commentaire de handoff en format riche** (voir § 5 pour le format et
   le template). Il doit suffire à un relecteur pour tester la feature sans rien
   demander de plus. **Le récap Mattermost de fin de tour doit être EXACTEMENT le
   même texte que ce commentaire Notion — mot pour mot, pas un résumé du résumé.**

   `pipeline-agent` relaie vers le channel Mattermost de la carte *chaque* bloc de
   texte assistant et *chaque* appel d'outil du tour, **un message par bloc, sans
   regrouper**. Donc toute ta narration intermédiaire finit aussi dans ce channel,
   et un récap étalé sur plusieurs blocs arriverait fragmenté. Pour que le
   récapitulatif ne se noie pas dans ce bruit ET n'arrive pas coupé :
   - Écris-le en **un seul bloc de texte ininterrompu** (pas de tool call ni de
     texte intermédiaire au milieu) ;
   - fais-en le **dernier** message texte du tour, rien d'autre mélangé dedans ;
   - inclus-y **le lien de la carte Notion elle-même** (pas seulement PR/App/Code —
     voir template § 5b) pour qu'un lecteur qui suit depuis Mattermost puisse
     remonter à la carte sans changer d'app.
4. Pousse la branche et ouvre la PR **toi-même**, vers `main` de
   `spuntodotnet/spunto-lite` :
   ```bash
   GIT_TERMINAL_PROMPT=0 git push -u origin HEAD
   gh pr create --base main --fill --body "Carte Notion : https://www.notion.so/$(echo "$NOTION_PAGE_ID" | tr -d -)"
   ```
5. Complète le commentaire de handoff avec le lien de la PR (ou reposte-le mis à
   jour), puis passe la carte en `in review` :
   ```bash
   curl -s -X PATCH -H "Authorization: Bearer $NOTION_TOKEN" -H "Notion-Version: 2022-06-28" -H "Content-Type: application/json" \
     -d '{"properties": {"Status": {"select": {"name": "in review"}}}}' \
     "https://api.notion.com/v1/pages/$NOTION_PAGE_ID"
   ```

À partir de là, **arrête-toi et rends la main** : la revue et le merge de la PR
sont humains. Le merge déclenche automatiquement le passage de la carte en
`completed` et l'arrêt de ce worker (webhook GitHub → `automations`) — rien à
faire de ton côté après.

## Itérer après coup (reprises de session)

Le worker reste vivant tant que la carte n'est pas `completed` : l'utilisateur
peut revenir sur ce même worker/branche après l'étape 4 pour te demander d'aller
plus loin (retour de relecture, amélioration) — en dehors du passage initial
`implementing → to be tested → in review` déjà bouclé une première fois.

**Règle simple : si ce tour se termine par du code effectivement poussé sur la PR
(nouveau commit + `git push`), reposte un commentaire de handoff Notion à jour
(§ 5, même template rempli avec l'état courant) ET termine le tour par le récap
Mattermost identique (règle de parité de l'étape 4.3)** — à chaque itération, pas
seulement lors de la toute première livraison.

Exceptions (ne reposte ni commentaire ni récap) :
- Le tour n'était qu'une question/discussion, sans changement de code.
- Aucune implémentation réelle n'a eu lieu (lecture de code, explication, etc.).

Dans le doute : **as-tu poussé du code sur la PR pendant ce tour ?** Oui →
commentaire + récap. Non → rien.

## 5. Commentaire Notion de handoff — format riche

### (a) Format — l'API commentaires de Notion

**Il n'y a pas de helper `notion-comment.mjs` dans ce repo** (contrairement à
spunto) : on poste via l'API commentaires brute.

- `POST /v1/comments` prend `{"parent": {"page_id": "…"}, "rich_text": [ … ]}` où
  `rich_text` est un tableau de segments typés.
- Segment texte simple : `{"type": "text", "text": {"content": "…"}}`.
- Gras / italique : via `annotations` (`{"annotations": {"bold": true}}`).
- Lien : `{"type": "text", "text": {"content": "…", "link": {"url": "https://…"}}}`
  — l'URL est un **objet** `link: {url}`.
- Sauts de ligne : `\n` dans `content`. Les emoji passent tels quels et
  structurent visuellement.

Exemple minimal (POST `/v1/comments`) :

```bash
curl -s -X POST -H "Authorization: Bearer $NOTION_TOKEN" -H "Notion-Version: 2022-06-28" -H "Content-Type: application/json" \
  -d '{
    "parent": { "page_id": "'"$NOTION_PAGE_ID"'" },
    "rich_text": [
      { "type": "text", "text": { "content": "✅ " } },
      { "type": "text", "text": { "content": "Implémenté et testé en local" }, "annotations": { "bold": true } },
      { "type": "text", "text": { "content": "\nPR : " } },
      { "type": "text", "text": { "content": "spunto-lite#123", "link": { "url": "https://github.com/spuntodotnet/spunto-lite/pull/123" } } }
    ]
  }' \
  "https://api.notion.com/v1/comments"
```

#### Format des liens : identique en Notion et dans le récap Mattermost

Mattermost rend le **Markdown standard**, et le relais `pipeline-agent` →
`slack-agent` poste ton texte tel quel. Les liens `[libellé](url)` fonctionnent
donc dans le récap Mattermost **exactement** comme dans le commentaire Notion.
Écris le récap Mattermost avec le **même contenu et le même format** que le
commentaire Notion : gras `**x**`, liens labellisés `[libellé](url)` avec un
libellé humain (`[spunto-lite#97](…/pull/97)`, `[Carte Notion](…)`). Le bloc
« Liens utiles » doit être **strictement identique des deux côtés**.

### (b) Template obligatoire du commentaire de handoff

À **remplir concrètement** (liens cliquables réels) — pas à laisser générique.
Le commentaire doit à lui seul permettre de tester la feature. **Les deux liens
les plus importants sont le lien direct vers l'app (port 80) et le lien vers le
worker (code-server) — ne les laisse jamais génériques ni absents**, y compris
sur un commentaire reposté lors d'une itération ultérieure :

```
✅ Implémenté et testé en local

📦 Ce qui a été fait
<résumé 1-2 phrases : quoi + migration/route si pertinent>

🧪 Comment tester
1. Ouvrir l'app (lien direct) : https://$WORKER_SLUG-80.spunto.net
2. <étape concrète>
3. <résultat attendu à observer>

🎥 Preuve
Capture du test attachée directement à la carte (bloc image dans le corps de la page).

🔗 Liens utiles
• Carte Notion : <lien carte cliquable>
• PR : <lien PR cliquable>
• Branche : notion/<pageId>-<slug>
• Worker (code-server) : https://$WORKER_SLUG-code.spunto.net/?folder=%2Fworkspace%2Fspunto-lite

✔️ Vérifications
npm run build ✅ · npm run lint ✅ · smoke test ✅
```

> `$WORKER_SLUG` est une **vraie variable d'env** de ton shell — `echo
> $WORKER_SLUG` pour la valeur réelle. Construis les liens app/code-server en
> substituant sa valeur, jamais en laissant `$WORKER_SLUG` littéral dans le
> commentaire posté. L'app est sur le **port 80** (`-80`), pas 3000.

> Lien de la carte Notion à partir de `$NOTION_PAGE_ID` (même formule que pour le
> corps de la PR en § 4.4) :
> `https://www.notion.so/$(echo "$NOTION_PAGE_ID" | tr -d -)`
