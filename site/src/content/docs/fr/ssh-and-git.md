---
title: "Clés SSH et git"
description: "Comment votre propre clé SSH clone et pousse depuis chaque espace de travail — clés à phrase de passe et relais d’agent compris."
group: use
order: 3
---

Lite n’a aucune intégration de forge. Un dépôt est une URL de clonage, et **votre clé SSH est le
seul identifiant** : c’est l’identité avec laquelle vos commits sont poussés, et la seule chose qui
clone. C’est aussi pourquoi n’importe quel hébergeur fonctionne — GitHub, GitLab, Bitbucket, un
Gitea auto-hébergé, un dépôt nu sur un NAS. Autorisez la clé une fois, où que ce soit, et chaque
projet clone et pousse.

## D’où vient la clé

`~/.ssh` est monté **en lecture seule** dans le conteneur Lite (`-v "$HOME/.ssh:/host-ssh:ro"`).
**Settings → SSH keys** liste ce qu’il a trouvé et vous laisse choisir la clé à donner aux workers.
Elle est copiée dans chaque worker à sa création, de sorte que `git clone`, `git pull` et
`git push` fonctionnent aussi bien dans le terminal que dans l’IDE ou pour un agent.

Pour utiliser un autre répertoire, montez-le sur `/host-ssh` — ou montez-le où vous voulez et
définissez `HOST_SSH_DIR`.

## Clés avec phrase de passe

Une clé sans phrase de passe est utilisée telle quelle. Une clé **avec** phrase de passe ne peut
pas l’être : personne n’est là pour taper la phrase de passe derrière un `git clone` lancé par
l’installation ou un `git push` lancé par un agent. Elle signe donc plutôt via un **agent SSH**.
Settings signale une telle clé par un badge *passphrase*, et un bandeau l’indique sur chaque page
tant que rien ne peut l’utiliser. Deux façons de lui fournir un agent :

### La déverrouiller dans Settings

Fonctionne partout, rien à configurer. Tapez la phrase de passe une fois : Lite charge la clé dans
son propre `ssh-agent` et oublie la phrase de passe — elle n’est jamais écrite sur le disque,
jamais stockée dans la base, jamais journalisée. La clé déchiffrée ne vit que dans la mémoire de cet
agent : après un redémarrage de Lite, la clé est de nouveau verrouillée et le bandeau la redemande.
**Lock** l’oublie immédiatement.

### Relayer l’agent de votre hôte

Si vous chargez déjà la clé avec `ssh-add` sur votre machine (trousseau, 1Password,
`gpg-agent`…), montez le socket de l’agent dans le conteneur Lite sur
`/run/host-services/ssh-auth.sock` :

```bash
# macOS — l'agent relayé propre à Docker Desktop
# (le socket launchd de $SSH_AUTH_SOCK ne peut pas être bind-monté depuis macOS) :
-v /run/host-services/ssh-auth.sock:/run/host-services/ssh-auth.sock

# Linux :
-v "$SSH_AUTH_SOCK:/run/host-services/ssh-auth.sock"
```

Sous Linux, le chemin de `$SSH_AUTH_SOCK` change à chaque session de connexion : recréez le
conteneur après vous être reconnecté. Settings indique si l’agent de l’hôte détient la clé
sélectionnée. Une clé déverrouillée dans Settings a priorité sur l’agent de l’hôte.

## Comment l’agent atteint les workers

Chaque worker monte le volume `spunto-lite-ssh-agent` et reçoit
`SSH_AUTH_SOCK=/run/spunto-ssh-agent/agent.sock`, un socket servi par Lite qui relaie vers l’agent,
quel qu’il soit, qui détient la clé. C’est un volume nommé parce que Docker Desktop ne sait pas faire
passer un socket Unix par un répertoire de l’hôte monté en bind mount. Le socket est toujours là :
déverrouiller une clé atteint donc aussi les workers déjà en cours d’exécution.

Si ce volume n’est pas monté sur le conteneur Lite, Settings le signale : les clés sans phrase de
passe continuent de fonctionner, celles qui en ont une, non.

> Comme pour tout relais d’agent, ce qui tourne dans un worker peut demander à l’agent de
> **signer** tant que la clé est déverrouillée — sans pouvoir lire la clé elle-même. Verrouillez-la
> quand vous confiez des workers à du code auquel vous ne faites pas confiance.

Les chemins se changent avec `SSH_AGENT_DIR` (par défaut `/run/spunto-ssh-agent`) et
`HOST_SSH_AUTH_SOCK` (par défaut `/run/host-services/ssh-auth.sock`).

## URL de clonage HTTPS

Une URL HTTPS clone sans clé quand le dépôt est public. Pour un dépôt privé en HTTPS, mettez un
jeton dans les identifiants de l’URL ou passez à l’URL SSH — la clé SSH est la voie autour de
laquelle Lite est conçu.
