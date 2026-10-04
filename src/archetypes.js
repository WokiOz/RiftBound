// Decks d'exemple ("archétypes") entretenus à la main, à titre indicatif —
// ce n'est pas une tier list méta (aucune source fiable et gratuite n'existe
// pour Riftbound), juste quelques recettes connues pour se situer par
// rapport à sa collection. `coreCards` ne couvre pas les 40 cartes d'un
// deck : c'est le cœur de l'archétype, utilisé pour calculer le % possédé.
const { ownedQty } = require('./decks');

const ARCHETYPES = [
  {
    id: 'vi-jinx-aggro',
    name: 'Vi / Jinx — Piltover Aggro',
    domains: ['Fury', 'Order'],
    description: "Courbe basse, pression dès le tour 2. Bonne porte d'entrée, peu de décisions difficiles.",
    coreCards: [
      { name: 'Vi - Piltover Enforcer', qty: 1 },
      { name: 'Vi - Peacekeeper', qty: 3 },
      { name: 'Jinx - Demolitionist', qty: 3 },
      { name: 'Hextech Gauntlets', qty: 2 },
      { name: 'Heroic Charge', qty: 3 },
      { name: 'Lord Broadmane', qty: 3 },
      { name: 'Right of Conquest', qty: 2 },
    ],
  },
  {
    id: 'leblanc-control',
    name: 'LeBlanc — Mirror Control',
    domains: ['Mind', 'Order'],
    description: 'Deck de valeur : copies et manipulation de la main adverse, gagne les parties longues.',
    coreCards: [
      { name: 'LeBlanc - Deceiver', qty: 1 },
      { name: 'LeBlanc - Fragmented', qty: 3 },
      { name: 'LeBlanc - Everywhere At Once', qty: 2 },
      { name: 'Mirror Image', qty: 3 },
      { name: "Shadow's Call", qty: 2 },
      { name: 'Turn to Dust', qty: 3 },
      { name: 'Sprite Fountain', qty: 2 },
    ],
  },
  {
    id: 'darius-noxus-aggro',
    name: 'Darius — Noxian Aggro',
    domains: ['Fury', 'Order'],
    description: 'Unités costaudes, finisseur direct au visage une fois la voie dégagée.',
    coreCards: [
      { name: 'Darius - Hand of Noxus', qty: 1 },
      { name: 'Lord Broadmane', qty: 3 },
      { name: 'Right of Conquest', qty: 3 },
      { name: 'Undying Legion', qty: 2 },
      { name: 'Prepared Neophyte', qty: 3 },
    ],
  },
];

// % possédé = somme(min(possédé, demandé)) / somme(demandé), toutes variantes
// d'un même nom de base confondues (Alternate Art, Signature...).
function withOwnership(archetype, cards, inventory) {
  const byBaseName = new Map();
  for (const card of cards) {
    const list = byBaseName.get(card.baseName) || [];
    list.push(card);
    byBaseName.set(card.baseName, list);
  }

  let have = 0;
  let needed = 0;
  const missing = [];
  for (const { name, qty } of archetype.coreCards) {
    needed += qty;
    const variants = byBaseName.get(name) || [];
    const owned = variants.reduce((a, c) => a + ownedQty(inventory, c.id), 0);
    have += Math.min(owned, qty);
    if (owned < qty) missing.push({ name, qty: qty - owned });
  }

  return {
    id: archetype.id,
    name: archetype.name,
    domains: archetype.domains,
    description: archetype.description,
    ownedRatio: needed ? Math.round((have / needed) * 100) / 100 : 0,
    missing,
  };
}

function buildArchetypes(cards, inventory) {
  return ARCHETYPES.map((a) => withOwnership(a, cards, inventory));
}

module.exports = { ARCHETYPES, buildArchetypes };
