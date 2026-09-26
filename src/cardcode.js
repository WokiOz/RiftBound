// Code imprimé en bas à gauche des cartes, ex. « UNL • 121/219 ».
// L'id Riftcodex correspondant est « unl-121-219 » (variantes : « 121a », « 121* »).
const PRINTED_RE = /\b([A-Za-z]{2,3})\W{0,4}(\d{1,3})([a-z*]?)\s*\/\s*(\d{2,3})\b/;
const ID_RE = /^([a-z]+)-(\d+)([a-z*]?)-(\d+)$/;

function parsePrintedCode(text) {
  const m = PRINTED_RE.exec(text);
  if (!m) return null;
  return { set: m[1].toUpperCase(), number: Number(m[2]), variant: m[3], total: Number(m[4]) };
}

function parseCardId(code) {
  const m = ID_RE.exec(code);
  if (!m) return null;
  return { set: m[1].toUpperCase(), number: Number(m[2]), variant: m[3], total: Number(m[4]) };
}

// Cartes correspondant au code lu. Si le set est mal lu par l'OCR,
// on retombe sur numéro + total imprimé.
function findByCode(cards, code) {
  const withId = cards.map((card) => ({ card, id: parseCardId(card.code) })).filter((x) => x.id);
  let hits = withId.filter((x) => x.id.set === code.set && x.id.number === code.number);
  if (!hits.length) hits = withId.filter((x) => x.id.number === code.number && x.id.total === code.total);
  return hits
    .sort((a, b) => Number(b.id.variant === code.variant) - Number(a.id.variant === code.variant))
    .map((x) => x.card);
}

module.exports = { parsePrintedCode, findByCode };
