# Intégrations

On **connecte une forge** (GitHub, GitLab, en ligne ou auto-hébergée) avec un **jeton** dans
**Settings → Integrations**, et les **pull requests** dont parle une tâche disent où elles en
sont : ouverte, brouillon, fusionnée, fermée ; leurs checks ; leur revue ; un conflit. Clone et
push ne changent pas : ils passent toujours par la clé SSH ([ssh-and-git](../site/src/content/docs/fr/ssh-and-git.md)).
Le jeton reste dans Lite, chiffré : aucun worker ne le voit.

C'est la petite cousine des *intégrations* de Spunto Cloud (app GitHub, OAuth, credential helper…),
et la forme est empruntée à [t3code](https://github.com/pingdotgg/t3code)
(`packages/source-control-*`), en beaucoup plus petit.

## La forme : une définition, un pilote

Chaque forge, ce sont **deux fichiers** :

| | Où | Quoi |
|---|---|---|
| **Définition** | `lib/integrations/<forge>.ts` | Pure, importable par le navigateur : la route d'une PR dans une URL, ce que la forge l'appelle (`PR`/`MR`, `#12`/`!12`), son hôte public, sa page de création de jeton, la variable d'environnement de son jeton. |
| **Pilote** | `services/integrations/<forge>.ts` | Serveur seulement : ce qu'on peut demander à la forge avec un jeton. `whoami` est obligatoire (c'est ainsi qu'un jeton est vérifié avant d'être enregistré) ; **chaque capacité ensuite est optionnelle** — `pullRequest` aujourd'hui. |

`lib/integrations/index.ts` tient le registre des définitions, dans l'ordre où une URL les essaie
(GitLab d'abord : sa route `/-/merge_requests/` ne se confond avec aucune autre, alors que celle
de GitHub se lit sur n'importe quel hôte, pour Enterprise). `services/integrations/index.ts` tient
celui des pilotes, les connexions et le cache.

Une forge **avec une définition et sans pilote** est reconnue dans les liens, jamais interrogée :
c'est le cas de Bitbucket. Lui donner un pilote suffit à le rendre connectable (il apparaît alors
dans Settings).

### Ajouter une forge

1. `lib/integrations/<forge>.ts` : sa `IntegrationDefinition`, ajoutée à `definitions` ;
   `IntegrationKind` prend son nom.
2. `services/integrations/<forge>.ts` : son `IntegrationDriver`, ajouté à `drivers` ; le
   `z.enum` de `POST /api/integrations` prend son nom.

Rien d'autre ne connaît la liste.

## Pas de « provider » dans le projet

Un dépôt reste une URL de clonage (`lib/types.ts`, `Repository`) : **c'est l'hôte qui désigne
l'intégration**, pas un champ du projet. Une PR `https://gitlab.example.com/a/b/-/merge_requests/3`
est lue avec la connexion dont l'origine est `https://gitlab.example.com`, si elle est de type
GitLab. Les projets restent portables (l'export n'a rien de plus), une intégration n'est jamais
requise, et un hôte qu'on n'a pas connecté marche exactement comme avant.

## D'où vient le jeton

Pour une origine, dans cet ordre :

1. une connexion de **Settings → Integrations** (`integration_connections`, une par origine,
   jeton chiffré par `lib/crypto.ts`). Un second jeton pour la même origine remplace le premier ;
2. pour l'**instance publique seulement** (github.com, gitlab.com), la variable que nomme la
   définition dans l'environnement **du plan de contrôle** : `GH_TOKEN`, `GITLAB_TOKEN`. Elle
   apparaît dans Settings avec un badge `env`, et ne se retire que là où elle est posée.

Pas d'OAuth : sur un outil local à un seul utilisateur, un jeton personnel suffit, marche sur
`localhost` et sur une instance auto-hébergée sans enregistrer d'application. Les scopes :

| Forge | Jeton |
|---|---|
| GitHub | fine-grained : *Pull requests*, *Commit statuses*, *Checks* en lecture ; ou classique `repo` |
| GitLab | `read_api` |

## Ce qu'on demande, et à quel rythme

`GET /api/tasks/:id/tiles` lit chaque PR de la conversation (`pullRequestState`) :

- **GitHub** : une requête GraphQL (`title state isDraft mergeable reviewDecision` et le
  `statusCheckRollup` du dernier commit). `https://api.github.com/graphql`, ou
  `<origine>/api/graphql` pour Enterprise ;
- **GitLab** : `GET /api/v4/projects/:chemin/merge_requests/:iid` (`state`, `draft`,
  `has_conflicts`, `detailed_merge_status`, `head_pipeline`), et `…/approvals` quand
  `detailed_merge_status` ne dit pas déjà la revue.

Le détail d'une tâche relit ses tuiles toutes les 10 s tant qu'elle peut bouger : chaque état est
**gardé 30 s** en mémoire (un échec aussi, pour ne pas redemander à chaque passage une PR que le
jeton ne voit pas), et oublié quand on connecte ou déconnecte l'origine. Un appel est borné à 6 s
et ne suit **aucune redirection** (le jeton partirait avec). Une forge qui refuse, ne répond pas
ou n'est pas connectée laisse la ligne telle qu'avant : le lien, sans état.

Ce que la tuile en fait (`services/task-shared.ts`) : une pastille d'état (*Open*, *Draft*,
*Merged*, *Closed*), le titre de la forge plutôt que le texte du lien, et — tant que la PR peut
encore être fusionnée — des badges *Checks passing / failing / running*, *Approved*,
*Changes requested*, *Review required*, *Conflicts*.

## API

```
GET    /api/integrations        — { offers: les forges connectables, connections: les comptes (jamais le jeton) }
POST   /api/integrations        — { kind: "github"|"gitlab", host?, token } → 201, après whoami ; 400 si la forge refuse
DELETE /api/integrations/:id    — oublie un jeton enregistré ; 404 pour une connexion `env:…`
```

## La suite

Dans l'ordre prévu, chaque étape étant une capacité de plus du pilote :

1. ~~État des PR dans la tuile~~ (fait) ;
2. des outils `pull_request_*` et `ci_logs` dans `spunto-tasks` (`/api/task-mcp`), exécutés par
   Lite avec le jeton — l'agent ouvre et lit ses PR sans jamais tenir le jeton, comme pour la
   passerelle MCP ;
3. *Merge* / *Close* depuis la tuile (`TaskAppTileItem.actions`) ;
4. suivre une PR et réveiller l'agent quand ses checks échouent, qu'un commentaire arrive ou
   qu'elle est fusionnée.
