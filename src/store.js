const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('./config');

function filePath(name) {
  return path.join(DATA_DIR, name);
}

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath(name), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

// Écriture atomique : fichier temporaire puis renommage
function writeJson(name, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const target = filePath(name);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, target);
}

module.exports = {
  loadCards: () => readJson('cards.json', []),
  saveCards: (cards) => writeJson('cards.json', cards),
  loadPrices: () => readJson('prices.json', { updatedAt: null, currency: 'USD', byProduct: {} }),
  savePrices: (prices) => writeJson('prices.json', prices),
  // Format : { "<id carte>": { "normal": 2, "foil": 1 } }
  loadInventory: () => readJson('inventory.json', {}),
  saveInventory: (inventory) => writeJson('inventory.json', inventory),
};
