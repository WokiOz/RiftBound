const test = require('node:test');
const assert = require('node:assert');
const { parsePrintedCode, findByCode } = require('../src/cardcode');

test('lit le code imprimé en bas de carte', () => {
  assert.deepStrictEqual(parsePrintedCode('UNL • 121/219  Wild Blue Studios'), { set: 'UNL', number: 121, variant: '', total: 219 });
  assert.deepStrictEqual(parsePrintedCode('ogn · 045a/298'), { set: 'OGN', number: 45, variant: 'a', total: 298 });
  assert.strictEqual(parsePrintedCode('pas de code'), null);
});

test('retrouve la carte et ses variantes', () => {
  const cards = [{ code: 'unl-121-219' }, { code: 'unl-121a-219' }, { code: 'ogn-121-298' }];
  assert.deepStrictEqual(findByCode(cards, { set: 'UNL', number: 121, variant: '', total: 219 }).map((c) => c.code), ['unl-121-219', 'unl-121a-219']);
  // Set mal lu par l'OCR : repli sur numéro + total
  assert.deepStrictEqual(findByCode(cards, { set: 'UML', number: 121, variant: '', total: 298 }).map((c) => c.code), ['ogn-121-298']);
});
