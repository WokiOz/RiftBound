const test = require('node:test');
const assert = require('node:assert');
const { matchByName } = require('../src/namesearch');

const card = (id, name, set, extra = {}) => ({
  id, name, baseName: name, set, type: 'Unit', supertype: null, ...extra,
});

test('trouve une carte au nom unique malgré du bruit OCR', () => {
  const cards = [card('a', 'Solari Chief', 'OGN'), card('b', 'Bewitching Spirit', 'UNL')];
  assert.strictEqual(matchByName(cards, 'Solari Chief').id, 'a');
  assert.strictEqual(matchByName(cards, 'S0lari Ch1ef').id, 'a'); // fautes OCR
});

test('refuse un nom réimprimé dans plusieurs sets (ambigu)', () => {
  const cards = [card('a', 'Voracious Gromp', 'UNL'), card('b', 'Voracious Gromp', 'OPP')];
  assert.strictEqual(matchByName(cards, 'Voracious Gromp'), null);
});

test('refuse quand du bruit OCR rend deux noms proches trop ambigus', () => {
  const cards = [card('a', 'Right of Conquest', 'UNL'), card('b', 'Right to Conquest', 'UNL')];
  // Ni "of" ni "to" : équidistant des deux, pas de marge suffisante pour trancher
  assert.strictEqual(matchByName(cards, 'Right op Conquest'), null);
});

test('préfère l\'impression normale à une variante quand les deux partagent le même nom de base', () => {
  const cards = [
    { id: 'a', name: 'Red Brambleback', baseName: 'Red Brambleback', set: 'UNL', type: 'Unit', supertype: null },
    { id: 'b', name: 'Red Brambleback (Alternate Art)', baseName: 'Red Brambleback', set: 'UNL', type: 'Unit', supertype: null },
  ];
  assert.strictEqual(matchByName(cards, 'Red Brambleback').id, 'a');
});

test('ignore les jetons de partie et le texte hors catalogue', () => {
  const cards = [card('a', 'Gold', 'SFD', { supertype: 'Token' })];
  assert.strictEqual(matchByName(cards, 'Gold'), null);
  assert.strictEqual(matchByName(cards, 'zzzz qqqq wwww'), null);
});

test('trouve le nom au milieu d\'un bloc OCR bruité (cadrage imprécis, capture large)', () => {
  const cards = [card('a', 'Solari Chief', 'OGN'), card('b', 'Bewitching Spirit', 'UNL')];
  // Simule une capture large qui inclut de l'illustration/du texte de règle
  // autour du nom, comme quand le cadrage réel n'est pas pixel-parfait
  const noisy = 'xjk29 zoab UNIT MOUNT TARGON Solari Chief When you play me choose';
  assert.strictEqual(matchByName(cards, noisy).id, 'a');
});

test('refuse toujours l\'ambiguïté multi-sets même noyée dans du bruit', () => {
  const cards = [card('a', 'Voracious Gromp', 'UNL'), card('b', 'Voracious Gromp', 'OPP')];
  const noisy = 'xjk29 zoab UNIT SOMETHING Voracious Gromp When you play me';
  assert.strictEqual(matchByName(cards, noisy), null);
});
