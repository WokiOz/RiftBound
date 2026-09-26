// Construction de decks à partir de l'inventaire.
// Règles appliquées (règles officielles de construction Riftbound) :
//  - 1 Legend ; ses domaines définissent l'identité du deck
//  - Main deck de 40 cartes, dont 1 Chosen Champion (unité Champion portant le tag de la Legend)
//  - 3 exemplaires max par nom de carte (le Chosen Champion compte dans ces 3)
//  - 3 cartes Signature max au total, uniquement celles du champion de la Legend
//  - 12 Runes des domaines de la Legend
//  - 3 Battlefields de noms différents
const { cheapestPrice } = require('./prices');

const MAIN_DECK_SIZE = 40;
const RUNE_COUNT = 12;
const BATTLEFIELD_COUNT = 3;
const MAX_COPIES = 3;
const MAX_SIGNATURES = 3;
const MAIN_TYPES = new Set(['Unit', 'Spell', 'Gear']);

function ownedQty(inventory, cardId) {
  const entry = inventory[cardId];
  return entry ? (entry.normal || 0) + (entry.foil || 0) : 0;
}

// Regroupe les variantes (Alternate Art, Signature…) sous un même nom
function groupByName(cards, inventory, prices) {
  const groups = new Map();
  for (const card of cards) {
    const g = groups.get(card.baseName) || { name: card.baseName, cards: [], owned: 0, card };
    g.cards.push(card);
    g.owned += ownedQty(inventory, card.id);
    groups.set(card.baseName, g);
  }
  for (const g of groups.values()) {
    // Carte de référence = variante la moins chère (utilisée pour les suggestions d'achat)
    const priced = g.cards
      .map((c) => ({ c, price: cheapestPrice(c, prices) }))
      .filter((x) => x.price != null)
      .sort((a, b) => a.price - b.price);
    g.card = priced[0]?.c || g.cards[0];
    g.price = priced[0]?.price ?? null;
  }
  return [...groups.values()];
}

const sharesTag = (card, tags) => card.tags.some((t) => tags.includes(t));
const fitsDomains = (card, domains) => card.domains.every((d) => d === 'Colorless' || domains.includes(d));

function suggest(groups, qtyNeeded, alreadyUsed = new Map()) {
  const out = [];
  let remaining = qtyNeeded;
  const candidates = groups
    .filter((g) => g.price != null)
    .sort((a, b) => a.price - b.price || a.name.localeCompare(b.name));
  for (const g of candidates) {
    if (remaining <= 0) break;
    const room = MAX_COPIES - (alreadyUsed.get(g.name) || 0);
    const qty = Math.min(room, remaining);
    if (qty <= 0) continue;
    out.push({ code: g.card.code, name: g.name, qty, unitPrice: g.price });
    remaining -= qty;
  }
  return out;
}

function buildDeck(legend, cards, inventory, prices) {
  const tags = legend.tags;
  const domains = legend.domains;
  const playable = cards.filter((c) => c.supertype !== 'Token');

  const mainPool = groupByName(
    playable.filter(
      (c) => MAIN_TYPES.has(c.type) && fitsDomains(c, domains) && (c.supertype !== 'Signature' || sharesTag(c, tags)),
    ),
    inventory,
    prices,
  );
  const champions = mainPool.filter((g) => g.card.type === 'Unit' && g.card.supertype === 'Champion' && sharesTag(g.card, tags));

  const main = new Map(); // nom -> quantité
  const toBuy = [];
  let signatures = 0;
  const add = (g, qty) => {
    main.set(g.name, (main.get(g.name) || 0) + qty);
    if (g.card.supertype === 'Signature') signatures += qty;
  };
  const total = () => [...main.values()].reduce((a, b) => a + b, 0);

  // 1. Chosen Champion : le champion possédé en plus grand nombre
  const ownedChampions = champions.filter((g) => g.owned > 0).sort((a, b) => b.owned - a.owned);
  const chosen = ownedChampions[0] || null;
  if (chosen) add(chosen, Math.min(chosen.owned, MAX_COPIES));
  else toBuy.push(...suggest(champions, 1));
  // Exemplaires déjà prévus par nom (possédés + champion à acheter), pour respecter la limite de 3
  const planned = () => {
    const used = new Map(main);
    if (!chosen && toBuy[0]) used.set(toBuy[0].name, 1);
    return used;
  };

  // 2. Reste du main deck : cartes du champion d'abord, puis les plus possédées, puis les moins chères en énergie
  const rest = mainPool
    .filter((g) => g.owned > 0 && g !== chosen)
    .sort(
      (a, b) =>
        Number(sharesTag(b.card, tags)) - Number(sharesTag(a.card, tags)) ||
        b.owned - a.owned ||
        (a.card.energy ?? 99) - (b.card.energy ?? 99) ||
        a.name.localeCompare(b.name),
    );
  for (const g of rest) {
    const room = MAIN_DECK_SIZE - total() - (chosen ? 0 : 1); // place réservée au champion manquant
    if (room <= 0) break;
    let qty = Math.min(g.owned, MAX_COPIES, room);
    if (g.card.supertype === 'Signature') qty = Math.min(qty, MAX_SIGNATURES - signatures);
    if (qty > 0) add(g, qty);
  }

  const missingMain = MAIN_DECK_SIZE - total() - (chosen ? 0 : 1);
  if (missingMain > 0) {
    const buyable = mainPool.filter((g) => g.card.supertype !== 'Signature' && g !== chosen);
    toBuy.push(...suggest(buyable, missingMain, planned()));
  }

  // 3. Runes : réparties équitablement entre les domaines de la Legend
  const runeGroups = groupByName(
    playable.filter((c) => c.type === 'Rune' && fitsDomains(c, domains)),
    inventory,
    prices,
  );
  const runes = [];
  const perDomain = Math.floor(RUNE_COUNT / domains.length);
  for (const domain of domains) {
    const ofDomain = runeGroups.filter((g) => g.card.domains.includes(domain));
    const owned = ofDomain.reduce((a, g) => a + g.owned, 0);
    const qty = Math.min(owned, perDomain);
    if (qty > 0) runes.push({ name: `${domain} Rune`, qty });
    if (qty < perDomain) {
      const cheapest = ofDomain.filter((g) => g.price != null).sort((a, b) => a.price - b.price)[0];
      if (cheapest) toBuy.push({ code: cheapest.card.code, name: cheapest.name, qty: perDomain - qty, unitPrice: cheapest.price });
    }
  }

  // 4. Battlefields : 3 noms différents
  const bfGroups = groupByName(playable.filter((c) => c.type === 'Battlefield'), inventory, prices);
  const battlefields = bfGroups.filter((g) => g.owned > 0).slice(0, BATTLEFIELD_COUNT).map((g) => g.name);
  if (battlefields.length < BATTLEFIELD_COUNT) {
    const buyable = bfGroups
      .filter((g) => g.owned === 0 && g.price != null)
      .sort((a, b) => a.price - b.price)
      .slice(0, BATTLEFIELD_COUNT - battlefields.length);
    toBuy.push(...buyable.map((g) => ({ code: g.card.code, name: g.name, qty: 1, unitPrice: g.price })));
  }

  const runeTotal = runes.reduce((a, r) => a + r.qty, 0);
  return {
    legend: { code: legend.code, name: legend.baseName, domains },
    champion: chosen ? chosen.name : null,
    main: [...main].map(([name, qty]) => ({ name, qty })),
    runes,
    battlefields,
    counts: { main: total(), runes: runeTotal, battlefields: battlefields.length },
    complete: Boolean(chosen) && total() === MAIN_DECK_SIZE && runeTotal === RUNE_COUNT && battlefields.length === BATTLEFIELD_COUNT,
    toBuy,
    toBuyTotal: Math.round(toBuy.reduce((a, x) => a + x.qty * x.unitPrice, 0) * 100) / 100,
  };
}

// Un deck par Legend possédée (variantes regroupées)
function buildDecks(cards, inventory, prices) {
  const seen = new Set();
  return cards
    .filter((c) => c.type === 'Legend' && ownedQty(inventory, c.id) > 0)
    .filter((c) => !seen.has(c.baseName) && seen.add(c.baseName))
    .map((legend) => buildDeck(legend, cards, inventory, prices));
}

module.exports = { buildDecks, buildDeck, ownedQty, MAIN_DECK_SIZE, RUNE_COUNT, BATTLEFIELD_COUNT };
