// Editor UI: form state → RenderProps → a live preview (the stage page in a same-origin iframe, shown at
// 1 CSS px : 1 CSS px) and, through window.ytComment (electron/preload.cjs), Save PNG… / Copy image.
// The editor state (not derived data) is kept in localStorage.
import {
  DEFAULT_AVATAR_COLORS, DEFAULT_AVATAR_COLOR_NAMES, avatarInitial, avatarSizeFor, badgeSizeFor,
  makeDefaultAvatar, pickAvatarColor, prepareAvatar, prepareBadge,
} from '../comment/avatar.js';

const STORAGE_KEY = 'ytComment.editor.v1';
const MESSAGE_LIMIT = 200; // YouTube's chat input counter; shown, not enforced
const DEFAULT_ROW_WIDTH = 400; // the user's saved theater-mode chat: 415 px chat − 15 px scrollbar
const WIDTH_PRESETS = [
  { width: 385, title: 'YouTube default — 402px sidebar' },
  { width: 400, title: 'Your saved page' },
];
const ROW_WIDTH = { min: 200, max: 1200 };
const MARGIN = { min: 0, max: 64 };
const SCALES = [1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const RENDER_DELAY_MS = 60;
const PERSIST_DELAY_MS = 250;
const STAGE_TIMEOUT_MS = 8000;

const DEFAULT_STATE = {
  name: '@YourChannel',
  message: 'This stream is amazing 🔥',
  avatarMode: 'default', // 'default' (letter avatar) | 'image' | 'none' (cropped out of the export)
  avatarColor: 'auto', // 'auto' | one of DEFAULT_AVATAR_COLORS
  avatarImage: null, // uploaded avatar: { 32: dataUrl, 64: dataUrl }
  role: 'viewer',
  moderatorBadge: 'shield', // 'shield' (current) | 'wrench' (YouTube's classic moderator badge)
  verified: false,
  badgeImage: null, // uploaded member badge: { 16: dataUrl, 32: dataUrl }
  theme: 'dark',
  timestampOn: false,
  timestamp: '',
  timestampAuto: true, // follows the current time until the user types their own
  rowWidth: DEFAULT_ROW_WIDTH,
  margin: 0,
  scale: 'auto', // 'auto' (match the display) | one of SCALES
};

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const form = $('form');
const preview = $('preview');
const outline = $('outline');
const api = window.ytComment ?? null;

const state = loadState();
let displayScale = window.devicePixelRatio;
let lastBox = null;
let busy = false;
let autoSwatch = null;

// ---- State ----------------------------------------------------------------------------------------------

function loadState() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
  } catch {
    saved = null;
  }
  const loaded = { ...DEFAULT_STATE };
  if (saved && typeof saved === 'object') {
    for (const key of Object.keys(DEFAULT_STATE)) {
      if (key in saved && isValid(key, saved[key])) loaded[key] = saved[key];
    }
  }
  if (loaded.timestampAuto || !loaded.timestamp) {
    loaded.timestamp = formatTime(new Date());
    loaded.timestampAuto = true;
  }
  return loaded;
}

// A function declaration (hoisted): loadState() runs before this point in the module.
function isDataUrlSet(value, sizes) {
  return value === null
    || (typeof value === 'object' && sizes.every((size) => typeof value[size] === 'string' && value[size].startsWith('data:image/')));
}

function isValid(key, value) {
  switch (key) {
    case 'name': case 'message': case 'timestamp': return typeof value === 'string';
    case 'verified': case 'timestampOn': case 'timestampAuto': return typeof value === 'boolean';
    case 'avatarMode': return ['default', 'image', 'none'].includes(value);
    case 'avatarColor': return value === 'auto' || DEFAULT_AVATAR_COLORS.includes(value);
    case 'avatarImage': return isDataUrlSet(value, [32, 64]);
    case 'badgeImage': return isDataUrlSet(value, [16, 32]);
    case 'role': return ['viewer', 'member', 'moderator', 'owner'].includes(value);
    case 'moderatorBadge': return value === 'shield' || value === 'wrench';
    case 'theme': return value === 'dark' || value === 'light';
    case 'rowWidth': return Number.isFinite(value) && value >= ROW_WIDTH.min && value <= ROW_WIDTH.max;
    case 'margin': return Number.isFinite(value) && value >= MARGIN.min && value <= MARGIN.max;
    case 'scale': return value === 'auto' || SCALES.includes(value);
    default: return false;
  }
}

let persistTimer = 0;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, PERSIST_DELAY_MS);
}

function persistNow() {
  clearTimeout(persistTimer);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage can be unavailable or full; the editor works without it.
  }
}

/** YouTube live chat's clock format, e.g. '2:41 PM'. */
function formatTime(date) {
  const hours = date.getHours();
  return `${hours % 12 || 12}:${String(date.getMinutes()).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
}

const clamp = (value, { min, max }) => Math.min(max, Math.max(min, value));

/** Keeps an untouched timestamp on the current time, so an export never shows a stale one. */
function followClock() {
  if (!state.timestampAuto) return;
  const now = formatTime(new Date());
  if (now === state.timestamp) return;
  state.timestamp = now;
  $('timestamp').value = now;
  changed({ render: state.timestampOn });
}
const formatScale = (scale) => String(Math.round(scale * 100) / 100);
const EXPORT_SCALE = { min: 0.5, max: 4 }; // what the main process accepts
const exportScale = () => clamp(state.scale === 'auto' ? displayScale : state.scale, EXPORT_SCALE);

// ---- RenderProps ----------------------------------------------------------------------------------------

const defaultAvatars = new Map();
function defaultAvatar(name, color, size) {
  const key = `${avatarInitial(name)}|${color}|${size}`;
  if (!defaultAvatars.has(key)) {
    defaultAvatars.set(key, makeDefaultAvatar({ name, color, size }).catch((error) => {
      defaultAvatars.delete(key);
      throw error;
    }));
  }
  return defaultAvatars.get(key);
}

/** RenderProps for `scale`, which picks the avatar/badge image size the way YouTube does. */
async function buildProps(scale) {
  const s = { ...state }; // a snapshot: the state may change while the avatar is drawn
  const color = s.avatarColor === 'auto' ? pickAvatarColor(s.name) : s.avatarColor;
  const hideAvatar = s.avatarMode === 'none';
  let avatarSrc = null;
  if (s.avatarMode === 'image' && s.avatarImage) avatarSrc = s.avatarImage[avatarSizeFor(scale)];
  else if (!hideAvatar) avatarSrc = await defaultAvatar(s.name, color, avatarSizeFor(scale));
  return {
    name: s.name,
    message: s.message.replace(/\r\n?|\n/g, ' '),
    theme: s.theme,
    role: s.role,
    moderatorBadge: s.moderatorBadge,
    verified: s.verified,
    hideAvatar,
    avatarSrc,
    memberBadgeSrc: s.role === 'member' && s.badgeImage ? s.badgeImage[badgeSizeFor(scale)] : null,
    timestamp: s.timestampOn && s.timestamp ? s.timestamp : null,
    rowWidth: s.rowWidth,
    margin: s.margin,
  };
}

// ---- Preview --------------------------------------------------------------------------------------------

let renderTimer = 0;
let rendering = false;
let renderAgain = false;

function scheduleRender(delay = RENDER_DELAY_MS) {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderPreview, delay);
}

/** One render at a time; changes made meanwhile are folded into a single follow-up render. */
async function renderPreview() {
  if (rendering) {
    renderAgain = true;
    return;
  }
  rendering = true;
  try {
    do {
      renderAgain = false;
      await renderOnce();
    } while (renderAgain);
  } finally {
    rendering = false;
  }
}

async function renderOnce() {
  root.dataset.preview = 'pending';
  let stage;
  try {
    stage = await stageApi();
  } catch (error) {
    showPreviewError(error.message);
    return;
  }
  let box;
  try {
    box = await stage.render(await buildProps(window.devicePixelRatio));
  } catch (error) {
    showPreviewError(`The preview could not draw the comment: ${error?.message ?? error}`);
    return;
  }
  if (renderAgain) return; // stale: newer settings are about to be rendered

  // Show the stage at 1:1 CSS px, sized to the capture box, with the export bounds outlined.
  preview.style.width = `${Math.ceil(box.x + box.width)}px`;
  preview.style.height = `${Math.ceil(box.y + box.height)}px`;
  Object.assign(outline.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px` });
  outline.hidden = false;
  lastBox = box;
  $('preview-error').hidden = true;
  const note = $('preview-note');
  note.textContent = Array.isArray(box.warnings) ? box.warnings.join(' ') : '';
  note.classList.toggle('warn', Boolean(note.textContent));
  updateExportInfo();
  root.dataset.preview = 'ready';
}

/** Resolves to the stage's API once the preview iframe has loaded it. */
function stageApi() {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    (function check() {
      let stage = null;
      try {
        stage = preview.contentWindow?.stage;
      } catch {
        // Not same-origin (should not happen): treated like a missing stage.
      }
      if (typeof stage?.render === 'function') resolve(stage);
      else if (performance.now() - started > STAGE_TIMEOUT_MS) reject(new Error('The preview page (src/stage/stage.html) did not load.'));
      else setTimeout(check, 30);
    })();
  });
}

function showPreviewError(message) {
  const box = $('preview-error');
  box.textContent = message;
  box.hidden = false;
  root.dataset.preview = 'error';
}

function updateExportInfo() {
  const scale = exportScale();
  $('export-size').textContent = lastBox
    ? `Export: ${Math.round(lastBox.width * scale)} × ${Math.round(lastBox.height * scale)} px at ${formatScale(scale)}×`
    : 'Rendering…';
}

// Re-render when the window moves to a display with another scale factor (the avatar size depends on it).
function watchPixelRatio() {
  matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener('change', () => {
    scheduleRender(0);
    watchPixelRatio();
  }, { once: true });
}

// ---- Form -----------------------------------------------------------------------------------------------

function buildControls() {
  const swatches = $('swatches');
  const swatch = (value, color, label, mark) => {
    const wrap = document.createElement('label');
    wrap.className = 'swatch';
    wrap.title = label;
    wrap.style.setProperty('--swatch', color);
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'avatarColor';
    input.value = value;
    input.setAttribute('aria-label', label);
    wrap.append(input);
    if (mark) {
      const span = document.createElement('span');
      span.className = 'auto-mark';
      span.textContent = mark;
      span.setAttribute('aria-hidden', 'true');
      wrap.append(span);
    }
    swatches.append(wrap);
    return wrap;
  };
  autoSwatch = swatch('auto', pickAvatarColor(state.name), 'Automatic colour (from the name)', 'A');
  DEFAULT_AVATAR_COLORS.forEach((color, i) => swatch(color, color, `${DEFAULT_AVATAR_COLOR_NAMES[i]} (${color})`));

  const presets = $('width-presets');
  for (const { width, title } of WIDTH_PRESETS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button small';
    button.textContent = String(width);
    button.title = title;
    button.setAttribute('aria-label', `${width} px: ${title}`);
    button.dataset.width = String(width);
    button.addEventListener('click', () => {
      state.rowWidth = width;
      $('row-width').value = String(width);
      changed();
    });
    presets.append(button);
  }

  const select = $('scale');
  select.append(new Option('', 'auto'));
  for (const scale of SCALES) select.append(new Option(`${formatScale(scale)}×`, String(scale)));
}

function setRadio(name, value) {
  for (const input of form.elements.namedItem(name) ?? []) input.checked = input.value === String(value);
}

function writeForm() {
  $('name').value = state.name;
  $('message').value = state.message;
  setRadio('avatarMode', state.avatarMode);
  setRadio('avatarColor', state.avatarColor);
  setRadio('role', state.role);
  setRadio('moderatorBadge', state.moderatorBadge);
  $('verified').checked = state.verified;
  setRadio('theme', state.theme);
  $('timestamp-on').checked = state.timestampOn;
  $('timestamp').value = state.timestamp;
  $('row-width').value = String(state.rowWidth);
  $('margin').value = String(state.margin);
  $('scale').value = String(state.scale);
}

/** Visibility and labels that follow the state. */
function syncUi() {
  $('avatar-default').hidden = state.avatarMode !== 'default';
  $('avatar-image').hidden = state.avatarMode !== 'image';
  $('avatar-none').hidden = state.avatarMode !== 'none';
  showThumb($('avatar-thumb'), $('avatar-remove'), state.avatarImage?.[64]);
  $('badge-field').hidden = state.role !== 'member';
  $('moderator-field').hidden = state.role !== 'moderator';
  showThumb($('badge-thumb'), $('badge-remove'), state.badgeImage?.[32]);
  autoSwatch?.style.setProperty('--swatch', pickAvatarColor(state.name));

  const length = [...state.message].length;
  const counter = $('counter');
  counter.textContent = `${length}/${MESSAGE_LIMIT}`;
  counter.classList.toggle('over', length > MESSAGE_LIMIT);

  $('timestamp').disabled = !state.timestampOn;
  for (const button of $('width-presets').children) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.width) === state.rowWidth));
  }
  $('scale').options[0].textContent = `Match display (${formatScale(clamp(displayScale, EXPORT_SCALE))}×)`;
  updateExportInfo();
}

function showThumb(img, removeButton, src) {
  img.hidden = !src;
  removeButton.hidden = !src;
  if (src) img.src = src;
  else img.removeAttribute('src');
}

function changed({ render = true } = {}) {
  syncUi();
  persist();
  if (render) scheduleRender();
}

function onFormEvent(event) {
  const target = event.target;
  const final = event.type === 'change';
  switch (target.name) {
    case 'name': state.name = target.value; break;
    case 'message': state.message = target.value; break;
    case 'avatarMode': state.avatarMode = target.value; break;
    case 'avatarColor': state.avatarColor = target.value; break;
    case 'role': state.role = target.value; break;
    case 'moderatorBadge': state.moderatorBadge = target.value; break;
    case 'verified': state.verified = target.checked; break;
    case 'theme': state.theme = target.value; break;
    case 'timestampOn': state.timestampOn = target.checked; break;
    case 'timestamp':
      state.timestamp = target.value;
      state.timestampAuto = false;
      break;
    case 'rowWidth':
    case 'margin': {
      // While typing, only accept values in range (so '1' on the way to '1000' does not jump); on
      // change, clamp and show the value actually used.
      const limits = target.name === 'rowWidth' ? ROW_WIDTH : MARGIN;
      const value = Math.round(target.valueAsNumber);
      if (!Number.isFinite(value)) {
        if (final) target.value = String(state[target.name]);
        return;
      }
      if (!final && (value < limits.min || value > limits.max)) return;
      state[target.name] = clamp(value, limits);
      if (final) target.value = String(state[target.name]);
      break;
    }
    case 'scale':
      state.scale = target.value === 'auto' ? 'auto' : Number(target.value);
      changed({ render: false });
      return;
    default:
      return;
  }
  changed();
}

// ---- Images ---------------------------------------------------------------------------------------------

async function useAvatarFile(file) {
  try {
    setStatus('', 'Reading the image…');
    state.avatarImage = await prepareAvatar(file);
    state.avatarMode = 'image';
    setRadio('avatarMode', 'image');
    setStatus('', '');
    changed();
  } catch (error) {
    setStatus('error', error.message);
  }
}

async function useBadgeFile(file) {
  try {
    setStatus('', 'Reading the badge…');
    state.badgeImage = await prepareBadge(file);
    setStatus('', '');
    changed();
  } catch (error) {
    setStatus('error', error.message);
  }
}

function wireFileInput(inputId, chooseId, use) {
  const input = $(inputId);
  $(chooseId).addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.value = ''; // so choosing the same file again still fires 'change'
    if (file) use(file);
  });
}

function wireDragAndDrop() {
  const overlay = $('drop-overlay');
  const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes('Files');
  let depth = 0;
  window.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth++;
    overlay.hidden = false;
  });
  window.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (event) => {
    if (!hasFiles(event)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) overlay.hidden = true;
  });
  window.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault(); // never let the window navigate to the file
    depth = 0;
    overlay.hidden = true;
    const files = [...event.dataTransfer.files];
    const file = files.find((f) => f.type.startsWith('image/')) ?? files[0];
    if (file) useAvatarFile(file);
  });
}

// ---- Export ---------------------------------------------------------------------------------------------

function setStatus(kind, text) {
  const status = $('status');
  status.className = `status${kind ? ` ${kind}` : ''}`;
  status.textContent = text;
}

/** IPC errors arrive as "Error invoking remote method 'x': Error: message"; keep the message. */
const cleanError = (error) => String(error?.message ?? error).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');
const withWarnings = (text, warnings) => (warnings?.length ? `${text}. ${warnings.join(' ')}` : text);

async function runExport(kind) {
  if (busy) return;
  if (!api) {
    setStatus('error', 'Saving and copying are only available in the desktop app.');
    return;
  }
  busy = true;
  $('save').disabled = true;
  $('copy').disabled = true;
  const scale = exportScale();
  setStatus('', kind === 'save' ? 'Rendering…' : 'Copying…');
  try {
    const props = await buildProps(scale);
    if (kind === 'save') {
      const result = await api.save(props, { scale });
      if (result.canceled) setStatus('', 'Save cancelled.');
      else setStatus('ok', withWarnings(`Saved ${result.width} × ${result.height} px → ${result.filePath}`, result.warnings));
    } else {
      const result = await api.copy(props, { scale });
      setStatus('ok', withWarnings(`Copied ${result.width} × ${result.height} px`, result.warnings));
    }
  } catch (error) {
    setStatus('error', cleanError(error));
  } finally {
    busy = false;
    $('save').disabled = false;
    $('copy').disabled = false;
  }
}

// ---- Start ----------------------------------------------------------------------------------------------

async function initDisplayScale() {
  if (!api) return;
  try {
    displayScale = await api.getDisplayScale();
  } catch {
    displayScale = window.devicePixelRatio;
  }
  api.onDisplayScaleChange((scale) => {
    displayScale = scale;
    syncUi();
  });
}

function start() {
  buildControls();
  writeForm();
  syncUi();

  form.addEventListener('submit', (event) => event.preventDefault());
  form.addEventListener('input', onFormEvent);
  form.addEventListener('change', onFormEvent);
  $('scale').addEventListener('change', onFormEvent); // lives in the export bar, outside the form
  $('timestamp-now').addEventListener('click', () => {
    state.timestamp = formatTime(new Date());
    state.timestampAuto = true;
    $('timestamp').value = state.timestamp;
    changed();
  });
  wireFileInput('avatar-file', 'avatar-choose', useAvatarFile);
  wireFileInput('badge-file', 'badge-choose', useBadgeFile);
  $('avatar-remove').addEventListener('click', () => {
    state.avatarImage = null;
    state.avatarMode = 'default';
    setRadio('avatarMode', 'default');
    changed();
  });
  $('badge-remove').addEventListener('click', () => {
    state.badgeImage = null;
    changed();
  });
  wireDragAndDrop();

  $('save').addEventListener('click', () => runExport('save'));
  $('copy').addEventListener('click', () => runExport('copy'));
  if (api) {
    api.onMenuCommand((command) => {
      if (command === 'save' || command === 'copy') runExport(command);
    });
  } else {
    setStatus('', 'Preview only: open the desktop app to save or copy.');
  }
  window.addEventListener('pagehide', persistNow);

  preview.addEventListener('load', () => scheduleRender(0));
  watchPixelRatio();
  setInterval(followClock, 10_000);
  initDisplayScale().then(syncUi);
  scheduleRender(0);
}

start();
