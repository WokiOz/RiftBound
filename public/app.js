const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
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

// Ajoute une carte à l'inventaire et enchaîne (scanSession + carte/photo
// suivante). Partagé entre le tap manuel sur "+ Normal"/"+ Foil" et l'ajout
// automatique quand le scan reconnaît une seule carte sans ambiguïté.
async function addToInventory(id, finish) {
  const r = await api('/api/inventory', { method: 'POST', body: { id, finish, delta: 1 } });
  recordScanAdd(id, r.finish);
  return r;
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-add]');
  if (!btn) return;
  if (btn.dataset.delta) {
    await api('/api/inventory', { method: 'POST', body: { id: btn.dataset.add, finish: btn.dataset.finish, delta: Number(btn.dataset.delta) } });
    loadInventory();
    return;
  }
  const r = await addToInventory(btn.dataset.add, btn.dataset.finish);
  btn.textContent = `✓ ${r.finish} (${r.qty})`;
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
let scanFinish = 'normal'; // finition utilisée pour les ajouts automatiques (bascule Normal/Foil)

$$('.finish-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    scanFinish = btn.dataset.finish;
    $$('.finish-btn').forEach((b) => b.classList.toggle('active', b === btn));
  });
});

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
// mode 'code' (caméra en direct) : le gabarit vise déjà directement le code
// imprimé (voir guideRect), donc une seule lecture OCR sur quasi toute
// l'image capturée — plus de résolution sur le seul signal utile, confirmé
// plus fiable à l'usage que le mode "carte entière". Jamais de cadrage
// manuel sur un échec (voir "fin du faux repli manuel") : on relance
// simplement la surveillance pour un nouvel essai.
// mode 'full' (galerie, "Prendre une photo"/"Scanner plusieurs cartes") :
// photo de la carte entière, position dans le cadre inconnue — tente de
// détecter le rectangle de la carte (OpenCV) avant de chercher le code puis
// le nom ; repli sur le cadrage manuel si tout échoue.
async function processCapturedImage(source, mode = 'full') {
  cropTool.hidden = true;
  $('#scan-result').innerHTML = '<p class="muted">Reconnaissance…</p>';
  try {
    cropBitmap = await createImageBitmap(source);
    drawCropStage(); // fonctionne même cropTool masqué (ne dépend pas de sa visibilité)

    if (mode === 'code') {
      const codeResult = await tryCodeMatchDirect();
      if (codeResult.cards.length === 1) {
        const [card] = codeResult.cards;
        lastScanCards = codeResult.cards;
        const r = await addToInventory(card.id, scanFinish);
        $('#scan-result').innerHTML = `<p class="ok">Ajoutée (${esc(r.finish)}, ${r.qty}×) — code ${esc(codeResult.code.set)} ${codeResult.code.number}/${codeResult.code.total}.</p><div id="scan-result-cards">${cardRow(card)}</div>`;
        return true;
      }
      if (codeResult.cards.length > 1) {
        lastScanCards = codeResult.cards;
        $('#scan-result').innerHTML = `<p class="ok">Reconnue par le code (${esc(codeResult.code.set)} ${codeResult.code.number}/${codeResult.code.total}) — plusieurs variantes, laquelle ?</p><div id="scan-result-cards">${codeResult.cards.map(cardRow).join('')}</div>`;
        return true;
      }
      $('#scan-result').innerHTML = codeResult.text
        ? `<p class="muted">Code lu : « ${esc(codeResult.text)} » — pas de correspondance sûre. Nouvel essai…</p>`
        : '<p class="muted">Rien à lire ici. Nouvel essai…</p>';
      if (liveCameraActive) setTimeout(armCameraWatch, 600);
      return false;
    }

    // Galerie : tente de détecter le rectangle de la carte dans la photo,
    // pour ne plus supposer qu'elle remplit toute l'image. Si la détection
    // échoue (doigts sur le bord, OpenCV indisponible...), box reste la
    // photo entière — comportement inchangé, pas de régression.
    const box = (await detectCardBounds(cropBitmap)) || FULL_BOX;

    // Le code imprimé (ex. « OGN • 269/298 ») identifie la carte indépendamment
    // de sa langue d'impression, contrairement au nom : le catalogue (API
    // Riftcodex) n'existe qu'en anglais, donc une carte imprimée en français,
    // allemand, etc. ne pourra JAMAIS être reconnue par son nom, même avec
    // une photo parfaite. On essaie donc le code en premier.
    const codeResult = await tryCodeMatch(box);
    if (codeResult.cards.length === 1) {
      // Une seule carte possible pour ce code : ajout direct, sans attendre
      // un tap, pour pouvoir enchaîner les cartes sans interruption.
      const [card] = codeResult.cards;
      lastScanCards = codeResult.cards;
      const r = await addToInventory(card.id, scanFinish);
      $('#scan-result').innerHTML = `<p class="ok">Ajoutée (${esc(r.finish)}, ${r.qty}×) — code ${esc(codeResult.code.set)} ${codeResult.code.number}/${codeResult.code.total}.</p><div id="scan-result-cards">${cardRow(card)}</div>`;
      return true;
    }
    if (codeResult.cards.length > 1) {
      // Plusieurs variantes partagent ce code (Signature, Showcase...) :
      // ambigu, on laisse choisir manuellement plutôt que de deviner.
      lastScanCards = codeResult.cards;
      $('#scan-result').innerHTML = `<p class="ok">Reconnue par le code (${esc(codeResult.code.set)} ${codeResult.code.number}/${codeResult.code.total}) — plusieurs variantes, laquelle ?</p><div id="scan-result-cards">${codeResult.cards.map(cardRow).join('')}</div>`;
      return true;
    }

    const { card, text } = await tryNameMatch(box);
    if (card) {
      lastScanCards = [card];
      const r = await addToInventory(card.id, scanFinish);
      $('#scan-result').innerHTML = `<p class="ok">Ajoutée (${esc(r.finish)}, ${r.qty}×) — reconnue par le nom.</p><div id="scan-result-cards">${cardRow(card)}</div>`;
      return true;
    }

    const hints = [
      text && `nom lu : « ${esc(text)} »`,
      codeResult.text && `code lu : « ${esc(codeResult.text)} »`,
    ].filter(Boolean);

    // Repli (galerie) : cadrage manuel sur le code. On affiche ce que l'OCR a lu
    // (nom et/ou code) : utile pour comprendre pourquoi la reconnaissance
    // automatique échoue (mauvais cadrage, texte illisible, carte dans une
    // langue sans correspondance possible par le nom...).
    cropTool.hidden = false;
    resetCropBox();
    const langNote = text && !codeResult.cards.length
      ? ' Si la carte n\'est pas imprimée en anglais, seul le code permet de la reconnaître automatiquement.'
      : '';
    $('#scan-result').innerHTML = hints.length
      ? `<p class="muted">Pas de correspondance sûre (${hints.join(' — ')}).${langNote} Ajustez le cadre sur le code ci-dessous.</p>`
      : '<p class="muted">Aucun texte lisible automatiquement. Ajustez le cadre sur le code ci-dessous.</p>';
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
  let worker;
  try {
    worker = await Tesseract.createWorker('eng');
    await worker.setParameters({ tessedit_pageseg_mode: '7' });
    const { data } = await worker.recognize(extractCrop());
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
  } finally {
    if (worker) worker.terminate();
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
// pour donner à l'OCR un texte net et grand, sans avoir eu besoin de zoomer au tir.
// `zoom` plus élevé pour le code imprimé (texte bien plus petit que le nom).
function extractRegion(r, zoom = 3) {
  const scale = cropBitmap.width / cropCanvas.width;
  const sx = r.x * scale, sy = r.y * scale, sw = r.w * scale, sh = r.h * scale;
  const targetW = Math.max(900, Math.round(sw * zoom));
  const targetH = Math.round((targetW / sw) * sh);
  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cropBitmap, sx, sy, sw, sh, 0, 0, targetW, targetH);
  return preprocessForOcr(canvas);
}

// Niveaux de gris + étirement de contraste (min/max de la zone ramenés à
// 0-255) avant l'OCR : on envoyait jusqu'ici l'image couleur brute telle
// quelle, alors que Tesseract lit nettement mieux un texte à fort contraste
// qu'une photo couleur (éclairage inégal, reflets...). Étirement plutôt
// qu'un seuillage noir/blanc strict : améliore toujours la lisibilité sans
// risquer de perdre des caractères fins si le seuil choisi est mauvais.
// Correction suite à des essais contre une VRAIE photo (pas seulement des
// images synthétiques) : le masque flou inversé + l'étirement de contraste
// min/max, qui amélioraient nettement la tolérance au flou sur des images
// synthétiques propres (voir l'historique), se sont révélés CONTRE-PRODUCTIFS
// sur une vraie photo de téléphone — ils amplifient le bruit capteur/JPEG
// réel autant que le texte, et cassent une lecture qui fonctionnait sans
// prétraitement. Testé sur place (texte attendu « OGN • 212/298 • FR ») :
//   - sans traitement : « OGN 212/298 » lu correctement
//   - avec le renforcement de contours : texte illisible
// Seule la conversion en niveaux de gris (neutre, jamais nuisible dans ces
// essais) est conservée. Le compromis flou/bruit n'est pas résolu dans
// l'absolu : si le flou redevient un problème après ce changement, il
// faudra re-co-tester les deux à la fois plutôt que relancer un seul levier.
function preprocessForOcr(canvas) {
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(img, 0, 0);
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
// Une zone LARGE dégrade l'OCR (Tesseract mélange plusieurs blocs visuels —
// illustration, bandeau du nom, texte de règle — et perd le nom au milieu).
// On garde donc des bandes étroites, de la même hauteur qu'une bonne lecture
// (celle d'une photo de galerie, où la carte remplit tout le cadre), et on
// en essaie plusieurs positions à la suite pour tolérer un cadrage caméra
// imprécis, plutôt qu'une seule zone large et floue.
const NAME_CANDIDATES_PLAIN = [{ x: 0.06, y: 0.545, w: 0.72, h: 0.085 }];

// Le code imprimé (ex. « OGN • 269/298 ») est une toute petite bande tout en
// bas à gauche de la carte — bien plus petite que le nom, d'où un zoom OCR
// plus agressif (voir extractRegion) et plusieurs positions candidates pour
// tolérer l'imprécision de cadrage. Point de départ : la position par défaut
// du cadre manuel (resetCropBox, mesurée sur une image de référence),
// avec quelques variantes autour. Utilisé seulement en mode galerie : la
// caméra en direct vise déjà le code directement (voir tryCodeMatchDirect).
// x ramené à 0 (au lieu de 0.02) et bande élargie : sur une vraie photo, 0.02
// coupait la première lettre du set (« OGN » lu « GN »). Trouvé en comparant
// plusieurs décalages contre une vraie capture — voir le commit.
const CODE_CANDIDATES_PLAIN = [
  { x: 0, y: 0.94, w: 0.48, h: 0.05 },
  { x: 0, y: 0.925, w: 0.48, h: 0.06 },
  { x: 0, y: 0.955, w: 0.48, h: 0.04 },
];

// Lit le texte d'une zone candidate (silencieux en cas d'échec OCR). Chaque
// appel crée son propre worker Tesseract (comme le fait Tesseract.recognize()
// en coulisses) plutôt que d'en réutiliser un seul : ça garde le parallélisme
// entre zones candidates (voir tryCodeMatch/tryNameMatch), tout en permettant
// de régler tessedit_pageseg_mode, ce que l'API de commodité Tesseract.recognize()
// n'exposait pas. PSM 7 = "une seule ligne de texte", exactement ce que sont
// ces bandes (nom ou code) : par défaut Tesseract essaie de segmenter l'image
// en plusieurs blocs, ce qui se prête mal à une bande aussi étroite.
async function ocrRegion(region, zoom) {
  const rect = {
    x: cropCanvas.width * region.x, y: cropCanvas.height * region.y,
    w: cropCanvas.width * region.w, h: cropCanvas.height * region.h,
  };
  let worker;
  try {
    worker = await Tesseract.createWorker('eng');
    await worker.setParameters({ tessedit_pageseg_mode: '7' });
    const { data } = await worker.recognize(extractRegion(rect, zoom));
    return data.text.trim();
  } catch (err) {
    return '';
  } finally {
    if (worker) worker.terminate();
  }
}

// Replace une zone candidate (définie relativement à "la carte") dans les
// coordonnées de la boîte où la carte a été détectée (voir detectCardBounds).
// Boîte neutre par défaut (toute l'image = "on suppose que la carte remplit
// la photo", le comportement d'avant la détection des bords).
const FULL_BOX = { x: 0, y: 0, w: 1, h: 1 };
function remapRegion(region, box) {
  return {
    x: box.x + region.x * box.w, y: box.y + region.y * box.h,
    w: region.w * box.w, h: region.h * box.h,
  };
}

// Les zones candidates sont lues EN PARALLÈLE, pas l'une après l'autre :
// jusqu'à 4 lectures OCR enchaînées (~1-3 s chacune sur un téléphone)
// rendaient l'échec très long (jusqu'à 8 au total avec le nom). Ce sont des
// lectures indépendantes de la même image déjà capturée, donc rien n'empêche
// de les lancer toutes à la fois et de garder la première qui réussit.
async function tryCodeMatch(box = FULL_BOX) {
  const results = await Promise.all(CODE_CANDIDATES_PLAIN.map(async (region) => {
    const text = await ocrRegion(remapRegion(region, box), 6);
    if (!text) return { text: '', code: null, cards: [] };
    const r = await api('/api/scan', { method: 'POST', body: { text } });
    return { text, code: r.code, cards: r.cards || [] };
  }));
  const hit = results.find((r) => r.code && r.cards.length);
  if (hit) return hit;
  return { cards: [], code: null, text: results.map((r) => r.text).find(Boolean) || '' };
}

async function tryNameMatch(box = FULL_BOX) {
  const results = await Promise.all(NAME_CANDIDATES_PLAIN.map(async (region) => {
    const text = await ocrRegion(remapRegion(region, box), 3);
    if (!text) return { text: '', card: null };
    const r = await api('/api/scan-name', { method: 'POST', body: { text } });
    return { text, card: r.confident ? r.card : null };
  }));
  const hit = results.find((r) => r.card);
  if (hit) return hit;
  return { card: null, text: results.map((r) => r.text).find(Boolean) || '' };
}

// Caméra en direct : le gabarit vise déjà directement le code (voir
// guideRect), donc l'image capturée EST la zone à lire — pas besoin de
// deviner sa position comme pour une photo de carte entière. Deux cadrages
// (plein cadre, puis recentré en excluant la marge ajoutée par
// captureFromCamera) pour tolérer un alignement pas tout à fait pixel-parfait.
const CODE_DIRECT_REGIONS = [
  { x: 0, y: 0, w: 1, h: 1 },
  { x: 0.08, y: 0.2, w: 0.84, h: 0.6 },
];

async function tryCodeMatchDirect() {
  const results = await Promise.all(CODE_DIRECT_REGIONS.map(async (region) => {
    const text = await ocrRegion(region, 6);
    if (!text) return { text: '', code: null, cards: [] };
    const r = await api('/api/scan', { method: 'POST', body: { text } });
    return { text, code: r.code, cards: r.cards || [] };
  }));
  const hit = results.find((r) => r.code && r.cards.length);
  if (hit) return hit;
  return { cards: [], code: null, text: results.map((r) => r.text).find(Boolean) || '' };
}

// Charge OpenCV.js à la demande (~10 Mo, mis en cache par le navigateur
// après le premier chargement) : seuls les utilisateurs de "Prendre une
// photo" paient ce coût, pas ceux qui n'utilisent que la caméra en direct
// (dont le cadrage est déjà contrôlé par le gabarit, donc pas besoin de
// deviner les bords de la carte après coup).
let openCvLoadPromise = null;
function loadOpenCv() {
  if (window.cv && typeof window.cv.Mat === 'function') return Promise.resolve();
  if (openCvLoadPromise) return openCvLoadPromise;
  openCvLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.9.0-release.1/dist/opencv.js';
    script.onerror = () => reject(new Error("OpenCV n'a pas pu être chargé"));
    script.onload = () => {
      const check = () => {
        if (window.cv && typeof window.cv.Mat === 'function') resolve();
        else setTimeout(check, 50);
      };
      check();
    };
    document.head.appendChild(script);
  });
  return openCvLoadPromise;
}

// Détecte le rectangle de la carte dans une photo "galerie" (pas pré-cadrée
// par le gabarit caméra), pour ne plus supposer que la carte remplit toute
// la photo (CODE_CANDIDATES_PLAIN) — hypothèse qui échoue dès que la photo a
// de la marge (carte tenue en main, pas juste posée à plat).
// Best-effort, pas garanti : quand des doigts recouvrent le bord de la
// carte, leur contour fusionne avec celui de la carte dans la détection, et
// aucune détection de contours (même une vraie, vérifié avec OpenCV) ne peut
// les séparer proprement — dans ce cas la fonction renvoie null et on
// retombe sur l'hypothèse "la carte remplit la photo" (comportement
// d'avant, pas de régression).
async function detectCardBounds(bitmap) {
  try {
    await loadOpenCv();
  } catch (err) {
    return null;
  }
  const sw = 400;
  const sh = Math.round(sw * bitmap.height / bitmap.width);
  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, sw, sh);

  const src = cv.imread(canvas);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  const blurred = new cv.Mat();
  cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
  const edges = new cv.Mat();
  cv.Canny(blurred, edges, 40, 120);
  const kernel = cv.Mat.ones(5, 5, cv.CV_8U);
  const dilated = new cv.Mat();
  cv.dilate(edges, dilated, kernel);
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(dilated, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

  // Le plus grand contour à 4 coins (quadrilatère) dont l'aire est
  // plausible pour une carte dans le cadre (ni un petit détail interne de
  // la carte, ni la quasi-totalité de la photo — dans ce dernier cas la
  // photo est déjà bien cadrée, pas la peine de "détecter" quoi que ce soit).
  const frameArea = sw * sh;
  let bestRect = null;
  let bestArea = 0;
  for (let i = 0; i < contours.size(); i++) {
    const cnt = contours.get(i);
    const area = cv.contourArea(cnt);
    const ratio = area / frameArea;
    if (ratio >= 0.5 && ratio <= 0.92) {
      const peri = cv.arcLength(cnt, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
      if (approx.rows === 4 && area > bestArea) {
        bestArea = area;
        bestRect = cv.boundingRect(cnt);
      }
      approx.delete();
    }
    cnt.delete();
  }

  src.delete();
  gray.delete();
  blurred.delete();
  edges.delete();
  kernel.delete();
  dilated.delete();
  contours.delete();
  hierarchy.delete();

  if (!bestRect) return null;
  // Petite marge de sécurité : approxPolyDP peut légèrement rogner les bords.
  const pad = 0.015;
  return {
    x: Math.max(0, bestRect.x / sw - pad),
    y: Math.max(0, bestRect.y / sh - pad),
    w: Math.min(1, bestRect.width / sw + pad * 2),
    h: Math.min(1, bestRect.height / sh + pad * 2),
  };
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
function deckBody(d) {
  return `
    <p class="${d.complete ? 'ok' : 'ko'}">${d.complete ? 'Deck complet' : 'Deck incomplet'}
      — Main ${d.counts.main}/40 · Runes ${d.counts.runes}/12 · Battlefields ${d.counts.battlefields}/3</p>
    <div class="deck-meter"><span style="width:${Math.round((d.counts.main / 40) * 100)}%"></span></div>
    <details><summary>Main deck</summary><ul>${d.main.map((m) => `<li>${m.qty} × ${esc(m.name)}</li>`).join('')}</ul></details>
    <details><summary>Runes & Battlefields</summary><ul>
      ${d.runes.map((r) => `<li>${r.qty} × ${esc(r.name)}</li>`).join('')}
      ${d.battlefields.map((b) => `<li>${esc(b)}</li>`).join('')}
    </ul></details>
    ${d.toBuy.length ? `
      <div class="buy-box"><span>${d.toBuy.length} carte(s) manquante(s)</span><strong>${usd(d.toBuyTotal)}</strong></div>
      <details><summary>Détail des achats</summary><ul>${d.toBuy.map((b) => `<li>${b.qty} × ${esc(b.name)} <span class="muted">${esc(b.code)}</span> — ${usd(b.unitPrice)}</li>`).join('')}</ul></details>` : ''}`;
}

function legendCard({ legend, variants }) {
  const pct = (v) => Math.round((v.deck.counts.main / 40) * 100);
  return `
    <article class="deck" data-legend="${esc(legend.code)}">
      <h2>${esc(legend.name)} <span class="muted">${esc(legend.domains.join(' / '))}</span></h2>
      ${variants.length > 1 ? `
        <div class="variant-tabs" role="tablist">
          ${variants.map((v, i) => `
            <button class="variant-tab" data-variant="${i}" aria-selected="${i === 0}">
              ${esc(v.champion || 'À choisir')} <span class="muted">${pct(v)}%</span>
            </button>`).join('')}
        </div>` : ''}
      ${variants.length > 1 ? `
        <div class="champ-select muted">Chosen Champion :
          ${variants.map((v, i) => `<button class="champ-chip" data-variant="${i}" aria-pressed="${i === 0}">${esc(v.champion)}</button>`).join('')}
        </div>` : ''}
      <div class="variant-body">${deckBody(variants[0].deck)}</div>
    </article>`;
}

async function loadDecks() {
  const decks = await api('/api/decks');
  $('#decks-list').innerHTML = decks.map(legendCard).join('')
    || '<p>Ajoutez au moins une Legend à l\'inventaire pour générer un deck.</p>';
  $$('.deck').forEach((article, legendIdx) => {
    const deck = decks[legendIdx];
    const switchVariant = (i) => {
      article.querySelectorAll('.variant-tab, .champ-chip').forEach((btn) => {
        const selected = Number(btn.dataset.variant) === i;
        btn.setAttribute(btn.classList.contains('variant-tab') ? 'aria-selected' : 'aria-pressed', String(selected));
      });
      article.querySelector('.variant-body').innerHTML = deckBody(deck.variants[i].deck);
    };
    article.querySelectorAll('.variant-tab, .champ-chip').forEach((btn) => {
      btn.addEventListener('click', () => switchVariant(Number(btn.dataset.variant)));
    });
  });
}

// ---------- Archétypes ----------
let archetypesLoaded = false;
async function loadArchetypes() {
  const archetypes = await api('/api/archetypes');
  $('#archetype-list').innerHTML = archetypes.map((a) => `
    <article class="archetype-card">
      <h3>${esc(a.name)} <span class="muted">${esc(a.domains.join(' / '))}</span></h3>
      <p class="muted">${esc(a.description)}</p>
      <div class="own-row">
        <span>Possédé</span>
        <div class="deck-meter"><span style="width:${Math.round(a.ownedRatio * 100)}%"></span></div>
        <span>${Math.round(a.ownedRatio * 100)}%</span>
      </div>
    </article>`).join('');
  archetypesLoaded = true;
}

$('#archetype-toggle').addEventListener('click', async () => {
  const list = $('#archetype-list');
  const open = list.hidden;
  if (open && !archetypesLoaded) await loadArchetypes();
  list.hidden = !open;
  $('#archetype-switch').classList.toggle('on', open);
  $('#archetype-toggle').setAttribute('aria-expanded', String(open));
});

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
let cameraPrevMean = 0;
let cameraDiffEma = null;
let cameraProgressMs = 0; // "réserve" de stabilité, façon seau percé (voir watchCameraFrame)
let cameraLastTs = null;
let cameraContentSince = null; // depuis quand une carte est visible dans le gabarit
const CAMERA_STABLE_MS = 550;
// Délai incompressible avant toute capture, même si la main est stable dès
// la première image : le téléphone a besoin d'un instant pour faire la mise
// au point et ajuster l'exposition. Sans ça, on capture parfois pendant que
// l'image est encore floue (l'autofocus n'a pas eu le temps de s'ajuster) —
// ce qu'un humain évite naturellement en marquant une petite pause avant de
// prendre la photo.
const CAMERA_FOCUS_DELAY_MS = 900;

const cameraVideo = $('#camera-video');
const cameraGuide = $('#camera-guide');
const cameraRing = $('#camera-ring-fill');
const RING_CIRCUMFERENCE = 88;

$('#btn-open-camera').addEventListener('click', openCamera);
$('#btn-close-camera').addEventListener('click', closeCamera);
// Secours si l'alignement automatique peine (lumière, tremblement...) :
// force la capture immédiatement, sans attendre la détection de stabilité.
$('#btn-capture-now').addEventListener('click', () => {
  if (liveCameraActive && cameraWatchId) captureFromCamera();
});

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
      // Résolution plus haute que la précédente (1280) : le code imprimé est
      // minuscule, donc chaque pixel de résolution native compte bien plus
      // pour sa lisibilité que pour le gros nom de la carte. Le navigateur
      // retombe automatiquement sur le maximum supporté par l'appareil si
      // 2560 n'est pas atteignable (c'est un "ideal", pas une exigence stricte).
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 2560 } },
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
  $('#camera-hint').textContent = 'Alignez le code imprimé dans le cadre';
  cameraPrevSample = null;
  cameraDiffEma = null;
  cameraProgressMs = 0;
  cameraLastTs = null;
  cameraContentSince = null;
  cameraWatchId = requestAnimationFrame(watchCameraFrame);
}

// Position du gabarit dans le flux vidéo, en fraction de sa résolution :
// mêmes proportions que le cadre affiché à l'écran (#camera-guide en CSS).
// Bande fine ciblant DIRECTEMENT le code imprimé (pas la carte entière) :
// l'utilisateur rapproche le téléphone jusqu'à ce que le texte remplisse le
// cadre. Ça donne à l'OCR un maximum de pixels natifs sur le seul signal
// utile (le code, minuscule), et évite d'avoir à deviner sa position dans
// une photo de carte entière — confirmé plus fiable à l'usage.
// `padding` (fraction de la largeur/hauteur du gabarit) élargit la zone
// réellement capturée au-delà du gabarit affiché à l'écran : viser à l'œil
// un cadre dessiné n'est jamais pixel-parfait, et un décalage important
// peut couper le texte hors de la capture — aucune recherche après coup ne
// peut retrouver une donnée qui n'a jamais été photographiée.
function guideRect(padding = 0) {
  const vw = cameraVideo.videoWidth, vh = cameraVideo.videoHeight;
  const w = vw * 0.84, h = w / 7; // bande large et basse, pas le rectangle d'une carte
  const x = vw * 0.08 - w * padding, y = vh * 0.44 - h * padding;
  const pw = w * (1 + 2 * padding), ph = h * (1 + 2 * padding);
  return {
    x: Math.max(0, x), y: Math.max(0, y),
    w: Math.min(pw, vw - Math.max(0, x)), h: Math.min(ph, vh - Math.max(0, y)),
  };
}

// Échantillonne le gabarit en petite résolution pour détecter une image
// stable (main immobile) contenant quelque chose (pas juste le fond). Grille
// large et basse (28×6) plutôt que carrée : plus proche de la forme réelle
// de la bande visée, pour que variance/diff restent représentatifs.
function sampleGuideRegion() {
  if (!cameraVideo.videoWidth) return null;
  const guide = guideRect();
  const canvas = sampleGuideRegion.canvas || (sampleGuideRegion.canvas = document.createElement('canvas'));
  canvas.width = 28;
  canvas.height = 6;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(cameraVideo, guide.x, guide.y, guide.w, guide.h, 0, 0, 28, 6);
  return ctx.getImageData(0, 0, 28, 6).data;
}

function watchCameraFrame(ts) {
  if (!liveCameraActive) return;
  // dt borné : évite un grand saut après un rendu en pause (onglet en arrière-plan)
  const dt = cameraLastTs ? Math.min(100, ts - cameraLastTs) : 16;
  cameraLastTs = ts;

  const sample = sampleGuideRegion();
  if (!sample) {
    cameraWatchId = requestAnimationFrame(watchCameraFrame);
    return;
  }
  let variance = 0, diff = 0, mean = 0, edges = 0;
  for (let i = 0; i < sample.length; i += 4) mean += sample[i];
  mean /= sample.length / 4;
  for (let i = 0; i < sample.length; i += 4) variance += (sample[i] - mean) ** 2;
  variance /= sample.length / 4;
  // Densité de contours (écart entre pixels voisins) : une carte a un cadre
  // net, du texte et une illustration détaillée, donc des transitions
  // marquées. Un fond flou/uniforme (sol, tissu, peau...) peut avoir autant
  // de variance qu'une carte (texture du sol, ombres) sans avoir ces
  // transitions nettes — d'où la capture qui se déclenchait sur un pied ou
  // le sol : la seule variance ne suffisait pas à distinguer "une carte" de
  // "n'importe quoi de texturé".
  for (let i = 4; i < sample.length; i += 4) edges += Math.abs(sample[i] - sample[i - 4]);
  edges /= sample.length / 4 - 1;
  if (cameraPrevSample) {
    // Diff normalisée par la luminosité moyenne de chaque image, pas sur les
    // valeurs brutes : l'exposition/balance des blancs automatique du
    // téléphone fait dériver en continu la luminosité globale, même sans
    // aucun mouvement, ce qui empêchait quasiment toujours la stabilité de
    // s'établir. En comparant l'écart à la moyenne de chaque image (sa
    // "structure"), ces dérives de luminosité globale n'affectent plus diff.
    const prevMean = cameraPrevMean;
    for (let i = 0; i < sample.length; i += 4) {
      diff += Math.abs((sample[i] - mean) - (cameraPrevSample[i] - prevMean));
    }
    diff /= sample.length / 4;
  }
  cameraPrevSample = sample;
  cameraPrevMean = mean;

  // Lissage exponentiel du signal de mouvement plutôt qu'un jugement image
  // par image : une vraie caméra de téléphone a du bruit capteur et des
  // micro-à-coups d'autofocus/exposition en continu, même totalement
  // immobile. Juger chaque image isolément (même avec un seuil large)
  // échoue presque toujours à un moment ou un autre. En lissant sur ~0.3s,
  // ce bruit s'annule tout en restant sensible à un vrai mouvement soutenu.
  cameraDiffEma = cameraDiffEma == null ? diff : cameraDiffEma * 0.85 + diff * 0.15;

  // Les deux conditions à la fois : la variance seule déclenchait parfois
  // sur un fond texturé mais flou (sol, tissu, pied...) qui n'est pas une
  // carte. Ce n'est toujours pas une vraie détection de carte (juste une
  // heuristique de "texture + contours nets"), mais ça filtre les cas les
  // plus flagrants. Seuil des contours non calibré sur de vraies photos
  // (pas de carte physique disponible ici) : à ajuster via #camera-debug
  // si des faux positifs/négatifs persistent en usage réel.
  const hasContent = variance > 120 && edges > 6;
  const isStable = cameraDiffEma < 14;

  // "Seau percé" plutôt qu'un chrono qui repart de zéro au moindre à-coup :
  // un tremblement ponctuel fait juste redescendre un peu la jauge, elle ne
  // se vide pas d'un coup. Beaucoup plus tolérant à une main qui tremble
  // légèrement, tout en repartant vraiment de zéro si la carte est retirée.
  if (!hasContent) {
    cameraProgressMs = 0;
    cameraContentSince = null;
  } else {
    if (!cameraContentSince) cameraContentSince = ts;
    if (isStable) cameraProgressMs = Math.min(CAMERA_STABLE_MS, cameraProgressMs + dt);
    else cameraProgressMs = Math.max(0, cameraProgressMs - dt);
  }
  const focusReady = hasContent && ts - cameraContentSince >= CAMERA_FOCUS_DELAY_MS;

  cameraGuide.classList.toggle('aligned', cameraProgressMs > 0);
  cameraRing.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - cameraProgressMs / CAMERA_STABLE_MS));
  $('#camera-hint').textContent = !hasContent
    ? 'Alignez le code imprimé dans le cadre'
    : focusReady ? 'Ne bougez plus…' : 'Mise au point…';
  // Repère de calibration : la valeur affichée quand la carte est immobile
  // permet d'ajuster le seuil de stabilité au vu de vraies conditions
  // (bruit capteur, éclairage) plutôt qu'en devinant.
  $('#camera-debug').textContent = `mouvement: ${Math.round(cameraDiffEma ?? 0)} (seuil 14) · contours: ${Math.round(edges)} (seuil 6)`;

  if (cameraProgressMs >= CAMERA_STABLE_MS && focusReady) {
    captureFromCamera();
    return; // la surveillance reprendra via armCameraWatch()
  }
  cameraWatchId = requestAnimationFrame(watchCameraFrame);
}

async function captureFromCamera() {
  if (cameraWatchId) cancelAnimationFrame(cameraWatchId);
  cameraWatchId = null;
  $('#camera-flash').classList.add('go');
  // "Photo prise", pas "Carte reconnue" : à ce stade on sait juste qu'on a
  // jugé le cadre stable et texturé, pas que l'OCR va réussir à l'identifier.
  $('#camera-hint').textContent = 'Photo prise, analyse…';
  setTimeout(() => $('#camera-flash').classList.remove('go'), 350);

  // Capture un peu plus large que le gabarit affiché (marge de chaque côté) :
  // viser à l'œil un cadre dessiné à l'écran n'est jamais parfait, cette
  // marge évite de couper le texte hors de la capture quand l'alignement
  // réel est légèrement décalé.
  // 0.3 cassait la lecture en pratique : juste au-dessus du code se trouve
  // le bloc de règles/texte d'ambiance de la carte, et cette marge allait le
  // mordre, mélangeant deux blocs de texte très différents dans la même
  // lecture OCR (confirmé en reproduisant la géométrie exacte d'une vraie
  // capture ratée). Vérifié par balayage : 0.3 et 0.2 → illisible, 0.15 et
  // 0.1 → lu parfaitement, 0.05 → coupe la première lettre. 0.15 garde une
  // marge de sécurité par rapport au seuil d'échec (0.2).
  const g = guideRect(0.15);
  const canvas = document.createElement('canvas');
  canvas.width = g.w;
  canvas.height = g.h;
  canvas.getContext('2d').drawImage(cameraVideo, g.x, g.y, g.w, g.h, 0, 0, g.w, g.h);
  await processCapturedImage(canvas, 'code');
}

loadStatus();
