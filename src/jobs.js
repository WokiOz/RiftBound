const store = require('./store');
const { fetchCards, fetchPrices } = require('./sync');
const { writeReports } = require('./markdown');
const { publishReports } = require('./publish');

// Synchronisation complète : catalogue + prix -> rapports Markdown -> push Git
async function runSync(log = console.log) {
  const cards = await fetchCards();
  store.saveCards(cards);
  log(`Catalogue : ${cards.length} cartes`);

  const prices = await fetchPrices();
  store.savePrices(prices);
  log(`Prix : ${Object.keys(prices.byProduct).length} produits (source ${prices.sourceUpdatedAt})`);

  const files = writeReports(cards, store.loadInventory(), prices);
  log(`Rapports : ${files.join(', ')}`);

  const published = await publishReports();
  log(`Publication Git : ${published}`);
  return { cards: cards.length, prices: Object.keys(prices.byProduct).length, published };
}

module.exports = { runSync };
