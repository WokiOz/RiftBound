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

  if (!btn.dataset.delta && btn.closest('#scan-result-cards')) recordScanAdd(btn.dataset.add, r.finish);
});

// ---------- Scanner (photo entière -> cadre de recadrage -> OCR sur le cadre) ----------
// Le code imprimé occupe une toute petite partie de la carte : plutôt que de
// demander un zoom téléphone extrême (flou, mise au point ratée), on prend la
// carte entière puis on isole/agrandit numériquement la zone du code avant l'OCR.
// Une "queue" de 1 (bouton "Prendre une photo") ou plusieurs photos (bouton
// "Scanner plusieurs cartes") est traitée carte par carte, avec une petite
// session qui s'accumule et un passage automatique à la carte suivante dès
// qu'on appuie sur + Normal ou + Foil (une carte physique n'a qu'une finition).
const cropTool = $('#crop-tool');
const cropStage = $('#crop-stage');
const cropCanvas = $('#crop-canvas');
const cropBox = $('#crop-box');
let cropBitmap = null; // photo en cours, pleine résolution
let scanQueue = [];
let scanIndex = 0;
let scanSession = []; // { id, name, finish, qty } ajoutés pendant cette session
let lastScanCards = []; // cartes du dernier code lu, pour retrouver leur nom lors de l'ajout

$('#scan-input').addEventListener('change', (e) => startScanQueue([...e.target.files]));
$('#scan-multi-input').addEventListener('change', (e) => startScanQueue([...e.target.files]));

function startScanQueue(files) {
  if (!files.length) return;
  scanQueue = files;
  scanIndex = 0;
  scanSession = [];
  renderScanSession();
  loadScanQueueItem();
  $('#scan-input').value = '';
  $('#scan-multi-input').value = '';
}

async function loadScanQueueItem() {
  if (scanIndex >= scanQueue.length) {
    cropTool.hidden = true;
    cropBitmap = null;
    $('#scan-result').innerHTML = scanQueue.length > 1
      ? `<p class="ok">Session terminée : ${scanSession.reduce((a, s) => a + s.qty, 0)} exemplaire(s) ajouté(s).</p>`
      : '';
    scanQueue = [];
    return;
  }
  const multi = scanQueue.length > 1;
  $('#crop-progress').hidden = !multi;
  if (multi) {
    $('#crop-progress-label').textContent = `Carte ${scanIndex + 1} sur ${scanQueue.length}`;
    $('#crop-dots').innerHTML = scanQueue
      .map((_, i) => `<span class="${i < scanIndex ? 'done' : i === scanIndex ? 'now' : ''}"></span>`)
      .join('');
  }
  $('#crop-skip-btn').hidden = !multi;
  await processCapturedImage(scanQueue[scanIndex]);
}

// Traitement commun à une image capturée, quelle que soit sa provenance
// (fichier choisi, ou frame gelée de la caméra en direct) : tentative
// automatique par le nom, puis repli sur le cadrage manuel du code.
async function processCapturedImage(source) {
  cropTool.hidden = true;
  $('#scan-result').innerHTML = '<p class="muted">Reconnaissance…</p>';
  try {
    cropBitmap = await createImageBitmap(source);
    drawCropStage(); // fonctionne même cropTool masqué (ne dépend pas de sa visibilité)

    const card = await tryNameMatch();
    if (card) {
      lastScanCards = [card];
      $('#scan-result').innerHTML = `<p class="ok">Reconnue par le nom.</p><div id="scan-result-cards">${cardRow(card)}</div>`;
      return true;
    }

    // Repli : cadrage manuel sur le code, comme avant
    cropTool.hidden = false;
    resetCropBox();
    $('#scan-result').innerHTML = '';
    return false;
  } catch (err) {
    $('#scan-result').innerHTML = `<p>Erreur : ${esc(err.message)}</p>`;
    return false;
  }
}

$('#crop-skip-btn').addEventListener('click', () => {
  scanIndex += 1;
  loadScanQueueItem();
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
// Riftbound cadrée normalement (mesuré sur une image de référence : le texte
// occupe environ 95,5 % à 99 % de la hauteur). L'utilisateur l'ajuste ensuite.
function resetCropBox() {
  const w = cropCanvas.width * 0.4;
  const h = cropCanvas.height * 0.05;
  setCropBoxRect(cropCanvas.width * 0.03, cropCanvas.height * 0.945, w, h);
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
  scanQueue = [];
  if (liveCameraActive) armCameraWatch();
});

$('#crop-scan-btn').addEventListener('click', async () => {
  const out = $('#scan-result');
  out.innerHTML = '<p>Lecture du code…</p>';
  try {
    const { data } = await Tesseract.recognize(extractCrop(), 'eng');
    const r = await api('/api/scan', { method: 'POST', body: { text: data.text } });
    lastScanCards = r.cards || [];
    if (!r.code) {
      out.innerHTML = '<p>Code non détecté. Ajustez le cadre bien sur le texte (ex. « UNL • 121/219 »), ou utilisez la recherche manuelle.</p>';
    } else if (!r.cards.length) {
      out.innerHTML = `<p>Code lu : ${esc(r.code.set)} ${r.code.number}/${r.code.total}, aucune carte correspondante.</p>`;
    } else {
      out.innerHTML = `<div id="scan-result-cards">${r.cards.map(cardRow).join('')}</div>`;
    }
  } catch (err) {
    out.innerHTML = `<p>Erreur : ${esc(err.message)}</p>`;
  }
});

// Ajout depuis le résultat d'un scan : garde une trace dans la session en
// cours et enchaîne automatiquement sur la carte suivante de la queue.
function recordScanAdd(id, finish) {
  const card = lastScanCards.find((c) => c.id === id);
  if (!card) return;
  const existing = scanSession.find((s) => s.id === id && s.finish === finish);
  if (existing) existing.qty += 1;
  else scanSession.push({ id, name: card.name, finish, qty: 1 });
  renderScanSession();
  if (liveCameraActive) {
    setTimeout(armCameraWatch, 400);
  } else {
    scanIndex += 1;
    setTimeout(loadScanQueueItem, 400);
  }
}

function renderScanSession() {
  const panel = $('#scan-session');
  panel.hidden = scanSession.length === 0;
  $('#scan-session-list').innerHTML = scanSession
    .map((s) => `<div class="row"><span>${esc(s.name)} · ${esc(s.finish)}</span><span>${s.qty}×</span></div>`)
    .join('');
}

// Découpe la zone choisie dans la photo source (pleine résolution) et l'agrandit
// pour donner à l'OCR un texte net et grand, sans avoir eu besoin de zoomer au tir
function extractRegion(r) {
  const scale = cropBitmap.width / cropCanvas.width;
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

function extractCrop() {
  return extractRegion(cropBoxRect());
}

// Tentative automatique, sans intervention : le nom de la carte (gros texte,
// juste sous l'illustration) est bien plus facile à lire par l'OCR que le
// petit code. Ne renvoie une carte que si le serveur est sûr qu'un seul nom
// du catalogue correspond (voir src/namesearch.js) ; sinon on se rabat sur
// le cadrage manuel du code, inchangé.
async function tryNameMatch() {
  const nameRegion = {
    x: cropCanvas.width * 0.06, y: cropCanvas.height * 0.545,
    w: cropCanvas.width * 0.72, h: cropCanvas.height * 0.085,
  };
  try {
    const { data } = await Tesseract.recognize(extractRegion(nameRegion), 'eng');
    const r = await api('/api/scan-name', { method: 'POST', body: { text: data.text } });
    return r.confident ? r.card : null;
  } catch {
    return null; // on se rabat silencieusement sur le cadrage manuel
  }
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

// ---------- Caméra en direct ----------
// Un gabarit à l'écran où aligner la carte, plutôt qu'un aller-retour vers
// l'appli photo du téléphone : le cadrage devient cohérent à chaque scan,
// ce qui rend la reconnaissance automatique par le nom bien plus fiable.
// "Aligné" est une heuristique simple (image stable, pas juste du vide dans
// le gabarit) et non une vraie détection de contours : en cas de capture un
// peu prématurée, la reconnaissance échoue simplement et on retente — sans
// risque d'ajouter la mauvaise carte (le filtre du nom reste strict).
let liveCameraActive = false;
let cameraStream = null;
let cameraWatchId = null;
let cameraPrevSample = null;
let cameraStableSince = null;
const CAMERA_STABLE_MS = 550;

const cameraVideo = $('#camera-video');
const cameraGuide = $('#camera-guide');
const cameraRing = $('#camera-ring-fill');
const RING_CIRCUMFERENCE = 88;

$('#btn-open-camera').addEventListener('click', openCamera);
$('#btn-close-camera').addEventListener('click', closeCamera);

// Repli pour d'anciens navigateurs qui n'exposent pas encore
// navigator.mediaDevices.getUserMedia (norme standard depuis 2017) mais une
// variante préfixée. Sans ce repli, y accéder directement lève une TypeError
// ("undefined is not an object") plutôt qu'un message compréhensible.
function getCameraStream(constraints) {
  if (navigator.mediaDevices?.getUserMedia) {
    return navigator.mediaDevices.getUserMedia(constraints);
  }
  const legacy = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia;
  if (legacy) return new Promise((resolve, reject) => legacy.call(navigator, constraints, resolve, reject));
  return Promise.reject(new Error(
    "Ce navigateur ne permet pas l'accès à la caméra depuis un site web. " +
    'Réessayez avec une version récente de Chrome ou Safari, sur https:// (obligatoire).',
  ));
}

async function openCamera() {
  try {
    cameraStream = await getCameraStream({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 1280 } },
      audio: false,
    });
  } catch (err) {
    alert(`Caméra indisponible : ${err.message}`);
    return;
  }
  cameraVideo.srcObject = cameraStream;
  await cameraVideo.play();
  liveCameraActive = true;
  $('#live-camera').hidden = false;
  $('#btn-open-camera').hidden = true;
  armCameraWatch();
}

function closeCamera() {
  liveCameraActive = false;
  if (cameraWatchId) cancelAnimationFrame(cameraWatchId);
  cameraWatchId = null;
  if (cameraStream) cameraStream.getTracks().forEach((t) => t.stop());
  cameraStream = null;
  $('#live-camera').hidden = true;
  $('#btn-open-camera').hidden = false;
  cropTool.hidden = true;
  $('#scan-result').innerHTML = '';
}

// (Re)démarre la surveillance du gabarit, prête pour la carte suivante.
function armCameraWatch() {
  if (!liveCameraActive) return;
  cropTool.hidden = true;
  $('#scan-result').innerHTML = '';
  cameraGuide.classList.remove('aligned');
  cameraRing.style.strokeDashoffset = String(RING_CIRCUMFERENCE);
  $('#camera-hint').textContent = 'Placez la carte dans le cadre';
  cameraPrevSample = null;
  cameraStableSince = null;
  cameraWatchId = requestAnimationFrame(watchCameraFrame);
}

// Échantillonne le gabarit en petite résolution (16×22) pour détecter une
// image stable (main immobile) contenant quelque chose (pas juste le fond).
// Position du gabarit dans le flux vidéo, en fraction de sa résolution :
// mêmes proportions que le cadre affiché à l'écran (#camera-guide en CSS).
function guideRect() {
  const vw = cameraVideo.videoWidth, vh = cameraVideo.videoHeight;
  const w = vw * 0.64;
  return { x: vw * 0.18, y: vh * 0.12, w, h: w / 0.716 };
}

function sampleGuideRegion() {
  if (!cameraVideo.videoWidth) return null;
  const guide = guideRect();
  const canvas = sampleGuideRegion.canvas || (sampleGuideRegion.canvas = document.createElement('canvas'));
  canvas.width = 16;
  canvas.height = 22;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(cameraVideo, guide.x, guide.y, guide.w, guide.h, 0, 0, 16, 22);
  return ctx.getImageData(0, 0, 16, 22).data;
}

function watchCameraFrame() {
  if (!liveCameraActive) return;
  const sample = sampleGuideRegion();
  if (!sample) {
    cameraWatchId = requestAnimationFrame(watchCameraFrame);
    return;
  }
  let variance = 0, diff = 0, mean = 0;
  for (let i = 0; i < sample.length; i += 4) mean += sample[i];
  mean /= sample.length / 4;
  for (let i = 0; i < sample.length; i += 4) variance += (sample[i] - mean) ** 2;
  variance /= sample.length / 4;
  if (cameraPrevSample) {
    for (let i = 0; i < sample.length; i += 4) diff += Math.abs(sample[i] - cameraPrevSample[i]);
    diff /= sample.length / 4;
  }
  cameraPrevSample = sample;

  const hasContent = variance > 120; // pas juste une surface unie (table vide)
  const isStable = diff < 6;
  const now = performance.now();

  if (hasContent && isStable) {
    if (!cameraStableSince) cameraStableSince = now;
    const elapsed = now - cameraStableSince;
    cameraGuide.classList.add('aligned');
    cameraRing.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - Math.min(1, elapsed / CAMERA_STABLE_MS)));
    if (elapsed >= CAMERA_STABLE_MS) {
      captureFromCamera();
      return; // la surveillance reprendra via armCameraWatch()
    }
  } else {
    cameraStableSince = null;
    cameraGuide.classList.remove('aligned');
    cameraRing.style.strokeDashoffset = String(RING_CIRCUMFERENCE);
    $('#camera-hint').textContent = hasContent ? 'Ne bougez plus…' : 'Placez la carte dans le cadre';
  }
  cameraWatchId = requestAnimationFrame(watchCameraFrame);
}

async function captureFromCamera() {
  if (cameraWatchId) cancelAnimationFrame(cameraWatchId);
  cameraWatchId = null;
  $('#camera-flash').classList.add('go');
  $('#camera-hint').textContent = 'Capturé !';
  setTimeout(() => $('#camera-flash').classList.remove('go'), 350);

  // Ne capture que la zone du gabarit (pas toute l'image caméra avec le fond
  // autour) : le reste du pipeline (nom puis code) suppose une image où la
  // carte occupe tout le cadre, comme une photo classique bien cadrée.
  const g = guideRect();
  const canvas = document.createElement('canvas');
  canvas.width = g.w;
  canvas.height = g.h;
  canvas.getContext('2d').drawImage(cameraVideo, g.x, g.y, g.w, g.h, 0, 0, g.w, g.h);
  await processCapturedImage(canvas);
}

loadStatus();
