const fs = require('node:fs');
const path = require('node:path');
const { REPORTS_DIR } = require('./config');
const { priceOf } = require('./prices');
const { buildDecks } = require('./decks');

const usd = (v) => (v == null ? '—' : `$${v.toFixed(2)}`);
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|');

function table(headers, rows) {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
  ].join('\n');
}

function priceHeader(prices) {
  return `Prix : TCGplayer market price (USD), source tcgcsv.com mise à jour le ${prices.sourceUpdatedAt || 'inconnu'}.`;
}

function inventoryMarkdown(cards, inventory, prices) {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const rows = [];
  let total = 0;
  let count = 0;
  for (const [id, finishes] of Object.entries(inventory)) {
    const card = byId.get(id);
    if (!card) continue;
    for (const [finish, qty] of Object.entries(finishes)) {
      const unit = priceOf(card, prices, finish);
      const value = unit == null ? null : unit * qty;
      total += value || 0;
      count += qty;
      rows.push([card.name, card.set, card.code, finish, qty, usd(unit), usd(value)]);
    }
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  return [
    '# Inventaire',
    '',
    priceHeader(prices),
    '',
    `- Cartes : **${count}**`,
    `- Valeur estimée : **${usd(total)}**`,
    '',
    table(['Carte', 'Set', 'Code', 'Finition', 'Qté', 'Prix unitaire', 'Valeur'], rows),
    '',
  ].join('\n');
}

function pricesMarkdown(cards, prices) {
  const rows = cards
    .filter((c) => c.supertype !== 'Token')
    .map((c) => [c.name, c.set, c.code, c.rarity, usd(priceOf(c, prices, 'normal')), usd(priceOf(c, prices, 'foil'))])
    .sort((a, b) => a[1].localeCompare(b[1]) || a[2].localeCompare(b[2]));
  return ['# Prix des cartes', '', priceHeader(prices), '', table(['Carte', 'Set', 'Code', 'Rareté', 'Normal', 'Foil'], rows), ''].join('\n');
}

function decksMarkdown(cards, inventory, prices) {
  const decks = buildDecks(cards, inventory, prices);
  const out = ['# Decks', '', priceHeader(prices), ''];
  if (!decks.length) out.push('Aucune Legend dans l\'inventaire : impossible de construire un deck.', '');
  for (const d of decks) {
    out.push(
      `## ${d.legend.name} (${d.legend.domains.join(' / ')})`,
      '',
      `- Statut : **${d.complete ? 'complet' : 'incomplet'}**`,
      `- Chosen Champion : ${d.champion || 'manquant'}`,
      `- Main deck : ${d.counts.main}/40 — Runes : ${d.counts.runes}/12 — Battlefields : ${d.counts.battlefields}/3`,
      '',
      '### Main deck',
      '',
      table(['Qté', 'Carte'], d.main.map((m) => [m.qty, m.name])),
      '',
      '### Runes',
      '',
      table(['Qté', 'Rune'], d.runes.map((r) => [r.qty, r.name])),
      '',
      '### Battlefields',
      '',
      ...(d.battlefields.length ? d.battlefields.map((b) => `- ${b}`) : ['- aucun']),
      '',
    );
    if (d.toBuy.length) {
      out.push(
        '### Cartes à acheter pour compléter',
        '',
        table(['Qté', 'Carte', 'Code', 'Prix unitaire'], d.toBuy.map((b) => [b.qty, b.name, b.code, usd(b.unitPrice)])),
        '',
        `Coût total estimé : **${usd(d.toBuyTotal)}**`,
        '',
      );
    }
  }
  return out.join('\n');
}

function writeReports(cards, inventory, prices) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const files = {
    'inventaire.md': inventoryMarkdown(cards, inventory, prices),
    'prix.md': pricesMarkdown(cards, prices),
    'decks.md': decksMarkdown(cards, inventory, prices),
  };
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(REPORTS_DIR, name), content);
  }
  return Object.keys(files);
}

module.exports = { writeReports, inventoryMarkdown, pricesMarkdown, decksMarkdown };
