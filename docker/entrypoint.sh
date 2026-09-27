#!/bin/sh
# Prépare l'accès Git (clé SSH, identité, clone du volume GIT_REPO_DIR si vide)
# puis lance la commande passée en argument (node server.js, ou la boucle de sync).
set -e

# Clé privée : soit un fichier monté (secret Docker ou volume), soit son contenu
# encodé en base64 dans GIT_SSH_KEY_B64 (pratique pour une stack Portainer liée
# à ce dépôt Git, où aucun fichier local ne peut être ajouté à côté du compose).
SSH_KEY_FILE="${GIT_SSH_KEY_FILE:-/run/secrets/git_ssh_key}"
if [ -f "$SSH_KEY_FILE" ]; then
  mkdir -p "$HOME/.ssh"
  cp "$SSH_KEY_FILE" "$HOME/.ssh/id_ed25519"
elif [ -n "$GIT_SSH_KEY_B64" ]; then
  mkdir -p "$HOME/.ssh"
  echo "$GIT_SSH_KEY_B64" | base64 -d > "$HOME/.ssh/id_ed25519"
fi
if [ -f "$HOME/.ssh/id_ed25519" ]; then
  chmod 600 "$HOME/.ssh/id_ed25519"
  ssh-keyscan -t ed25519,rsa github.com >> "$HOME/.ssh/known_hosts" 2>/dev/null || true
  export GIT_SSH_COMMAND="ssh -i $HOME/.ssh/id_ed25519 -o UserKnownHostsFile=$HOME/.ssh/known_hosts"
fi

git config --global user.name "${GIT_AUTHOR_NAME:-Riftbound bot}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-riftbound@localhost}"
git config --global --add safe.directory "${GIT_REPO_DIR:-/app}"

# web et sync partagent le même volume /repo et peuvent démarrer en même temps :
# flock évite que les deux ne clonent en parallèle au premier démarrage. Le verrou
# est posé dans DATA_DIR (volume séparé), jamais dans GIT_REPO_DIR lui-même :
# "git clone" refuse un dossier de destination non vide, y compris à cause d'un
# simple fichier de verrou qu'on y aurait laissé.
if [ "$GIT_PUBLISH" = "1" ] && [ -n "$GIT_REPO_URL" ]; then
  DATA_DIR="${DATA_DIR:-/data}"
  mkdir -p "$DATA_DIR" "$GIT_REPO_DIR"
  # Nettoyage d'un verrou laissé par erreur dans GIT_REPO_DIR par une version
  # antérieure de ce script (sinon le clone échoue indéfiniment).
  rm -f "$GIT_REPO_DIR/.entrypoint.lock"
  flock -w 120 "$DATA_DIR/.git-clone.lock" -c \
    "[ -d '$GIT_REPO_DIR/.git' ] || (echo 'Clonage de $GIT_REPO_URL dans $GIT_REPO_DIR' && git clone '$GIT_REPO_URL' '$GIT_REPO_DIR')"
fi

exec "$@"
