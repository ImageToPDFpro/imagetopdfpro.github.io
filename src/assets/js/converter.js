/**
 * Image to PDF converter UI. Everything happens locally in the browser:
 * files are read with the File API and the PDF is assembled in memory.
 */
import { PdfWriter, MARGINS, layoutPage, parseJpeg, isJpegEmbeddable, exifRotation } from './pdf-writer.js';
import { createZip } from './zip.js';

const $ = (sel, root = document) => root.querySelector(sel);

const els = {
  converter: $('#converter'),
  dropzone: $('#dropzone'),
  input: $('#file-input'),
  workspace: $('#workspace'),
  grid: $('#thumb-grid'),
  addTile: $('#add-tile'),
  count: $('#item-count'),
  sort: $('#sort-select'),
  clear: $('#clear-all'),
  form: $('#settings'),
  convert: $('#convert-btn'),
  progress: $('#progress'),
  progressBar: $('#progress-bar'),
  progressText: $('#progress-text'),
  progressCount: $('#progress-count'),
  result: $('#result'),
  resultMeta: $('#result-meta'),
  download: $('#download-btn'),
  share: $('#share-btn'),
  edit: $('#edit-btn'),
  restart: $('#restart-btn'),
  toasts: $('#toasts'),
  status: $('#sr-status'),
};

if (!els.converter) throw new Error('Converter markup not found');

const QUALITY = {
  original: { maxSide: Infinity, jpegQuality: 0.95, passthrough: true, lossless: true },
  high: { maxSide: 3508, jpegQuality: 0.9 },
  balanced: { maxSide: 2480, jpegQuality: 0.8 },
  small: { maxSide: 1600, jpegQuality: 0.62 },
};
const MAX_CANVAS_PIXELS = 16_000_000;
const JPEG_COLOR_SPACES = { 1: 'DeviceGray', 3: 'DeviceRGB', 4: 'DeviceCMYK' };
const SETTINGS_KEY = 'itp-settings-v1';
const DEFAULT_SETTINGS = {
  pageSize: 'a4',
  orientation: 'auto',
  margin: 'small',
  fit: 'contain',
  quality: 'original',
  output: 'single',
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let items = [];
let nextId = 1;
let busy = false;
let resultUrl = null;
let resultFile = null;

/* ---------------------------------------------------------------- utils */

const icon = (paths, size = 18) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;

const ICONS = {
  left: icon('<path d="M15 6l-6 6 6 6"/>'),
  right: icon('<path d="M9 6l6 6-6 6"/>'),
  rotate: icon('<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/>'),
  remove: icon('<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>'),
  grip: icon('<circle cx="9" cy="6" r="1.2"/><circle cx="15" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="18" r="1.2"/>', 16),
};

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

function createLimiter(concurrency) {
  let active = 0;
  const queue = [];
  const run = () => {
    if (active >= concurrency || !queue.length) return;
    active++;
    const { task, resolve, reject } = queue.shift();
    task().then(resolve, reject).finally(() => {
      active--;
      run();
    });
  };
  return (task) =>
    new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      run();
    });
}
const decodeLimit = createLimiter(4);
const heicLimit = createLimiter(1);

function announce(message) {
  els.status.textContent = '';
  requestAnimationFrame(() => {
    els.status.textContent = message;
  });
}

function toast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast${type === 'error' ? ' is-error' : ''}`;
  el.textContent = message;
  els.toasts.append(el);
  setTimeout(() => el.remove(), type === 'error' ? 6500 : 4000);
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image could not be decoded'));
    img.src = url;
  });
}

/* ------------------------------------------------------------ settings */

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function readSettings() {
  const data = new FormData(els.form);
  const settings = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) settings[key] = data.get(key) || DEFAULT_SETTINGS[key];
  settings.filename = String(data.get('filename') || '');
  return settings;
}

function applySettings(settings) {
  for (const [key, value] of Object.entries(settings)) {
    const field = els.form.elements[key];
    if (!field || key === 'filename') continue;
    if (field instanceof RadioNodeList) {
      for (const radio of field) radio.checked = radio.value === value;
    } else {
      field.value = value;
    }
  }
}

function syncSettingsUi() {
  const s = readSettings();
  const fitPage = s.pageSize === 'fit';
  for (const id of ['orientation-field', 'fit-field']) {
    const fieldset = document.getElementById(id);
    if (fieldset) fieldset.disabled = fitPage;
  }
  const hint = document.getElementById('quality-hint');
  if (hint) {
    hint.textContent = {
      original: 'Keeps every pixel. JPEGs are copied without re-compression.',
      high: 'Print quality (300 DPI on A4). Noticeably smaller files.',
      balanced: 'Great on screen and for email. Much smaller files.',
      small: 'Smallest file, ideal for upload limits on forms and portals.',
    }[s.quality];
  }
  return s;
}

/* ------------------------------------------------------------- adding */

const isHeic = (file) => /image\/hei[cf]/i.test(file.type) || /\.(heic|heif)$/i.test(file.name);
const isImage = (file) =>
  (file.type && file.type.startsWith('image/')) || /\.(jpe?g|jfif|png|webp|gif|bmp|avif|svg|heic|heif|ico)$/i.test(file.name);

let heicLibPromise = null;
function loadHeicLibrary() {
  heicLibPromise ||= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('../vendor/heic2any.min.js', import.meta.url).href;
    script.async = true;
    script.onload = () => (window.heic2any ? resolve(window.heic2any) : reject(new Error('HEIC decoder unavailable')));
    script.onerror = () => {
      heicLibPromise = null;
      reject(new Error('HEIC decoder failed to load'));
    };
    document.head.append(script);
  });
  return heicLibPromise;
}

async function convertHeic(file) {
  // Safari decodes HEIC natively, so try that first.
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    if (img.naturalWidth > 0) return file;
  } catch {
    /* fall through to the WebAssembly decoder */
  } finally {
    URL.revokeObjectURL(url);
  }
  const heic2any = await loadHeicLibrary();
  const output = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
  const blob = Array.isArray(output) ? output[0] : output;
  return new File([blob], file.name.replace(/\.(heic|heif)$/i, '.jpg'), {
    type: 'image/jpeg',
    lastModified: file.lastModified,
  });
}

async function prepareItem(file) {
  let source = file;
  if (isHeic(file)) {
    source = await heicLimit(() => convertHeic(file));
  }
  const url = URL.createObjectURL(source);
  try {
    const img = await loadImage(url);
    let width = img.naturalWidth;
    let height = img.naturalHeight;
    if (!width || !height) {
      width = 1200; // SVGs without intrinsic size
      height = 1200;
    }
    return {
      id: nextId++,
      file: source,
      name: source.name || file.name || 'image',
      size: source.size,
      lastModified: file.lastModified || Date.now(),
      url,
      width,
      height,
      rotation: 0,
    };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

async function addFiles(fileList) {
  const all = [...fileList];
  const files = all.filter(isImage);
  const skipped = all.length - files.length;
  if (skipped) toast(`${skipped} file${skipped > 1 ? 's were' : ' was'} skipped (not an image).`, 'error');
  if (!files.length) return;
  if (busy) {
    toast('Please wait until the current PDF is finished.');
    return;
  }

  showWorkspace();
  const heicCount = files.filter(isHeic).length;
  if (heicCount) toast(`Converting ${heicCount} HEIC photo${heicCount > 1 ? 's' : ''}… this can take a few seconds.`);

  const tasks = files.map((file) => decodeLimit(() => prepareItem(file)).catch(() => ({ failed: file.name })));
  let added = 0;
  const failed = [];
  for (const task of tasks) {
    const item = await task;
    if (item.failed) {
      failed.push(item.failed);
      continue;
    }
    items.push(item);
    els.grid.insertBefore(createCard(item), els.addTile);
    added++;
  }

  refreshCards();
  if (failed.length) {
    toast(`Couldn't read ${failed.length === 1 ? `"${failed[0]}"` : `${failed.length} files`}. Try JPG, PNG, WebP or HEIC.`, 'error');
  }
  if (added) announce(`${added} image${added > 1 ? 's' : ''} added. ${items.length} in total.`);
  if (!items.length) showDropzone();
  if (items.length > 300) toast('That is a lot of images. Large documents may take a while on phones.');
}

/* --------------------------------------------------------------- cards */

function createCard(item) {
  const li = document.createElement('li');
  li.className = 'thumb is-new';
  li.dataset.id = String(item.id);
  const name = escapeHtml(item.name);
  li.innerHTML = `
    <span class="thumb-num" aria-hidden="true"></span>
    <span class="drag-handle" aria-hidden="true" title="Drag to reorder">${ICONS.grip}</span>
    <div class="thumb-stage">
      <div class="thumb-page"><div class="thumb-fit"><img src="${item.url}" alt="" decoding="async" draggable="false"></div></div>
    </div>
    <div class="thumb-info">
      <p class="thumb-name" title="${name}">${name}</p>
      <p class="thumb-meta">${item.width}×${item.height} · ${formatBytes(item.size)}</p>
    </div>
    <div class="thumb-actions">
      <button class="icon-btn" type="button" data-action="left">${ICONS.left}</button>
      <button class="icon-btn" type="button" data-action="right">${ICONS.right}</button>
      <button class="icon-btn" type="button" data-action="rotate">${ICONS.rotate}</button>
      <button class="icon-btn danger" type="button" data-action="remove">${ICONS.remove}</button>
    </div>`;
  li.addEventListener('animationend', () => li.classList.remove('is-new'), { once: true });
  return li;
}

function cardFor(item) {
  return els.grid.querySelector(`.thumb[data-id="${item.id}"]`);
}

function updatePreview(card, item, settings) {
  const sideways = item.rotation % 180 !== 0;
  const layout = layoutPage({
    imgW: sideways ? item.height : item.width,
    imgH: sideways ? item.width : item.height,
    pageSize: settings.pageSize,
    orientation: settings.orientation,
    margin: settings.margin,
    fit: settings.fit,
  });
  const ratio = layout.pageWidth / layout.pageHeight;
  const page = card.querySelector('.thumb-page');
  const fit = card.querySelector('.thumb-fit');
  page.style.setProperty('--ratio', ratio.toFixed(4));
  page.classList.toggle('is-wide', ratio > 1 / 1.08);
  // The preview box is the printable area (page minus margins); object-fit reproduces contain/cover inside it.
  const margin = MARGINS[settings.margin] ?? 0;
  fit.style.setProperty('--mx', `${((margin / layout.pageWidth) * 100).toFixed(3)}%`);
  fit.style.setProperty('--my', `${((margin / layout.pageHeight) * 100).toFixed(3)}%`);
  // A sideways image is laid out with swapped box dimensions, then rotated into place.
  const boxRatio = (layout.pageWidth - 2 * margin) / (layout.pageHeight - 2 * margin);
  fit.style.setProperty('--iw', sideways ? `${(100 / boxRatio).toFixed(3)}%` : '100%');
  fit.style.setProperty('--ih', sideways ? `${(100 * boxRatio).toFixed(3)}%` : '100%');
  fit.classList.toggle('is-cover', settings.fit === 'cover' && settings.pageSize !== 'fit');
  fit.style.setProperty('--rot', `${item.rotation}deg`);
}

function refreshCards() {
  const settings = readSettings();
  const total = items.length;
  items.forEach((item, index) => {
    const card = cardFor(item);
    if (!card) return;
    card.querySelector('.thumb-num').textContent = String(index + 1);
    const label = `${item.name}, image ${index + 1} of ${total}`;
    card.setAttribute('aria-label', label);
    const [left, right, rotate, remove] = card.querySelectorAll('.thumb-actions button');
    left.disabled = index === 0;
    right.disabled = index === total - 1;
    left.setAttribute('aria-label', `Move ${item.name} earlier`);
    right.setAttribute('aria-label', `Move ${item.name} later`);
    rotate.setAttribute('aria-label', `Rotate ${item.name} 90 degrees clockwise`);
    remove.setAttribute('aria-label', `Remove ${item.name}`);
    left.title = 'Move earlier';
    right.title = 'Move later';
    rotate.title = 'Rotate';
    remove.title = 'Remove';
    updatePreview(card, item, settings);
  });
  const totalSize = items.reduce((sum, item) => sum + item.size, 0);
  els.count.innerHTML = `${total} image${total === 1 ? '' : 's'} <span>· ${formatBytes(totalSize)}</span>`;
  els.convert.disabled = total === 0 || busy;
  els.sort.disabled = total < 2;
  document.body.classList.toggle('has-items', total > 0);
}

/** Animates cards from their previous position to the new one (FLIP). */
function withFlip(mutate) {
  const cards = [...els.grid.querySelectorAll('.thumb:not(.is-ghost)')];
  const before = new Map(cards.map((c) => [c, c.getBoundingClientRect()]));
  mutate();
  if (prefersReducedMotion.matches) return;
  for (const card of cards) {
    const prev = before.get(card);
    const next = card.getBoundingClientRect();
    const dx = prev.left - next.left;
    const dy = prev.top - next.top;
    if (dx || dy) {
      card.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
        duration: 220,
        easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)',
      });
    }
  }
}

function syncDomOrder() {
  withFlip(() => {
    for (const item of items) {
      const card = cardFor(item);
      if (card) els.grid.insertBefore(card, els.addTile);
    }
  });
  refreshCards();
}

function moveItem(item, delta) {
  const from = items.indexOf(item);
  const to = from + delta;
  if (to < 0 || to >= items.length) return;
  items.splice(from, 1);
  items.splice(to, 0, item);
  syncDomOrder();
  announce(`${item.name} moved to position ${to + 1} of ${items.length}.`);
}

function removeItem(item) {
  const index = items.indexOf(item);
  const card = cardFor(item);
  items.splice(index, 1);
  URL.revokeObjectURL(item.url);
  withFlip(() => card?.remove());
  refreshCards();
  announce(`${item.name} removed. ${items.length} image${items.length === 1 ? '' : 's'} left.`);
  if (!items.length) {
    showDropzone();
    return;
  }
  const neighbour = items[Math.min(index, items.length - 1)];
  cardFor(neighbour)?.querySelector('[data-action="remove"]')?.focus();
}

els.grid.addEventListener('click', (e) => {
  const button = e.target.closest('button[data-action]');
  if (!button || busy) return;
  const card = button.closest('.thumb');
  const item = items.find((i) => String(i.id) === card.dataset.id);
  if (!item) return;
  const action = button.dataset.action;
  if (action === 'left' || action === 'right') {
    moveItem(item, action === 'left' ? -1 : 1);
    const again = cardFor(item).querySelector(`[data-action="${action}"]`);
    (again.disabled ? cardFor(item).querySelector(`[data-action="${action === 'left' ? 'right' : 'left'}"]`) : again).focus();
  } else if (action === 'rotate') {
    item.rotation = (item.rotation + 90) % 360;
    refreshCards();
    announce(`${item.name} rotated to ${item.rotation} degrees.`);
  } else if (action === 'remove') {
    removeItem(item);
  }
});

/* ------------------------------------------------------ drag to reorder */

let drag = null;

els.grid.addEventListener('pointerdown', (e) => {
  if (busy || e.button !== 0) return;
  const card = e.target.closest('.thumb');
  if (!card) return;
  const onHandle = !!e.target.closest('.drag-handle');
  if (e.target.closest('button')) return;
  // Touch users drag with the handle so the page can still scroll normally.
  if (e.pointerType !== 'mouse' && !onHandle) return;
  if (onHandle) e.preventDefault();
  drag = { card, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, active: false };
});

function startDrag(e) {
  const rect = drag.card.getBoundingClientRect();
  const ghost = drag.card.cloneNode(true);
  ghost.classList.add('is-ghost');
  ghost.removeAttribute('data-id');
  ghost.setAttribute('aria-hidden', 'true');
  Object.assign(ghost.style, { width: `${rect.width}px`, height: `${rect.height}px`, left: `${rect.left}px`, top: `${rect.top}px` });
  document.body.append(ghost);
  drag.ghost = ghost;
  drag.offsetX = e.clientX - rect.left;
  drag.offsetY = e.clientY - rect.top;
  drag.active = true;
  drag.card.classList.add('is-placeholder');
  document.body.style.userSelect = 'none';
  autoScroll();
}

function autoScroll() {
  if (!drag?.active) return;
  const edge = 70;
  const y = drag.lastY ?? 0;
  if (y < edge) window.scrollBy(0, -Math.ceil((edge - y) / 5));
  else if (y > window.innerHeight - edge) window.scrollBy(0, Math.ceil((y - (window.innerHeight - edge)) / 5));
  requestAnimationFrame(autoScroll);
}

window.addEventListener(
  'pointermove',
  (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 6) return;
      startDrag(e);
    }
    e.preventDefault();
    drag.lastY = e.clientY;
    drag.ghost.style.left = `${e.clientX - drag.offsetX}px`;
    drag.ghost.style.top = `${e.clientY - drag.offsetY}px`;

    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.thumb');
    if (!target || target === drag.card || !els.grid.contains(target)) return;
    const cards = [...els.grid.querySelectorAll('.thumb')];
    const from = cards.indexOf(drag.card);
    const to = cards.indexOf(target);
    withFlip(() => {
      els.grid.insertBefore(drag.card, from < to ? target.nextSibling : target);
    });
  },
  { passive: false }
);

function endDrag() {
  if (!drag) return;
  const { active, card, ghost } = drag;
  drag = null;
  if (!active) return;
  ghost.remove();
  card.classList.remove('is-placeholder');
  document.body.style.userSelect = '';
  const order = [...els.grid.querySelectorAll('.thumb')].map((c) => c.dataset.id);
  items.sort((a, b) => order.indexOf(String(a.id)) - order.indexOf(String(b.id)));
  refreshCards();
  const item = items.find((i) => String(i.id) === card.dataset.id);
  if (item) announce(`${item.name} moved to position ${items.indexOf(item) + 1}.`);
}

window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);

/* ------------------------------------------------------------- views */

function showWorkspace() {
  els.dropzone.hidden = true;
  els.result.hidden = true;
  els.workspace.hidden = false;
}

function showDropzone() {
  els.workspace.hidden = true;
  els.result.hidden = true;
  els.dropzone.hidden = false;
  document.body.classList.remove('has-items');
}

function resetAll() {
  for (const item of items) URL.revokeObjectURL(item.url);
  items = [];
  els.grid.querySelectorAll('.thumb').forEach((c) => c.remove());
  clearResult();
  refreshCards();
  showDropzone();
  els.input.value = '';
  els.dropzone.querySelector('button')?.focus();
}

function clearResult() {
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = null;
  resultFile = null;
}

/* ------------------------------------------------------------ encoding */

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function rasterize(item, preset, mode) {
  const img = await loadImage(item.url);
  const w = img.naturalWidth || item.width;
  const h = img.naturalHeight || item.height;
  const scale = Math.min(1, preset.maxSide / Math.max(w, h), Math.sqrt(MAX_CANVAS_PIXELS / (w * h)));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));

  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#ffffff'; // transparent areas become white, like the page
  ctx.fillRect(0, 0, cw, ch);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, cw, ch);

  try {
    if (mode === 'flate' && typeof CompressionStream === 'function') {
      const { data } = ctx.getImageData(0, 0, cw, ch);
      const rgb = new Uint8Array(cw * ch * 3);
      for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
        rgb[j] = data[i];
        rgb[j + 1] = data[i + 1];
        rgb[j + 2] = data[i + 2];
      }
      return { data: await deflate(rgb), width: cw, height: ch, filter: 'FlateDecode', colorSpace: 'DeviceRGB', rotation: 0 };
    }
    const blob = await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Image encoding failed'))), 'image/jpeg', preset.jpegQuality)
    );
    return { data: new Uint8Array(await blob.arrayBuffer()), width: cw, height: ch, filter: 'DCTDecode', colorSpace: 'DeviceRGB', rotation: 0 };
  } finally {
    canvas.width = 0; // releases canvas memory promptly on iOS Safari
    canvas.height = 0;
  }
}

async function encodeImage(item, preset) {
  const isJpeg = item.file.type === 'image/jpeg' || /\.(jpe?g|jfif)$/i.test(item.name);
  if (isJpeg) {
    const bytes = new Uint8Array(await item.file.arrayBuffer());
    const info = parseJpeg(bytes);
    const rotation = info ? exifRotation(info.orientation) : null;
    if (isJpegEmbeddable(info) && rotation !== null) {
      const original = {
        data: bytes,
        width: info.width,
        height: info.height,
        filter: 'DCTDecode',
        colorSpace: JPEG_COLOR_SPACES[info.components],
        decode: info.components === 4 && info.adobe ? [1, 0, 1, 0, 1, 0, 1, 0] : undefined,
        rotation,
      };
      if (preset.passthrough) return original;
      const recompressed = await rasterize(item, preset, 'jpeg');
      return recompressed.data.byteLength < bytes.byteLength ? recompressed : original;
    }
    return rasterize(item, preset, 'jpeg');
  }
  return rasterize(item, preset, preset.lossless ? 'flate' : 'jpeg');
}

async function addToWriter(writer, item, settings, preset) {
  const image = await encodeImage(item, preset);
  const sideways = item.rotation % 180 !== 0;
  const layout = layoutPage({
    imgW: sideways ? item.height : item.width,
    imgH: sideways ? item.width : item.height,
    pageSize: settings.pageSize,
    orientation: settings.orientation,
    margin: settings.margin,
    fit: settings.fit,
  });
  writer.addImagePage({ ...layout, rotation: (image.rotation + item.rotation) % 360, image });
}

function outputBaseName(settings) {
  const cleaned = settings.filename
    .replace(/\.(pdf|zip)$/i, '')
    .replace(/[\\/:*?"<>| -]+/g, '-')
    .trim();
  if (cleaned) return cleaned.slice(0, 120);
  if (items.length === 1) return items[0].name.replace(/\.[^.]+$/, '') || 'image';
  return `images-${new Date().toISOString().slice(0, 10)}`;
}

function setProgress(done, total, label) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  els.progressBar.style.setProperty('--value', `${pct}%`);
  els.progress.querySelector('[role="progressbar"]').setAttribute('aria-valuenow', String(pct));
  els.progressText.textContent = label;
  els.progressCount.textContent = `${done} / ${total}`;
}

async function convert() {
  if (busy || !items.length) return;
  const settings = readSettings();
  const preset = QUALITY[settings.quality] || QUALITY.original;
  const baseName = outputBaseName(settings);
  const total = items.length;

  busy = true;
  clearResult();
  els.convert.disabled = true;
  els.convert.setAttribute('aria-busy', 'true');
  els.progress.hidden = false;
  els.workspace.classList.add('is-busy');
  setProgress(0, total, 'Preparing…');
  announce('Creating your PDF…');
  const started = performance.now();

  try {
    let blob;
    let filename;
    if (settings.output === 'separate' && total > 1) {
      const files = [];
      const used = new Set();
      for (let i = 0; i < total; i++) {
        const item = items[i];
        setProgress(i, total, `Converting ${item.name}`);
        await nextFrame();
        const writer = new PdfWriter({ title: item.name.replace(/\.[^.]+$/, '') });
        await addToWriter(writer, item, settings, preset);
        let name = `${String(i + 1).padStart(String(total).length, '0')}-${item.name.replace(/\.[^.]+$/, '')}.pdf`;
        while (used.has(name.toLowerCase())) name = name.replace(/\.pdf$/, '-1.pdf');
        used.add(name.toLowerCase());
        files.push({ name, data: writer.toBlob(), date: new Date() });
      }
      setProgress(total, total, 'Packaging ZIP…');
      await nextFrame();
      blob = await createZip(files);
      filename = `${baseName}.zip`;
    } else {
      const writer = new PdfWriter({ title: baseName });
      for (let i = 0; i < total; i++) {
        setProgress(i, total, `Adding page ${i + 1} of ${total}`);
        await nextFrame();
        await addToWriter(writer, items[i], settings, preset);
      }
      setProgress(total, total, 'Finishing…');
      await nextFrame();
      blob = writer.toBlob();
      filename = `${baseName}.pdf`;
    }

    resultFile = new File([blob], filename, { type: blob.type });
    resultUrl = URL.createObjectURL(resultFile);
    els.download.href = resultUrl;
    els.download.download = filename;
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    const isZip = filename.endsWith('.zip');
    els.resultMeta.textContent = `${filename} · ${isZip ? `${total} PDFs` : `${total} page${total === 1 ? '' : 's'}`} · ${formatBytes(blob.size)} · made in ${seconds}s`;
    els.share.hidden = !(navigator.canShare && navigator.canShare({ files: [resultFile] }));
    els.result.querySelector('h2').textContent = isZip ? 'Your PDFs are ready' : 'Your PDF is ready';
    document.getElementById('download-label').textContent = isZip ? 'Download ZIP' : 'Download PDF';

    els.workspace.hidden = true;
    els.result.hidden = false;
    els.result.querySelector('h2').focus();
    announce(`Your ${isZip ? 'ZIP file' : 'PDF'} is ready to download.`);
  } catch (err) {
    console.error(err);
    const memory = /memory|allocation|RangeError/i.test(String(err));
    toast(
      memory
        ? 'Your device ran out of memory. Try the "Balanced" or "Small file" quality, or fewer images at once.'
        : 'Something went wrong while creating the PDF. Please try again.',
      'error'
    );
  } finally {
    busy = false;
    els.progress.hidden = true;
    els.convert.removeAttribute('aria-busy');
    els.workspace.classList.remove('is-busy');
    refreshCards();
  }
}

/* ------------------------------------------------------------ wiring */

function openPicker() {
  if (!busy) els.input.click();
}

document.querySelectorAll('[data-pick]').forEach((btn) => btn.addEventListener('click', openPicker));
els.dropzone.addEventListener('click', (e) => {
  if (!e.target.closest('button, a, input')) openPicker();
});
els.input.addEventListener('change', () => {
  if (els.input.files?.length) addFiles(els.input.files);
  els.input.value = '';
});

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  document.body.classList.add('is-dragging-files');
});
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('is-dragging-files');
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('is-dragging-files');
  if (!els.result.hidden) {
    clearResult();
    showWorkspace();
  }
  addFiles(e.dataTransfer.files);
});

document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  const stamp = Date.now();
  addFiles(
    files.map((f, i) =>
      f.name && f.name !== 'image.png' ? f : new File([f], `pasted-${stamp}-${i + 1}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type })
    )
  );
});

els.sort.addEventListener('change', () => {
  const mode = els.sort.value;
  els.sort.value = '';
  if (!mode) return;
  const sorters = {
    'name-asc': (a, b) => collator.compare(a.name, b.name),
    'name-desc': (a, b) => collator.compare(b.name, a.name),
    'date-asc': (a, b) => a.lastModified - b.lastModified,
    'date-desc': (a, b) => b.lastModified - a.lastModified,
  };
  if (mode === 'reverse') items.reverse();
  else items.sort(sorters[mode]);
  syncDomOrder();
  announce('Images reordered.');
});

els.clear.addEventListener('click', () => {
  if (busy) return;
  if (items.length > 3 && !window.confirm(`Remove all ${items.length} images?`)) return;
  resetAll();
  announce('All images removed.');
});

els.form.addEventListener('change', () => {
  const settings = syncSettingsUi();
  const { filename, ...persist } = settings;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(persist));
  } catch {
    /* ignore */
  }
  refreshCards();
});
els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  convert();
});

els.share.addEventListener('click', async () => {
  if (!resultFile) return;
  try {
    await navigator.share({ files: [resultFile], title: resultFile.name });
  } catch (err) {
    if (err?.name !== 'AbortError') toast('Sharing is not available. Use Download instead.', 'error');
  }
});
els.download.addEventListener('click', () => announce('Download started.'));
els.edit.addEventListener('click', () => {
  showWorkspace();
  els.convert.focus();
});
els.restart.addEventListener('click', resetAll);

/* Files shared from other apps (Android share sheet) and opened via the installed app. */
async function importSharedFiles() {
  const params = new URLSearchParams(location.search);
  if (!params.has('shared') || !('caches' in window)) return;
  history.replaceState(null, '', location.pathname + location.hash);
  const cache = await caches.open('itp-shared-files');
  const files = [];
  for (const request of await cache.keys()) {
    const response = await cache.match(request);
    const blob = await response.blob();
    files.push(
      new File([blob], decodeURIComponent(response.headers.get('X-File-Name') || 'shared-image'), {
        type: blob.type,
        lastModified: Number(response.headers.get('X-Last-Modified')) || Date.now(),
      })
    );
  }
  await caches.delete('itp-shared-files');
  if (files.length) addFiles(files);
}

if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (params) => {
    if (!params.files?.length) return;
    addFiles(await Promise.all(params.files.map((handle) => handle.getFile())));
  });
}

applySettings(loadSettings());
syncSettingsUi();
refreshCards();
importSharedFiles().catch(() => {});
els.converter.classList.add('is-ready');
