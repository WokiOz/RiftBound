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

// ---------- Scanner (photo entière -> cadre de recadrage -> OCR sur le cadre) ----------
// Le code imprimé occupe une toute petite partie de la carte : plutôt que de
// demander un zoom téléphone extrême (flou, mise au point ratée), on prend la
// carte entière puis on isole/agrandit numériquement la zone du code avant l'OCR.
const cropTool = $('#crop-tool');
const cropStage = $('#crop-stage');
const cropCanvas = $('#crop-canvas');
const cropBox = $('#crop-box');
let cropBitmap = null; // photo source, pleine résolution

$('#scan-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    cropBitmap = await createImageBitmap(file);
    // Rendre la section visible avant de mesurer sa largeur : un parent masqué
    // (hidden) rapporte clientWidth = 0, ce qui faussait le calcul du canvas.
    cropTool.hidden = false;
    $('#scan-result').innerHTML = '';
    drawCropStage();
    resetCropBox();
  } catch (err) {
    $('#scan-result').innerHTML = `<p>Erreur : ${esc(err.message)}</p>`;
  } finally {
    e.target.value = '';
  }
});

// Affiche la photo à une taille raisonnable pour l'écran (l'OCR se fera sur la
// source pleine résolution, pas sur cet aperçu)
function drawCropStage() {
  // Calculé depuis window.innerWidth plutôt que via clientWidth d'un parent :
  // un canvas plus large que l'écran élargit la page elle-même (main/#crop-tool
  // n'ont pas de largeur fixe), ce qui fausserait une mesure par clientWidth.
  const maxW = Math.min(window.innerWidth - 32, 600);
  const scale = Math.min(1, maxW / cropBitmap.width);
  cropCanvas.width = Math.round(cropBitmap.width * scale);
  cropCanvas.height = Math.round(cropBitmap.height * scale);
  cropCanvas.getContext('2d').drawImage(cropBitmap, 0, 0, cropCanvas.width, cropCanvas.height);
}

// Cadre par défaut : bande en bas à gauche, où se trouve le code sur une carte
// Riftbound cadrée normalement. L'utilisateur l'ajuste ensuite si besoin.
function resetCropBox() {
  const w = cropCanvas.width * 0.4;
  const h = cropCanvas.height * 0.09;
  setCropBoxRect(cropCanvas.width * 0.04, cropCanvas.height * 0.88, w, h);
}

function setCropBoxRect(x, y, w, h) {
  w = Math.max(24, Math.min(w, cropCanvas.width - x));
  h = Math.max(16, Math.min(h, cropCanvas.height - y));
  x = Math.max(0, Math.min(x, cropCanvas.width - w));
  y = Math.max(0, Math.min(y, cropCanvas.height - h));
  Object.assign(cropBox.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
}

function cropBoxRect() {
  return {
    x: parseFloat(cropBox.style.left), y: parseFloat(cropBox.style.top),
    w: parseFloat(cropBox.style.width), h: parseFloat(cropBox.style.height),
  };
}

// Glisser-déposer (déplacer) et redimensionner (coin) du cadre, souris et tactile
function dragToMove(e) {
  e.preventDefault();
  const start = cropBoxRect();
  const p0 = { x: e.clientX, y: e.clientY };
  const onMove = (ev) => setCropBoxRect(start.x + (ev.clientX - p0.x), start.y + (ev.clientY - p0.y), start.w, start.h);
  const onUp = () => document.removeEventListener('pointermove', onMove);
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp, { once: true });
}
cropBox.addEventListener('pointerdown', dragToMove);

$('#crop-handle').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  e.stopPropagation();
  const start = cropBoxRect();
  const p0 = { x: e.clientX, y: e.clientY };
  const onMove = (ev) => setCropBoxRect(start.x, start.y, start.w + (ev.clientX - p0.x), start.h + (ev.clientY - p0.y));
  const onUp = () => document.removeEventListener('pointermove', onMove);
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp, { once: true });
});

$('#crop-cancel-btn').addEventListener('click', () => {
  cropTool.hidden = true;
  cropBitmap = null;
});

$('#crop-scan-btn').addEventListener('click', async () => {
  const out = $('#scan-result');
  out.innerHTML = '<p>Lecture du code…</p>';
  try {
    const { data } = await Tesseract.recognize(extractCrop(), 'eng');
    const r = await api('/api/scan', { method: 'POST', body: { text: data.text } });
    if (!r.code) {
      out.innerHTML = '<p>Code non détecté. Ajustez le cadre bien sur le texte (ex. « UNL • 121/219 »), ou utilisez la recherche manuelle.</p>';
    } else if (!r.cards.length) {
      out.innerHTML = `<p>Code lu : ${esc(r.code.set)} ${r.code.number}/${r.code.total}, aucune carte correspondante.</p>`;
    } else {
      out.innerHTML = `<p>Code lu : ${esc(r.code.set)} ${r.code.number}/${r.code.total}</p>${r.cards.map(cardRow).join('')}`;
    }
  } catch (err) {
    out.innerHTML = `<p>Erreur : ${esc(err.message)}</p>`;
  }
});

// Découpe la zone choisie dans la photo source (pleine résolution) et l'agrandit
// pour donner à l'OCR un texte net et grand, sans avoir eu besoin de zoomer au tir
function extractCrop() {
  const scale = cropBitmap.width / cropCanvas.width;
  const r = cropBoxRect();
  const sx = r.x * scale, sy = r.y * scale, sw = r.w * scale, sh = r.h * scale;
  const targetW = Math.max(900, Math.round(sw * 3));
  const targetH = Math.round((targetW / sw) * sh);
  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cropBitmap, sx, sy, sw, sh, 0, 0, targetW, targetH);
  return canvas;
}

window.addEventListener('resize', () => {
  if (!cropBitmap) return;
  const prev = cropBoxRect();
  const ratio = { x: prev.x / cropCanvas.width, y: prev.y / cropCanvas.height, w: prev.w / cropCanvas.width, h: prev.h / cropCanvas.height };
  drawCropStage();
  setCropBoxRect(ratio.x * cropCanvas.width, ratio.y * cropCanvas.height, ratio.w * cropCanvas.width, ratio.h * cropCanvas.height);
});

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
