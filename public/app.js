const $ = (sel) => document.querySelector(sel);
const usd = (v) => (v == null ? '—' : v.toLocaleString('fr-FR', { style: 'currency', currency: 'USD' }));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function api(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------- Onglets ----------
const loaders = { inventory: loadInventory, decks: loadDecks, catalog: loadCatalog };
document.querySelectorAll('nav button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav button, .tab').forEach((el) => el.classList.remove('active'));
    btn.classList.add('active');
    $(`#${btn.dataset.tab}`).classList.add('active');
    loaders[btn.dataset.tab]?.();
  });
});

// ---------- Statut & synchronisation ----------
async function loadStatus() {
  const s = await api('/api/status');
  $('#status').textContent = s.cards
    ? `${s.cards} cartes — prix TCGplayer du ${s.pricesSourceUpdatedAt || '?'}`
    : 'Catalogue vide : lancez une synchronisation.';
  fillSelect('#catalog-set', s.sets);
  fillSelect('#catalog-type', s.types);
}

function fillSelect(sel, values = []) {
  const select = $(sel);
  select.length = 1;
  for (const v of values) select.add(new Option(v, v));
}

$('#sync-btn').addEventListener('click', async () => {
  const btn = $('#sync-btn');
  btn.disabled = true;
  btn.textContent = 'Synchronisation…';
  try {
    const r = await api('/api/sync', { method: 'POST' });
    alert(`${r.cards} cartes, ${r.prices} prix. Publication Git : ${r.published}`);
    await loadStatus();
  } catch (err) {
    alert(`Échec : ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Synchroniser catalogue et prix';
  }
});

// ---------- Affichage d'une carte avec boutons d'ajout ----------
function cardRow(card) {
  return `
    <div class="card-row">
      <img src="${esc(card.image)}" alt="" loading="lazy">
      <div class="info">
        <strong>${esc(card.name)}</strong>
        <div class="muted">${esc(card.code)} · ${esc(card.type)} · ${esc(card.rarity)} · ${esc(card.domains.join('/'))}</div>
        <div>Normal ${usd(card.price.normal)} · Foil ${usd(card.price.foil)}</div>
      </div>
      <div class="actions">
        <button data-add="${esc(card.id)}" data-finish="normal">+ Normal</button>
        <button data-add="${esc(card.id)}" data-finish="foil">+ Foil</button>
      </div>
    </div>`;
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-add]');
  if (!btn) return;
  const delta = Number(btn.dataset.delta || 1);
  const r = await api('/api/inventory', {
    method: 'POST',
    body: { id: btn.dataset.add, finish: btn.dataset.finish, delta },
  });
  if (btn.dataset.delta) loadInventory();
  else btn.textContent = `✓ ${r.finish} (${r.qty})`;
});

// ---------- Scanner (OCR du code imprimé, dans le navigateur) ----------
$('#scan-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const out = $('#scan-result');
  out.innerHTML = '<p>Lecture de la carte…</p>';
  try {
    const { data } = await Tesseract.recognize(await downscale(file), 'eng');
    const r = await api('/api/scan', { method: 'POST', body: { text: data.text } });
    if (!r.code) {
      out.innerHTML = '<p>Code non détecté. Reprenez la photo plus près du bas de la carte, ou utilisez la recherche manuelle.</p>';
    } else if (!r.cards.length) {
      out.innerHTML = `<p>Code lu : ${esc(r.code.set)} ${r.code.number}/${r.code.total}, aucune carte correspondante.</p>`;
    } else {
      out.innerHTML = `<p>Code lu : ${esc(r.code.set)} ${r.code.number}/${r.code.total}</p>${r.cards.map(cardRow).join('')}`;
    }
  } catch (err) {
    out.innerHTML = `<p>Erreur : ${esc(err.message)}</p>`;
  } finally {
    e.target.value = '';
  }
});

// Réduit la photo (2000 px max) pour accélérer l'OCR sur téléphone
async function downscale(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function debounce(fn, ms = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

$('#manual-search').addEventListener('input', debounce(async (e) => {
  const q = e.target.value.trim();
  if (q.length < 2) return ($('#manual-result').innerHTML = '');
  const cards = await api(`/api/cards?q=${encodeURIComponent(q)}`);
  $('#manual-result').innerHTML = cards.slice(0, 30).map(cardRow).join('') || '<p>Aucun résultat.</p>';
}));

// ---------- Inventaire ----------
async function loadInventory() {
  const inv = await api('/api/inventory');
  const count = inv.items.reduce((a, i) => a + i.qty, 0);
  $('#inventory-summary').innerHTML = `<p><strong>${count}</strong> cartes — valeur estimée <strong>${usd(inv.value)}</strong></p>`;
  $('#inventory-list').innerHTML = inv.items.map((i) => `
    <div class="card-row">
      <img src="${esc(i.card.image)}" alt="" loading="lazy">
      <div class="info">
        <strong>${esc(i.card.name)}</strong>
        <div class="muted">${esc(i.card.code)} · ${esc(i.finish)}</div>
        <div>${i.qty} × ${usd(i.unitPrice)}</div>
      </div>
      <div class="actions">
        <button data-add="${esc(i.card.id)}" data-finish="${i.finish}" data-delta="1">+</button>
        <button data-add="${esc(i.card.id)}" data-finish="${i.finish}" data-delta="-1">−</button>
      </div>
    </div>`).join('') || '<p>Inventaire vide.</p>';
}

// ---------- Decks ----------
async function loadDecks() {
  const decks = await api('/api/decks');
  $('#decks-list').innerHTML = decks.map((d) => `
    <article class="deck">
      <h2>${esc(d.legend.name)} <span class="muted">${esc(d.legend.domains.join(' / '))}</span></h2>
      <p class="${d.complete ? 'ok' : 'ko'}">${d.complete ? 'Deck complet' : 'Deck incomplet'}
        — Main ${d.counts.main}/40 · Runes ${d.counts.runes}/12 · Battlefields ${d.counts.battlefields}/3</p>
      <p>Chosen Champion : ${esc(d.champion || 'manquant')}</p>
      <details><summary>Main deck</summary><ul>${d.main.map((m) => `<li>${m.qty} × ${esc(m.name)}</li>`).join('')}</ul></details>
      <details><summary>Runes & Battlefields</summary><ul>
        ${d.runes.map((r) => `<li>${r.qty} × ${esc(r.name)}</li>`).join('')}
        ${d.battlefields.map((b) => `<li>${esc(b)}</li>`).join('')}
      </ul></details>
      ${d.toBuy.length ? `
        <h3>À acheter (${usd(d.toBuyTotal)})</h3>
        <ul>${d.toBuy.map((b) => `<li>${b.qty} × ${esc(b.name)} <span class="muted">${esc(b.code)}</span> — ${usd(b.unitPrice)}</li>`).join('')}</ul>` : ''}
    </article>`).join('') || '<p>Ajoutez au moins une Legend à l\'inventaire pour générer un deck.</p>';
}

// ---------- Catalogue ----------
async function loadCatalog() {
  const params = new URLSearchParams({
    q: $('#catalog-search').value.trim(),
    set: $('#catalog-set').value,
    type: $('#catalog-type').value,
  });
  const cards = await api(`/api/cards?${params}`);
  $('#catalog-list').innerHTML = cards.map(cardRow).join('') || '<p>Aucun résultat.</p>';
}
$('#catalog-search').addEventListener('input', debounce(loadCatalog));
$('#catalog-set').addEventListener('change', loadCatalog);
$('#catalog-type').addEventListener('change', loadCatalog);

loadStatus();
