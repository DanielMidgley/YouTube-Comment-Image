// Renders one chat row into the stage and reports the box to capture. Used by the editor's live preview
// (same-origin iframe) and by the main process's hidden capture window: window.stage.render(props).
import { rowHtml } from '../comment/render.js';

const IMAGE_TIMEOUT_MS = 8000;

const root = document.documentElement;
const app = document.querySelector('yt-live-chat-app');
const chat = document.querySelector('yt-live-chat-renderer');
const items = document.getElementById('items');

const clamp = (value, min, max, fallback) =>
  Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Number(value))) : fallback;

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function loadFonts(row) {
  const text = row.textContent;
  await Promise.all(['400 14px Roboto', '500 14px Roboto', '400 11px Roboto'].map((font) => document.fonts.load(font, text)));
  await document.fonts.ready;
}

/** Waits for every image; emoji that fail to download are swapped for text so the row still renders. */
async function loadImages(row, { skip = null } = {}) {
  const warnings = [];
  await Promise.all([...row.querySelectorAll('img')].filter((img) => img !== skip).map(async (img) => {
    try {
      await withTimeout(img.decode(), IMAGE_TIMEOUT_MS);
    } catch {
      if (img.classList.contains('emoji')) {
        const fallback = document.createElement('span');
        fallback.className = 'emoji-fallback';
        fallback.textContent = img.alt;
        img.replaceWith(fallback);
        warnings.push(`Emoji ${img.alt} could not be downloaded (offline?); it is drawn as text instead.`);
      } else {
        warnings.push(img.id === 'img' ? 'The avatar image could not be loaded.' : 'A badge image could not be loaded.');
      }
    }
  }));
  return warnings;
}

async function render(props = {}) {
  const dark = props.theme !== 'light';
  const hideAvatar = props.hideAvatar === true;
  const margin = clamp(props.margin, 0, 200, 0);
  root.toggleAttribute('dark', dark);
  app.toggleAttribute('dark', dark);
  root.toggleAttribute('data-hide-avatar', hideAvatar);
  chat.toggleAttribute('hide-timestamps', !props.timestamp);
  root.style.setProperty('--stage-row-width', `${clamp(props.rowWidth, 120, 2000, 385)}px`);
  root.style.setProperty('--stage-margin', `${margin}px`);

  items.innerHTML = rowHtml(props);
  const row = items.firstElementChild;
  const avatar = row.querySelector('#author-photo');
  await loadFonts(row);
  const warnings = await loadImages(row, { skip: hideAvatar ? avatar.querySelector('img') : null });
  await nextFrame();
  await nextFrame();

  const box = chat.getBoundingClientRect();
  let { x, width } = box;
  if (hideAvatar) {
    // Crop the avatar out, as a snip starting just right of it would: the row keeps YouTube's layout (and
    // so every line break), and the capture starts at the avatar's right edge, less the margin.
    const cut = avatar.getBoundingClientRect().right - margin - x;
    x += cut;
    width -= cut;
  }
  return { x, y: box.y, width, height: box.height, warnings };
}

window.stage = { render };
