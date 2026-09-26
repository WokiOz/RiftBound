const { RIFTCODEX_API, TCGCSV_API, TCGPLAYER_CATEGORY_ID, USER_AGENT } = require('./config');

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} sur ${url}`);
  return res.json();
}

function normalizeCard(c) {
  return {
    id: c.id, // identifiant Riftcodex unique (riftbound_id a des doublons, ex. versions « Metal »)
    code: c.riftbound_id, // code imprimé, ex. « unl-121-219 »
    name: c.name,
    // Nom sans suffixe de variante, ex. "(Alternate Art)" : sert à la limite de 3 exemplaires
    baseName: c.name.replace(/\s*\([^)]*\)\s*$/, ''),
    set: c.set.set_id,
    setName: c.set.label,
    number: c.collector_number,
    type: c.classification.type,
    supertype: c.classification.supertype,
    rarity: c.classification.rarity,
    domains: c.classification.domain || [],
    energy: c.attributes.energy,
    might: c.attributes.might,
    power: c.attributes.power,
    tags: c.tags || [],
    text: c.text.plain,
    image: c.media.image_url,
    tcgplayerId: c.tcgplayer_id ? Number(c.tcgplayer_id) : null,
  };
}

async function fetchCards() {
  const cards = [];
  let page = 1;
  let pages = 1;
  do {
    const data = await getJson(`${RIFTCODEX_API}/cards?size=100&page=${page}`);
    cards.push(...data.items.map(normalizeCard));
    pages = data.pages;
    page += 1;
  } while (page <= pages);
  return cards;
}

async function fetchPrices() {
  const base = `${TCGCSV_API}/${TCGPLAYER_CATEGORY_ID}`;
  const groups = (await getJson(`${base}/groups`)).results;
  const byProduct = {};
  for (const group of groups) {
    const { results } = await getJson(`${base}/${group.groupId}/prices`);
    for (const p of results) {
      const finish = p.subTypeName === 'Foil' ? 'foil' : 'normal';
      byProduct[p.productId] ??= {};
      byProduct[p.productId][finish] = {
        market: p.marketPrice,
        low: p.lowPrice,
        mid: p.midPrice,
        high: p.highPrice,
      };
    }
  }
  const res = await fetch('https://tcgcsv.com/last-updated.txt', { headers: { 'User-Agent': USER_AGENT } });
  const sourceUpdatedAt = res.ok ? (await res.text()).trim() : null;
  return { updatedAt: new Date().toISOString(), sourceUpdatedAt, currency: 'USD', byProduct };
}

module.exports = { fetchCards, fetchPrices, normalizeCard };
