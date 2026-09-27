const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const config = require('./src/config');
const store = require('./src/store');
const { runSync } = require('./src/jobs');
const { priceOf } = require('./src/prices');
const { buildDecks } = require('./src/decks');
const { parsePrintedCode, findByCode } = require('./src/cardcode');
const { matchByName } = require('./src/namesearch');

let cards = [];
let prices = {};
let cardsById = new Map();
let syncing = null;
let loadedAt = 0;

function reload() {
  cards = store.loadCards();
  prices = store.loadPrices();
  cardsById = new Map(cards.map((c) => [c.id, c]));
  loadedAt = Date.now();
}

// Recharge le cache si le timer systemd (autre processus) a réécrit les prix
function reloadIfChanged() {
  try {
    if (fs.statSync(path.join(config.DATA_DIR, 'prices.json')).mtimeMs > loadedAt) reload();
  } catch {
    // fichier absent : pas encore synchronisé
  }
}

const withPrices = (card) => ({
  ...card,
  price: { normal: priceOf(card, prices, 'normal'), foil: priceOf(card, prices, 'foil') },
});

reload();

const app = express();
app.use(express.json());

// Authentification HTTP Basic, active seulement si AUTH_USER et AUTH_PASSWORD sont définis
if (config.AUTH_USER && config.AUTH_PASSWORD) {
  const expected = Buffer.from(`${config.AUTH_USER}:${config.AUTH_PASSWORD}`);
  app.use((req, res, next) => {
    const given = Buffer.from((req.headers.authorization || '').replace(/^Basic /, ''), 'base64');
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return next();
    res.set('WWW-Authenticate', 'Basic realm="Riftbound"').status(401).send('Authentification requise');
  });
}

// Identifiant qui change à chaque démarrage du conteneur, utilisé pour
// "casser" le cache de app.js/style.css. Certains reverse proxys (Nginx,
// Nginx Proxy Manager...) mettent en cache les fichiers .js/.css plusieurs
// heures indépendamment des en-têtes envoyés par ce serveur ; en changeant
// l'URL à chaque déploiement, un nouveau déploiement n'est jamais bloqué
// par une ancienne version encore en cache côté proxy.
const BUILD_ID = Date.now().toString(36);
const INDEX_HTML = fs
  .readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8')
  .replace('app.js"', `app.js?v=${BUILD_ID}"`)
  .replace('style.css"', `style.css?v=${BUILD_ID}"`);

app.get(['/', '/index.html'], (req, res) => {
  res.set('Cache-Control', 'no-cache').type('html').send(INDEX_HTML);
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', (req, res, next) => {
  reloadIfChanged();
  next();
});

app.get('/api/status', (req, res) => {
  res.json({
    cards: cards.length,
    pricesUpdatedAt: prices.updatedAt,
    pricesSourceUpdatedAt: prices.sourceUpdatedAt,
    syncing: Boolean(syncing),
    sets: [...new Set(cards.map((c) => c.set))].sort(),
    types: [...new Set(cards.map((c) => c.type))].sort(),
  });
});

// Recherche dans le catalogue : ?q=&set=&type=&domain=
app.get('/api/cards', (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  const { set, type, domain } = req.query;
  const result = cards
    .filter((c) => !q || c.name.toLowerCase().includes(q) || c.code.includes(q))
    .filter((c) => !set || c.set === set)
    .filter((c) => !type || c.type === type)
    .filter((c) => !domain || c.domains.includes(domain))
    .slice(0, 200)
    .map(withPrices);
  res.json(result);
});

// Scan : reçoit le texte OCR, renvoie le code détecté et les cartes correspondantes
app.post('/api/scan', (req, res) => {
  const code = parsePrintedCode(String(req.body.text || ''));
  if (!code) return res.json({ code: null, cards: [] });
  res.json({ code, cards: findByCode(cards, code).map(withPrices) });
});

// Identification rapide par le nom (gros texte, plus facile à lire par l'OCR
// que le petit code). Volontairement strict : voir src/namesearch.js.
app.post('/api/scan-name', (req, res) => {
  const card = matchByName(cards, String(req.body.text || ''));
  res.json(card ? { confident: true, card: withPrices(card) } : { confident: false });
});

app.get('/api/inventory', (req, res) => {
  const inventory = store.loadInventory();
  const items = [];
  let value = 0;
  for (const [id, finishes] of Object.entries(inventory)) {
    const card = cardsById.get(id);
    if (!card) continue;
    for (const [finish, qty] of Object.entries(finishes)) {
      const unitPrice = priceOf(card, prices, finish);
      value += (unitPrice || 0) * qty;
      items.push({ card, finish, qty, unitPrice });
    }
  }
  items.sort((a, b) => a.card.name.localeCompare(b.card.name));
  res.json({ items, value: Math.round(value * 100) / 100, currency: prices.currency });
});

// Ajout/retrait : { id, finish: "normal"|"foil", delta: +1|-1 }
app.post('/api/inventory', (req, res) => {
  const { id, finish, delta } = req.body;
  if (!cardsById.has(id)) return res.status(404).json({ error: 'Carte inconnue' });
  if (!['normal', 'foil'].includes(finish)) return res.status(400).json({ error: 'Finition invalide' });
  if (!Number.isInteger(delta)) return res.status(400).json({ error: 'delta doit être un entier' });

  const inventory = store.loadInventory();
  const entry = inventory[id] || {};
  const qty = Math.max(0, (entry[finish] || 0) + delta);
  if (qty) entry[finish] = qty;
  else delete entry[finish];
  if (Object.keys(entry).length) inventory[id] = entry;
  else delete inventory[id];
  store.saveInventory(inventory);
  res.json({ id, finish, qty });
});

app.get('/api/decks', (req, res) => {
  res.json(buildDecks(cards, store.loadInventory(), prices));
});

// Synchronisation manuelle (la synchronisation régulière passe par le timer systemd)
app.post('/api/sync', async (req, res) => {
  if (syncing) return res.status(409).json({ error: 'Synchronisation déjà en cours' });
  syncing = runSync();
  try {
    const result = await syncing;
    reload();
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  } finally {
    syncing = null;
  }
});

app.listen(config.PORT, () => {
  console.log(`Riftbound inventaire sur http://localhost:${config.PORT} (${cards.length} cartes en cache)`);
  if (!cards.length) console.log('Catalogue vide : lancer "npm run sync" ou le bouton Synchroniser.');
});
