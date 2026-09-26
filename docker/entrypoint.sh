#!/bin/sh
# Prépare l'accès Git (clé SSH, identité, clone du volume GIT_REPO_DIR si vide)
# puis lance la commande passée en argument (node server.js, ou la boucle de sync).
set -e

SSH_KEY_FILE="${GIT_SSH_KEY_FILE:-/run/secrets/git_ssh_key}"
if [ -f "$SSH_KEY_FILE" ]; then
  mkdir -p "$HOME/.ssh"
  cp "$SSH_KEY_FILE" "$HOME/.ssh/id_ed25519"
  chmod 600 "$HOME/.ssh/id_ed25519"
  ssh-keyscan -t ed25519,rsa github.com >> "$HOME/.ssh/known_hosts" 2>/dev/null || true
  export GIT_SSH_COMMAND="ssh -i $HOME/.ssh/id_ed25519 -o UserKnownHostsFile=$HOME/.ssh/known_hosts"
fi

git config --global user.name "${GIT_AUTHOR_NAME:-Riftbound bot}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-riftbound@localhost}"
git config --global --add safe.directory "${GIT_REPO_DIR:-/app}"

# web et sync partagent le même volume /repo et peuvent démarrer en même temps :
# flock évite que les deux ne clonent en parallèle au premier démarrage.
if [ "$GIT_PUBLISH" = "1" ] && [ -n "$GIT_REPO_URL" ]; then
  mkdir -p "$GIT_REPO_DIR"
  flock -w 120 "$GIT_REPO_DIR/.entrypoint.lock" -c \
    "[ -d '$GIT_REPO_DIR/.git' ] || (echo 'Clonage de $GIT_REPO_URL dans $GIT_REPO_DIR' && git clone '$GIT_REPO_URL' '$GIT_REPO_DIR')"
fi

exec "$@"
