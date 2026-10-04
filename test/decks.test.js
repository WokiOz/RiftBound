const test = require('node:test');
const assert = require('node:assert');
const { buildDecks } = require('../src/decks');

const card = (id, type, extra = {}) => ({
  id, code: id, name: id, baseName: id, type, supertype: null, domains: ['Fury', 'Order'], tags: [], energy: 2, tcgplayerId: null, ...extra,
});

const cards = [
  card('vi-legend', 'Legend', { tags: ['Vi'] }),
  card('vi-champion', 'Unit', { supertype: 'Champion', tags: ['Vi'], domains: ['Fury'] }),
  ...Array.from({ length: 13 }, (_, i) => card(`unit-${i}`, 'Unit', { domains: ['Order'] })),
  card('mind-unit', 'Unit', { domains: ['Mind'] }),
  card('fury-rune', 'Rune', { baseName: 'Fury Rune', supertype: 'Basic', domains: ['Fury'] }),
  card('order-rune', 'Rune', { baseName: 'Order Rune', supertype: 'Basic', domains: ['Order'] }),
  ...Array.from({ length: 3 }, (_, i) => card(`bf-${i}`, 'Battlefield', { domains: ['Colorless'] })),
];

test('construit un deck complet et légal', () => {
  const inventory = { 'vi-legend': { normal: 1 }, 'vi-champion': { normal: 3 }, 'mind-unit': { normal: 3 },
    'fury-rune': { normal: 8 }, 'order-rune': { normal: 6 }, 'bf-0': { normal: 1 }, 'bf-1': { normal: 1 }, 'bf-2': { normal: 2 } };
  for (let i = 0; i < 13; i++) inventory[`unit-${i}`] = { normal: 4 };

  const [{ variants }] = buildDecks(cards, inventory, { byProduct: {} });
  assert.strictEqual(variants.length, 1, 'un seul champion possédé = une seule variante');
  const { deck } = variants[0];
  assert.strictEqual(deck.champion, 'vi-champion');
  assert.strictEqual(deck.counts.main, 40);
  assert.ok(deck.main.every((m) => m.qty <= 3));
  assert.ok(!deck.main.some((m) => m.name === 'mind-unit'), 'hors domaines de la Legend');
  assert.deepStrictEqual(deck.runes, [{ name: 'Fury Rune', qty: 6 }, { name: 'Order Rune', qty: 6 }]);
  assert.strictEqual(deck.counts.battlefields, 3);
  assert.strictEqual(deck.complete, true);
});

test('propose les cartes manquantes les moins chères', () => {
  const priced = cards.map((c, i) => ({ ...c, tcgplayerId: i + 1 }));
  const byProduct = Object.fromEntries(priced.map((c) => [c.tcgplayerId, { normal: { market: c.tcgplayerId / 10 } }]));
  const [{ variants }] = buildDecks(priced, { 'vi-legend': { normal: 1 } }, { byProduct });
  const { deck } = variants[0];
  assert.strictEqual(deck.complete, false);
  assert.strictEqual(deck.toBuy[0].name, 'vi-champion');
  const mainToBuy = deck.toBuy.filter((b) => /^(unit|vi-champion)/.test(b.name));
  assert.strictEqual(mainToBuy.reduce((a, b) => a + b.qty, 0), 40);
  const championCopies = mainToBuy.filter((b) => b.name === 'vi-champion').reduce((a, b) => a + b.qty, 0);
  assert.ok(championCopies <= 3, 'limite de 3 exemplaires');
  assert.ok(deck.toBuyTotal > 0);
});

test('propose une variante par champion possédé', () => {
  const withSecondChampion = [
    ...cards,
    card('vi-champion-2', 'Unit', { baseName: 'vi-champion-2', supertype: 'Champion', tags: ['Vi'], domains: ['Order'] }),
  ];
  const inventory = { 'vi-legend': { normal: 1 }, 'vi-champion': { normal: 3 }, 'vi-champion-2': { normal: 1 },
    'fury-rune': { normal: 8 }, 'order-rune': { normal: 6 }, 'bf-0': { normal: 1 }, 'bf-1': { normal: 1 }, 'bf-2': { normal: 2 } };
  for (let i = 0; i < 13; i++) inventory[`unit-${i}`] = { normal: 4 };

  const [{ variants }] = buildDecks(withSecondChampion, inventory, { byProduct: {} });
  assert.strictEqual(variants.length, 2);
  assert.strictEqual(variants[0].isDefault, true);
  assert.strictEqual(variants[0].deck.champion, 'vi-champion', 'le plus possédé est la variante par défaut');
  assert.strictEqual(variants[1].deck.champion, 'vi-champion-2');
});
