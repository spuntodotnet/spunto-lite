# Intégrations

On **connecte une forge** (GitHub, GitLab, en ligne ou auto-hébergée) avec un **jeton** dans
**Settings → Integrations**. Trois choses en profitent :

- le **formulaire projet** propose les dépôts du compte (« Add repository ») au lieu d'une URL à
  taper ;
- ces dépôts sont **clonés et poussés en HTTPS avec le jeton** : pas de clé SSH à enregistrer
  chez la forge ;
- les **pull requests** dont parle une tâche disent où elles en sont : ouverte, brouillon,
  fusionnée, fermée ; leurs checks ; leur revue ; un conflit.

Le jeton reste dans Lite, chiffré : aucun worker ne le garde, il le demande à chaque opération git.
Une URL SSH, elle, passe toujours par la clé ([ssh-and-git](../site/src/content/docs/fr/ssh-and-git.md)).

C'est la petite cousine des *intégrations* de Spunto Cloud (app GitHub, OAuth, credential helper…),
et la forme est empruntée à [t3code](https://github.com/pingdotgg/t3code)
(`packages/source-control-*`), en beaucoup plus petit.

## La forme : une définition, un pilote

Chaque forge, ce sont **deux fichiers** :

| | Où | Quoi |
|---|---|---|
| **Définition** | `lib/integrations/<forge>.ts` | Pure, importable par le navigateur : la route d'une PR dans une URL, ce que la forge l'appelle (`PR`/`MR`, `#12`/`!12`), son hôte public, sa page de création de jeton, la variable d'environnement de son jeton. |
| **Pilote** | `services/integrations/<forge>.ts` | Serveur seulement : ce qu'on peut demander à la forge avec un jeton. `whoami` est obligatoire (c'est ainsi qu'un jeton est vérifié avant d'être enregistré) ; **chaque capacité ensuite est optionnelle** — `pullRequest` et `listRepositories` aujourd'hui. |

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

## Choisir un dépôt

Avec au moins une connexion qui sait lister (`listRepositories`), la section *Repositories* du
formulaire projet reçoit les connexions comme `gitProviders` du design system : il dessine alors
son bouton **Add repository** à côté de **Add Git URL**. Le champ de la ligne est
`components/repository-picker-field.tsx` (le slot `renderRepoField`) : une recherche par
sous-chaîne dans les dépôts de toutes les connexions, avec un cadenas pour les privés et la forge
quand il y en a plusieurs.

**Une ligne choisie redevient aussitôt une ligne « Git URL »** (`pickRepository`,
`lib/project-form-value.ts`) avec l'URL **HTTPS** que la forge donne (`clone_url`,
`http_url_to_repo`), clonée avec le jeton (§ suivant). Le projet ne stocke donc toujours qu'une
URL de clonage. Un `owner/repo` **tapé** sans être choisi est résolu à l'enregistrement
(`resolvePickedRepositories`) : l'URL du dépôt listé s'il en est un, sinon
`<origine>/<owner/repo>.git` ; un nom sans `/` est refusé avec un message plutôt que perdu. Pour
cloner un dépôt par la clé SSH, « Add Git URL » et son URL `git@…` restent là.

## Cloner et pousser avec le jeton

Chaque worker reçoit un **credential helper git** (`lib/git-credential.ts`), écrit par le début
de son script de setup (en root) dans `/usr/local/bin/git-credential-spunto-lite` et déclaré dans
la config **système** de git (`credential.helper`, ajouté à côté d'un helper existant, jamais à sa
place ; un `~/.gitconfig` de dotfiles ne l'efface pas). Quand une remote HTTPS demande un mot de
passe — au clone du setup, à un `git pull` / `git push` dans le terminal, l'IDE ou une session
d'agent —, git l'appelle ; il envoie à `POST /api/workers/git-credential` le **protocole et
l'hôte** que git s'apprête à contacter, et Lite répond le jeton de la connexion de **cette
origine exacte**, avec le nom d'utilisateur de sa forge (`x-access-token` pour GitHub, `oauth2`
pour GitLab). Pour tout autre hôte : 404, le helper se tait, git continue comme sans lui.

- **Le jeton ne peut repartir que vers sa forge** : la réponse est choisie par l'hôte que git
  contacte, pas par le chemin du dépôt. C'est la différence avec le helper de Cloud
  (`@spunto/build`, RFC 0024), qui n'envoie que `owner/repo` : un `git clone
  https://ailleurs/owner/repo` aurait reçu le jeton de la forge qui connaît ce chemin.
- **Rien n'est stocké dans le worker** : ni `~/.git-credentials`, ni le jeton de la forge.
  Remplacer ou retirer une connexion vaut à l'opération git suivante.
- **Le jeton du worker** (`lgc_<id>_<hmac>`) est dérivé de son id sous `DATA_ENCRYPTION_KEY` :
  le script est reconstruit à chaque démarrage (`planFor`) et retrouve le même, sans colonne ; il
  n'est plus accepté une fois le worker supprimé (401).
- Le helper a besoin de `curl` dans l'image, comme celui de Cloud ; sans, il se tait.
- Un worker créé avant cette version n'a pas de helper : le reconstruire (Rebuild) suffit.

Listage : GitHub `GET /user/repos?sort=pushed` (ce que le jeton atteint : les siens, ceux où il
collabore, ceux de ses organisations), GitLab `GET /projects?membership=true` (les projets dont
le compte est membre, pas tous les projets publics de l'instance). Au plus 5 pages de 100, gardé
2 minutes côté serveur, oublié quand une connexion change ; une forge qui refuse ne vide que sa
part.

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
| GitHub | fine-grained : *Contents* en lecture **et écriture** (cloner, pousser), *Pull requests*, *Commit statuses*, *Checks* en lecture ; ou classique `repo` |
| GitLab | `read_api`, plus `read_repository` et `write_repository` pour cloner et pousser |

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
GET    /api/integrations/repositories — { sources: les connexions qui listent, repositories: [{ source, fullName, cloneUrl, private }] }
POST   /api/workers/git-credential    — le helper d'un worker (Bearer lgc_…) : { protocol, host } → { username, password } ; 401 / 404 sinon
POST   /api/integrations        — { kind: "github"|"gitlab", host?, token } → 201, après whoami ; 400 si la forge refuse
DELETE /api/integrations/:id    — oublie un jeton enregistré ; 404 pour une connexion `env:…`
```

## La suite

Dans l'ordre prévu, chaque étape étant une capacité de plus du pilote :

1. ~~État des PR dans la tuile~~, ~~choix du dépôt dans le formulaire projet~~, ~~clone et push
   avec le jeton~~ (faits) ;
2. des outils `pull_request_*` et `ci_logs` dans `spunto-tasks` (`/api/task-mcp`), exécutés par
   Lite avec le jeton — l'agent ouvre et lit ses PR sans jamais tenir le jeton, comme pour la
   passerelle MCP ;
3. *Merge* / *Close* depuis la tuile (`TaskAppTileItem.actions`) ;
4. suivre une PR et réveiller l'agent quand ses checks échouent, qu'un commentaire arrive ou
   qu'elle est fusionnée.
