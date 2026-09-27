# RiftBound — inventaire, scan, decks et prix

Site web auto-hébergé pour les cartes **Riftbound** :

- **Scanner** une carte avec le téléphone (photo → lecture du code imprimé en bas à gauche, ex. `UNL • 121/219`).
- **Inventaire** des cartes possédées (normal / foil) avec valeur estimée.
- **Decks** générés à partir de l'inventaire, avec la liste des cartes à acheter et leur prix.
- **Catalogue & prix** de toutes les cartes.
- **Synchronisation quotidienne** des prix, génération de rapports Markdown dans `reports/` et push sur ce dépôt.

## Sources de données

| Donnée | Source | Détail |
| --- | --- | --- |
| Catalogue des cartes | [api.riftcodex.com](https://api.riftcodex.com) | 1451 cartes au 26/09/2026, avec l'id produit TCGplayer |
| Prix | [tcgcsv.com](https://tcgcsv.com) (catégorie TCGplayer 89) | Prix *market* TCGplayer en **USD**, republiés une fois par jour (~20h UTC) |

Limites connues :

- 227 cartes du catalogue n'ont pas d'id TCGplayer → pas de prix (affiché `—`).
- Les prix sont ceux de TCGplayer (marché US, USD). Cardmarket (EUR) n'est pas utilisé.
- Riftcodex a des codes en double (ex. `ven-r06`, versions « Metal ») : l'inventaire utilise donc l'id interne Riftcodex, unique.

## Règles appliquées pour les decks

Règles officielles de construction :

- 1 Legend ; ses 2 domaines définissent les cartes autorisées (les cartes `Colorless` sont acceptées).
- Main deck de 40 cartes, dont 1 Chosen Champion (unité *Champion* portant le tag de la Legend).
- 3 exemplaires max par nom (variantes comprises), 3 cartes *Signature* max, uniquement celles du champion de la Legend.
- 12 Runes (6 par domaine), 3 Battlefields de noms différents.

Choix des cartes parmi celles possédées (dans cet ordre) : cartes du champion de la Legend, puis cartes possédées en plus grand nombre, puis coût en énergie le plus bas. Il s'agit d'un classement simple, pas d'une évaluation de la force du deck.
Cartes à acheter : les moins chères du marché qui respectent les règles.

## Structure

```
server.js              API Express + fichiers statiques
src/config.js          configuration (variables d'environnement)
src/sync.js            récupération catalogue (Riftcodex) et prix (tcgcsv)
src/store.js           lecture/écriture JSON dans DATA_DIR
src/cardcode.js        lecture du code imprimé et correspondance carte
src/decks.js           construction des decks
src/markdown.js        génération de reports/*.md
src/publish.js         commit + push de reports/
src/jobs.js            enchaînement sync → Markdown → push
scripts/sync.js        point d'entrée de la synchronisation (timer systemd ou boucle Docker)
public/                interface web (HTML/CSS/JS, OCR via tesseract.js)
Dockerfile              image Docker (voir GitHub Packages)
docker/                 entrypoint et boucle de synchronisation de l'image
docker-compose.yml      stack pour Portainer, basée sur l'image publiée
deploy/                 alternative : unités systemd et configuration nginx
.github/workflows/      tests + build/push de l'image Docker à chaque push sur main
reports/                rapports Markdown générés (inventaire, prix, decks)
```

## Installation locale

Node.js ≥ 20.

```bash
npm install
npm run sync     # télécharge catalogue + prix dans ./data
npm start        # http://localhost:3000
npm test
```

## Déploiement avec Docker (Portainer)

L'image est construite et publiée automatiquement sur **GitHub Packages** (`ghcr.io/wokioz/riftbound`) par `.github/workflows/deploy.yml` à chaque push sur `main` : `:latest` pointe toujours vers la dernière version, et chaque build est aussi tagué avec le sha court du commit. Un tag Git `vX.Y.Z` publie en plus l'image sous ce numéro de version.

La stack (`docker-compose.yml`) a deux services partageant les mêmes volumes :
- **web** : sert le site, publié sur le port **5901** de l'hôte (`WEB_PORT`, configurable).
- **sync** : relance `scripts/sync.js` toutes les `SYNC_INTERVAL_SECONDS` (24h par défaut).

Les deux poussent les rapports sur GitHub via un clone Git conservé dans le volume `repo` (cloné automatiquement au premier démarrage). `docker-compose.yml` ne référence aucun fichier local : toute la config passe par des variables d'environnement, pour pouvoir lier la stack directement au dépôt Git dans Portainer.

**1. Lier le dépôt dans Portainer**

*Stacks → Add stack → Build method : Repository* :
- **Repository URL** : `https://github.com/wokioz/riftbound` (ou l'URL de ton fork)
- **Repository reference** : `refs/heads/main`
- **Compose path** : `docker-compose.yml`

Portainer clone le dépôt et déploie ce fichier tel quel, sans rien à copier à la main.

**2. Deploy key GitHub (écriture)**

```bash
ssh-keygen -t ed25519 -N "" -f git_ssh_key
base64 -w0 git_ssh_key    # à coller dans la variable GIT_SSH_KEY_B64
cat git_ssh_key.pub       # à ajouter comme Deploy key
```

Ajouter la clé publique dans GitHub → *Settings → Deploy keys* du dépôt, **avec « Allow write access »** (nécessaire pour pousser les rapports). Ne jamais committer `git_ssh_key`.

**3. Variables d'environnement de la stack**

Dans l'éditeur de stack Portainer (section *Environment variables*), renseigner les variables listées dans `.env.example` — en particulier `GIT_SSH_KEY_B64` (coller le base64 de l'étape précédente) et `AUTH_PASSWORD` si utilisée, à marquer comme **sensibles**. Laisser `WEB_PORT` à `5901` ou le changer si ce port est déjà pris sur le serveur.

**4. Package privé (si applicable)**

Si le package `ghcr.io/wokioz/riftbound` est privé, connecter le serveur une fois :

```bash
echo <PAT avec le scope read:packages> | docker login ghcr.io -u <utilisateur> --password-stdin
```

Ou le rendre public depuis GitHub → l'onglet *Packages* du profil/organisation → *Package settings*.

**5. Déployer**

Bouton *Deploy the stack*. Le site est joignable sur `http://<serveur>:5901`.

En ligne de commande (sans Portainer), copier `docker-compose.yml` et `.env.example` (renommé `.env`) côte à côte, puis :

```bash
docker compose up -d
```

**6. Mettre à jour**

`:latest` est réécrit à chaque push sur `main`. Sur le serveur : bouton Portainer *Pull and redeploy* (ou `docker compose pull && docker compose up -d` en ligne de commande), ou l'agent [Watchtower](https://containrrr.dev/watchtower/) pour automatiser. Un push sur `main` ne redéploie pas la stack tout seul : Portainer republie la nouvelle image seulement quand on la lui demande (bouton, webhook, ou Watchtower).

**HTTPS** : le service `web` n'expose que du HTTP. Passer par le reverse proxy déjà en place sur le serveur (nginx, Traefik, Nginx Proxy Manager…) pour le certificat, en le pointant vers le port `5901`. Obligatoire si `AUTH_USER`/`AUTH_PASSWORD` sont définis : en HTTP le mot de passe circule en clair.

## Déploiement alternatif : systemd

Sans Docker, sur Debian/Ubuntu avec Node.js ≥ 20, nginx et git installés. Voir `deploy/.env.example`, `deploy/riftbound.service`, `deploy/riftbound-sync.service`, `deploy/riftbound-sync.timer` et `deploy/nginx.conf`.

```bash
sudo useradd --system --create-home --home-dir /home/riftbound riftbound
sudo -u riftbound mkdir -m 700 /home/riftbound/.ssh
sudo -u riftbound ssh-keygen -t ed25519 -N "" -f /home/riftbound/.ssh/id_ed25519
sudo cat /home/riftbound/.ssh/id_ed25519.pub   # à ajouter en Deploy key GitHub, écriture activée

sudo mkdir /opt/riftbound && sudo chown riftbound: /opt/riftbound
sudo -u riftbound git clone git@github.com:wokioz/riftbound.git /opt/riftbound
cd /opt/riftbound
sudo -u riftbound git config user.name "Riftbound bot"
sudo -u riftbound git config user.email "riftbound@localhost"
sudo -u riftbound npm ci --omit=dev
sudo -u riftbound cp deploy/.env.example .env   # puis éditer .env

sudo cp deploy/riftbound.service deploy/riftbound-sync.service deploy/riftbound-sync.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now riftbound riftbound-sync.timer
sudo systemctl start riftbound-sync     # première synchronisation

sudo cp deploy/nginx.conf /etc/nginx/sites-available/riftbound   # remplacer le server_name
sudo ln -s /etc/nginx/sites-available/riftbound /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d riftbound.example.com
```

## Variables d'environnement

Docker (stack Portainer ou `.env` à côté de `docker-compose.yml`) et systemd (`deploy/.env.example`) ont des variables différentes : Docker fixe `DATA_DIR=/data` et `GIT_REPO_DIR=/repo` dans l'image (volumes de la stack) et publie le port via `WEB_PORT`, pendant que systemd utilise `PORT`/`DATA_DIR` directement.

**Docker** (`docker-compose.yml`, détail dans `.env.example`) :

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `WEB_PORT` | `5901` | port publié sur l'hôte par le service `web` (le conteneur écoute en interne sur 3000) |
| `AUTH_USER` / `AUTH_PASSWORD` | vide | active l'authentification HTTP Basic |
| `GIT_PUBLISH` | `1` | `1` = commit + push de `reports/` après chaque synchronisation |
| `GIT_BRANCH` | `main` | branche de publication |
| `GIT_REPO_URL` | `git@github.com:wokioz/riftbound.git` | dépôt cloné dans le volume `repo` au premier démarrage |
| `GIT_SSH_KEY_B64` | vide | clé privée (Deploy key, écriture) encodée en base64 — variable à marquer « sensible » |
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | `Riftbound bot` / `riftbound@localhost` | identité des commits automatiques |
| `SYNC_INTERVAL_SECONDS` | `86400` | intervalle du service `sync`, en secondes |

**systemd** (`deploy/.env.example`) :

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `PORT` | `3000` | port HTTP |
| `DATA_DIR` | `./data` | catalogue, prix, inventaire (JSON) |
| `AUTH_USER` / `AUTH_PASSWORD` | vide | active l'authentification HTTP Basic |
| `GIT_PUBLISH` | vide | `1` = commit + push de `reports/` après chaque synchronisation |
| `GIT_BRANCH` | `main` | branche de publication |

L'inventaire (`inventory.json`) n'est pas versionné : à sauvegarder (volume `data` en Docker, `DATA_DIR` en systemd).

## API

| Méthode | Route | Rôle |
| --- | --- | --- |
| GET | `/api/status` | nombre de cartes, date des prix, sets, types |
| GET | `/api/cards?q=&set=&type=&domain=` | recherche (200 résultats max) |
| POST | `/api/scan` `{text}` | texte OCR → code détecté + cartes |
| GET | `/api/inventory` | inventaire + valeur |
| POST | `/api/inventory` `{id, finish, delta}` | ajoute/retire des exemplaires |
| GET | `/api/decks` | decks générés |
| POST | `/api/sync` | synchronisation manuelle |

## Image Docker

`docker build .` produit une image `node:22-alpine` avec `git`, `openssh-client` et `util-linux` (pour `flock`). Elle tourne en utilisateur non-root (`node`). `ENTRYPOINT` (`docker/entrypoint.sh`) écrit la clé SSH depuis `GIT_SSH_KEY_B64` (ou un fichier monté via `GIT_SSH_KEY_FILE`/`/run/secrets/git_ssh_key`), configure l'identité Git, puis clone `GIT_REPO_URL` dans `GIT_REPO_DIR` (`/repo`) si absent, avant de lancer la commande :

- par défaut : `node server.js` (service `web`) ;
- avec `sh docker/sync-loop.sh` (service `sync`) : synchronisation immédiate puis toutes les `SYNC_INTERVAL_SECONDS`.

`web` et `sync` partagent les volumes `data` (catalogue/prix/inventaire) et `repo` (clone Git) ; un verrou (`flock`) évite qu'ils clonent en même temps au premier démarrage.

Vérifié dans cette session : syntaxe du `Dockerfile`, des scripts `docker/*.sh`, et validité du `docker-compose.yml` (`docker compose config`). Le build de l'image elle-même n'a pas pu être exécuté ici (daemon Docker indisponible dans cet environnement) ; il l'est en revanche à chaque push par `.github/workflows/deploy.yml`, dont le succès est visible dans l'onglet *Actions* du dépôt.

## Scan : ce qui a été vérifié

Sur l'image officielle d'une carte, l'OCR lit `UNL • 121/219` et retrouve *Bewitching Spirit*. Sur une photo de téléphone, la réussite dépend de la netteté et de l'éclairage du code en bas à gauche ; en cas d'échec, utiliser la recherche manuelle (nom ou code).
