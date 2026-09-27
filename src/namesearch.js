// Identification d'une carte par son nom (gros texte, plus facile à lire par
// l'OCR qu'un petit code imprimé). Volontairement prudent : ne renvoie un
// résultat "confident" que si le nom ne peut désigner qu'une seule carte,
// pour ne jamais ajouter silencieusement la mauvaise impression/le mauvais
// set à l'inventaire (beaucoup de noms sont réimprimés d'un set à l'autre).
const MIN_SIMILARITY = 0.82;
const MIN_MARGIN = 0.08; // écart minimum avec le 2e meilleur candidat

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // accents
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const row = [i];
    for (let j = 1; j <= n; j++) {
      row[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], row[j - 1]);
    }
    prev = row;
  }
  return prev[n];
}

function similarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (!maxLen) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

// Une carte "utilisable" pour le scan (pas un jeton de partie)
const isScannable = (c) => c.supertype !== 'Token';

function matchByName(cards, ocrText) {
  const query = normalize(ocrText);
  if (query.length < 3) return null;

  // Regroupe par nom de base : détecte les noms réimprimés dans plusieurs sets
  const groups = new Map();
  for (const card of cards) {
    if (!isScannable(card)) continue;
    const key = normalize(card.baseName);
    const g = groups.get(key) || { key, sets: new Set(), cards: [] };
    g.sets.add(card.set);
    g.cards.push(card);
    groups.set(key, g);
  }

  const scored = [...groups.values()]
    .map((g) => ({ g, score: similarity(query, g.key) }))
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return null;
  const [best, second] = scored;
  if (best.score < MIN_SIMILARITY) return null;
  if (second && best.score - second.score < MIN_MARGIN) return null; // ambigu
  if (best.g.sets.size > 1) return null; // même nom dans plusieurs sets : imprécis

  // Dans le groupe, préfère l'impression "normale" (sans suffixe de variante)
  const plain = best.g.cards.find((c) => c.name === c.baseName);
  return plain || best.g.cards[0];
}

module.exports = { matchByName, normalize, similarity };
