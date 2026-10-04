const test = require('node:test');
const assert = require('node:assert');
const { buildArchetypes } = require('../src/archetypes');

const card = (id, baseName, extra = {}) => ({ id, baseName, ...extra });

test('calcule le % possédé sur les cartes cœur d\'un archétype', () => {
  const cards = [
    card('a', 'Vi - Piltover Enforcer'),
    card('b', 'Vi - Peacekeeper'),
  ];
  const inventory = { a: { normal: 1 }, b: { normal: 3 } };
  const [viJinx] = buildArchetypes(cards, inventory);
  // 1/1 (Enforcer) + 3/3 (Peacekeeper) sur un total nécessaire de 17 cartes cœur
  assert.ok(viJinx.ownedRatio > 0 && viJinx.ownedRatio < 1);
  assert.ok(viJinx.missing.some((m) => m.name === 'Jinx - Demolitionist'));
  assert.ok(!viJinx.missing.some((m) => m.name === 'Vi - Peacekeeper'));
});

test('ratio à 0 sans inventaire', () => {
  const archetypes = buildArchetypes([], {});
  assert.ok(archetypes.every((a) => a.ownedRatio === 0));
  assert.ok(archetypes.every((a) => a.missing.length === a.missing.length)); // pas de crash
});
