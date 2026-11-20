# Usage — ce que les agents ont consommé

La page **Usage** (barre latérale, `/usage`) dit ce que les tâches ont coûté et consommé, tous
projets confondus, sur une période (`?days=1|7|30|90|0`, 30 par défaut, 0 = tout) : coût, tours,
contexte envoyé, tokens générés, appels d'outils ; puis par jour, par tâche, par projet, par agent,
par modèle et par outil. C'est la page *Consommation* d'obs (`spuntodotnet/observability`,
`app/consommation`), portée dans Lite.

## D'où viennent les chiffres

Obs interroge l'API de Spunto toutes les 5 minutes et additionne les événements dans des tables à
lui. Lite a déjà chaque session dans `task_events` : le rapport (`services/usage.ts`) est calculé
depuis elle, sans table, ni curseur, ni relevé à tenir à jour.

Sur un long historique (quelques millions d'événements), ce calcul prend des dizaines de secondes.
`better-sqlite3` étant synchrone, le faire dans la requête gelait tout le serveur pendant ce temps :
il tourne donc **en arrière-plan**, dans un `worker_thread` avec sa propre connexion
(`services/usage-worker.ts`). `GET /api/usage` répond tout de suite avec le dernier rapport de la
période (`services/usage-runner.ts`) : `{ report, computedAt, durationMs, computing, error }`, `report`
nul tant que le premier n'est pas fait, `computing` tant qu'un plus récent est en route — la page
affiche « Computing usage… » et interroge chaque seconde, le reste de l'app continue. Un rapport est
refait quand on le relit au-delà de 30 s, ou de cinq fois ce qu'il a pris ; un seul calcul à la fois,
le dernier demandé d'abord. L'index `task_events (type, ts)` réduit le calcul d'environ un tiers.

| Chiffre | Événement (`@spunto/build/agent-contract`) |
|---|---|
| Tokens | `usage` de scope `call`, un par appel au modèle (Claude Code, Codex) ; à défaut, pour une tâche qui n'en écrit aucun (Mistral Vibe), le `usage` de scope `session` de chaque tour. Jamais les deux : Claude Code reprend ses appels dans sa ligne de session. |
| Coût | `costUsd` du `usage` de scope `session`, **cumulé par `sessionId`** (un `--resume` le reprend) : le coût d'un tour est l'écart avec le précédent de la même session. Un cumul qui redescend est un processus relancé : on garde la lecture la plus proche du prix des tokens du tour. |
| Tours | `session.ended`, quel que soit l'agent. |
| Outils | `tool.call` et son `tool.result` (même `callId`) : nombre, erreurs, temps de l'appel au résultat. |
| Contexte max | le plus grand `contextTokens` d'un appel, sur la fenêtre du modèle (`contextWindow`). |

Les jours sont ceux du fuseau du navigateur (`?tz=`, UTC à défaut).

## Ce que le coût n'est pas

- **Pas une facture.** C'est le prix que calcule l'agent au tarif de l'API. Avec un abonnement
  Claude, il n'est pas payé tel quel.
- **Pas tout.** Codex ne rapporte aucun coût : ses tâches comptent leurs tokens mais pas d'argent
  (« — », et la tuile *Cost* dit combien de tâches n'ont pas de coût rapporté), plutôt qu'un prix
  qu'il faudrait deviner.
- **Pas les tâches supprimées.** Supprimer un projet supprime ses tâches et leurs événements, donc
  leur consommation.
