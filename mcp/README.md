# Outils navigateur (MCP) — pour tester l'UI avec Claude

`server.js` est un serveur **MCP** (stdio) vendored depuis
[`spuntodotnet/browser-remote`](https://github.com/spuntodotnet/browser-remote).
Il expose un navigateur pilotable comme un jeu d'outils qu'un agent Claude
découvre tout seul via [`.mcp.json`](../.mcp.json) à la racine du repo :

| Outil | Rôle |
|---|---|
| `browser_snapshot` | état de la page : url/titre/texte + éléments interactifs, chacun avec un `ref` stable (**à appeler avant de cliquer/saisir**) |
| `browser_navigate` | aller à une URL |
| `browser_click` | cliquer par `ref` (recommandé), `text`, ou coords `x/y` |
| `browser_type` | saisir dans un champ (setter DOM natif), `submit:true` presse Entrée |
| `browser_screenshot` | capture PNG de la page |
| `browser_read_ax` | arbre d'accessibilité compact |
| `browser_list_tabs` | liste des onglets ouverts |

Modèle **snapshot-avec-refs** : on lit la page, on agit par `ref` — pas de
sélecteur à deviner, shadow DOM traversé, pixels CSS gérés. Chaque session MCP
ouvre **son propre onglet** (parallélisme, découplé de ce que l'humain regarde).

## Ça marche comment

Le serveur MCP est un pont léger : chaque outil appelle l'API REST haut-niveau
`/api/agent/*` d'une instance **`browser-remote`** qui doit tourner et être
joignable à `BROWSER_REMOTE_URL` (défaut `http://localhost:3005`, voir
`.mcp.json`). Cette instance est le service `browser-remote` du
[`docker-compose.yml`](../docker-compose.yml) (profil `browser`, lancé à la
demande).

## Lancer / tester l'UI

```bash
# 1. Démarrer l'app + le navigateur (profil browser, image ~1,4 Go, à la demande)
docker compose --profile browser up -d --build

# 2. Dans Claude Code : les outils browser_* sont déjà là (via .mcp.json).
#    Le navigateur atteint l'app sur le réseau compose à http://spunto-lite
#    → browser_navigate {"url":"http://spunto-lite"} puis browser_snapshot, etc.
```

Le serveur MCP a besoin de `@modelcontextprotocol/sdk` (devDependency) et `zod`
(déjà une dépendance de spunto-lite) — présents après `npm install`.

## Dépannage

- **Aucun outil `browser_*` visible** → relancer Claude Code après un premier
  `npm install` (les deps du serveur MCP doivent être installées).
- **`ECONNREFUSED` sur `localhost:3005`** → le service `browser-remote` ne
  tourne pas : `docker compose --profile browser up -d`.
- **Co-piloter l'onglet de l'humain** au lieu d'un onglet dédié : poser
  `BROWSER_REMOTE_TAB=active` dans l'env du serveur (`.mcp.json`).
