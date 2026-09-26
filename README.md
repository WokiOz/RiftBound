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
scripts/sync.js        point d'entrée du timer systemd
public/                interface web (HTML/CSS/JS, OCR via tesseract.js)
deploy/                unités systemd et configuration nginx
.github/workflows/     tests + déploiement SSH à chaque push sur main
reports/               rapports Markdown générés (inventaire, prix, decks)
```

## Installation locale

Node.js ≥ 20.

```bash
npm install
npm run sync     # télécharge catalogue + prix dans ./data
npm start        # http://localhost:3000
npm test
```

## Déploiement sur le serveur

Exemple pour Debian/Ubuntu avec Node.js ≥ 20, nginx et git installés.

**1. Utilisateur et code**

```bash
sudo useradd --system --create-home --home-dir /home/riftbound riftbound
sudo -u riftbound mkdir -m 700 /home/riftbound/.ssh
sudo -u riftbound ssh-keygen -t ed25519 -N "" -f /home/riftbound/.ssh/id_ed25519
sudo cat /home/riftbound/.ssh/id_ed25519.pub
```

Ajouter cette clé publique dans GitHub → *Settings → Deploy keys* du dépôt, **avec « Allow write access »** (nécessaire pour pousser les rapports).

```bash
sudo mkdir /opt/riftbound && sudo chown riftbound: /opt/riftbound
sudo -u riftbound git clone git@github.com:wokioz/riftbound.git /opt/riftbound
cd /opt/riftbound
sudo -u riftbound git config user.name "Riftbound bot"
sudo -u riftbound git config user.email "riftbound@localhost"
sudo -u riftbound npm ci --omit=dev
sudo -u riftbound cp .env.example .env   # puis éditer .env
```

**2. Services systemd**

```bash
sudo cp deploy/riftbound.service deploy/riftbound-sync.service deploy/riftbound-sync.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now riftbound riftbound-sync.timer
sudo systemctl start riftbound-sync     # première synchronisation
```

**3. nginx + HTTPS**

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/riftbound   # remplacer le server_name
sudo ln -s /etc/nginx/sites-available/riftbound /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d riftbound.example.com
```

HTTPS est nécessaire si `AUTH_USER`/`AUTH_PASSWORD` sont définis : en HTTP le mot de passe circule en clair.

**4. Déploiement automatique depuis GitHub**

Le workflow `.github/workflows/deploy.yml` lance les tests puis, sur `main`, se connecte en SSH et exécute `git pull`, `npm ci`, `systemctl restart riftbound`.

Autoriser le redémarrage sans mot de passe (`sudo visudo -f /etc/sudoers.d/riftbound`) :

```
riftbound ALL=(root) NOPASSWD: /usr/bin/systemctl restart riftbound
```

Secrets à créer dans GitHub → *Settings → Secrets and variables → Actions* :

| Secret | Valeur |
| --- | --- |
| `SSH_HOST` | adresse du serveur |
| `SSH_PORT` | port SSH (22 par défaut) |
| `SSH_USER` | `riftbound` |
| `SSH_KEY` | clé privée dont la clé publique est dans `/home/riftbound/.ssh/authorized_keys` |
| `APP_DIR` | `/opt/riftbound` (par défaut) |

Les commits de rapports faits par le serveur contiennent `[skip ci]` et ne touchent que `reports/` : ils ne relancent pas le déploiement.

## Variables d'environnement

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `PORT` | `3000` | port HTTP |
| `DATA_DIR` | `./data` | catalogue, prix, inventaire (JSON) |
| `AUTH_USER` / `AUTH_PASSWORD` | vide | active l'authentification HTTP Basic |
| `GIT_PUBLISH` | vide | `1` = commit + push de `reports/` après chaque synchronisation |
| `GIT_BRANCH` | `main` | branche de publication |

L'inventaire (`DATA_DIR/inventory.json`) n'est pas versionné : à sauvegarder.

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

## Scan : ce qui a été vérifié

Sur l'image officielle d'une carte, l'OCR lit `UNL • 121/219` et retrouve *Bewitching Spirit*. Sur une photo de téléphone, la réussite dépend de la netteté et de l'éclairage du code en bas à gauche ; en cas d'échec, utiliser la recherche manuelle (nom ou code).
