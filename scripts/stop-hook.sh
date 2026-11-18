#!/usr/bin/env bash
# Hook « Stop » de Claude Code (.claude/settings.json) : à la fin de chaque tour d'un agent sur un worker Spunto, le
# build qu'ouvre l'humain qui teste (l'image Docker servie sur :3000) est remis à jour s'il est en retard sur le code
# (scripts/start.sh, qui ne refait rien s'il est à jour). Quand la tâche passe en revue, le lien donné sert donc ce
# qui vient d'être fait — sans dépendre de la mémoire de l'agent. Hors d'un worker Spunto (pas de WORKER_SLUG), rien.
#
# Un échec est renvoyé à l'agent (code 2 : il voit la fin du journal et continue), une seule fois : s'il échoue encore
# au tour d'après (stop_hook_active), on le laisse rendre la main plutôt que de boucler.
set -uo pipefail
[ -n "${WORKER_SLUG:-}" ] || exit 0
input="$(cat)"
cd "$(dirname "$0")/.."
log="$(git rev-parse --git-path spunto-stop-hook.log)"
bash "${START:-scripts/start.sh}" > "$log" 2>&1 && exit 0
if printf '%s' "$input" | grep -Eq '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
  echo "⚠ le build servi à l'humain n'a pas pu être remis à jour : $log" >&2
  exit 0
fi
{ echo "Le build servi à l'humain n'a pas pu être remis à jour (${START:-scripts/start.sh}, journal : $log). Fin du journal :"
  tail -40 "$log"; } >&2
exit 2
