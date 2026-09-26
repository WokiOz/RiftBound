// Prix "market" TCGplayer d'une carte pour une finition donnée, ou null si inconnu
function priceOf(card, prices, finish = 'normal') {
  if (!card.tcgplayerId) return null;
  const entry = prices.byProduct[card.tcgplayerId];
  return entry?.[finish]?.market ?? null;
}

// Prix le plus bas connu toutes finitions confondues (pour les suggestions d'achat)
function cheapestPrice(card, prices) {
  const values = ['normal', 'foil'].map((f) => priceOf(card, prices, f)).filter((v) => v != null);
  return values.length ? Math.min(...values) : null;
}

module.exports = { priceOf, cheapestPrice };
