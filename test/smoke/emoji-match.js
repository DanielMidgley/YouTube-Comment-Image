// Smoke test for src/screenshot/emoji-match.js on real renders. Run: node scripts/electron.js test/smoke/emoji-match.js
//   --count=N        random emoji per scale and theme (default 160); --all: every emoji of the set (slow)
//   --seed=N         the random choice (default 1)
//   --scales=1,1.5   --themes=dark   a subset
//   --save=DIR       also write every capture there (PNG) with what is in it (JSON), for a closer look
// Renders live-chat rows of random emoji from YouTube's set through the stage page at seven scales in both
// themes, captures them as the export does, and recognises each emoji from an approximate ink box: the
// bounding box of the pixels 40+ levels off the background inside its cell, as src/screenshot/layout.js finds
// ink. Plain; from the box of its largest connected piece of ink only (what layout.js reports for an emoji in
// pieces); with every edge of the box moved by up to 2 px; from the capture JPEG-compressed at quality 80; and
// from the capture resampled by 1.1. Then renders rows of avatars, badges, text and custom channel emoji and
// checks that none of them comes within DECOY_MARGIN of being taken for an emoji, and prints how close both
// sides come to the limit (the answer's ratio: 1 is the line). The custom emoji are the same in every run,
// whatever --seed and --count: the hardest are near-uniform tiles in skin tones and emoji colours, which
// look most like YouTube's flat emoji (the skin-tone swatches, coloured squares and circles).
// Needs fonts.gstatic.com (the emoji images).
import { app, BrowserWindow, nativeImage, session } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appUrl, handleAppScheme, registerAppScheme } from '../../electron/protocol.js';
import { applyCaptureScale, captureRegion } from '../../electron/capture.js';
import { matchEmoji } from '../../src/screenshot/emoji-match.js';
import { EMOJI_SIGNATURES } from '../../src/screenshot/emoji-signatures.js';
import { YOUTUBE_EMOJI_CODES } from '../../src/comment/youtube-emoji.js';

const option = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1];
const ALL = process.argv.includes('--all');
const COUNT = Number(option('count') ?? 160);
const SEED = Number(option('seed') ?? 1);
const SCALES = (option('scales') ?? '1,1.25,1.5,1.75,2,2.5,3').split(',').map(Number);
const THEMES = (option('themes') ?? 'dark,light').split(',');
const SAVE = option('save');
const BACKGROUND = { dark: [0x0f, 0x0f, 0x0f], light: [0xff, 0xff, 0xff] };
const INK = 40; // as src/screenshot/layout.js: a channel 40+ levels off the background
const JITTER = 2;
const RESAMPLE = 1.1;
const JPEG_QUALITY = 80;
const ROW_WIDTH = 1000;
const PER_ROW = 300; // emoji per rendered row
// Accuracy required (top-1, share of emoji with visible ink): the target, and a little less where the
// screenshot itself has lost detail.
const REQUIRED = { plain: 0.97, component: 0.97, jitter: 0.97, jpeg: 0.95, resampled: 0.95 };
// Non-emoji are matched with this tolerance, so the report shows how close they come to being accepted
// (up to twice the limit), and each must stay this far beyond the limit: a little closer, and a slightly
// different render of it could be taken for an emoji.
const DECOY_TOLERANCE = 2;
const DECOY_MARGIN = 1.2;
const VARIANTS = Object.keys(REQUIRED);

const PROFILE_PREFIX = 'youtube-comment-emoji-smoke-';
for (const entry of fs.readdirSync(os.tmpdir())) {
  if (!entry.startsWith(PROFILE_PREFIX)) continue;
  try {
    const dir = path.join(os.tmpdir(), entry);
    if (Date.now() - fs.statSync(dir).mtimeMs > 10 * 60 * 1000) fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Still in use or already gone.
  }
}
registerAppScheme();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), PROFILE_PREFIX)));

const fromCode = (code) => String.fromCodePoint(...code.split('_').map((hex) => parseInt(hex, 16)));
const CODES = YOUTUBE_EMOJI_CODES.trim().split(/\s+/);
// Emoji that share an image (see scripts/update-emoji-signatures.js) count as recognised for each other.
const IMAGE_OF = new Map();
for (const line of EMOJI_SIGNATURES.trim().split('\n')) {
  const twins = line.split(' ')[0].split('=').map(fromCode);
  for (const emoji of twins) IMAGE_OF.set(emoji, twins[0]);
}
const sameImage = (a, b) => IMAGE_OF.get(a) === IMAGE_OF.get(b);

let failures = 0;
function check(ok, label) {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${label}`);
  return ok;
}

/** mulberry32: a small seeded generator, so a run can be repeated. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}
const rand = random(SEED);
const pickInt = (n) => Math.floor(rand() * n);

/** `count` different codes chosen at random (all of them with --all, shuffled). */
function sample(count) {
  const codes = [...CODES];
  for (let i = codes.length - 1; i > 0; i--) {
    const j = pickInt(i + 1);
    [codes[i], codes[j]] = [codes[j], codes[i]];
  }
  return ALL ? codes : codes.slice(0, count);
}

/** A nativeImage as { width, height, data: RGBA } (toBitmap() is BGRA). */
function rgbaOf(image) {
  const { width, height } = image.getSize();
  const data = image.toBitmap();
  for (let i = 0; i < data.length; i += 4) [data[i], data[i + 2]] = [data[i + 2], data[i]];
  return { width, height, data };
}

/** BGRA pixels from an (x, y) → [r, g, b, a] function, as a PNG data URL of size × size. */
function imageUrl(size, pixel) {
  const bgra = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b, a = 255] = pixel(x / size, y / size);
      bgra.set([b, g, r, a].map((v) => Math.max(0, Math.min(255, Math.round(v)))), (y * size + x) * 4);
    }
  }
  return nativeImage.createFromBitmap(bgra, { width: size, height: size }).toDataURL();
}

const colour = (next = rand) => [0, 0, 0].map(() => Math.floor(next() * 256));

/** Something like a photo: a few soft blobs of colour over another. */
function photoLike(next = rand) {
  const base = colour(next);
  const blobs = Array.from({ length: 4 }, () => ({ x: next(), y: next(), r: 0.15 + next() * 0.3, c: colour(next) }));
  return (x, y) => blobs.reduce((rgb, blob) => {
    const w = Math.exp(-((x - blob.x) ** 2 + (y - blob.y) ** 2) / (2 * blob.r ** 2));
    return rgb.map((v, i) => v * (1 - w) + blob.c[i] * w);
  }, base);
}

// Colours like other emoji sets' skin tones and coloured shapes, and a common skin-tone palette: what a
// channel's own flat emoji could be drawn in, close to YouTube's flat emoji but not the same.
const hex = (code) => [0, 2, 4].map((i) => parseInt(code.slice(i, i + 2), 16));
const SKIN_TONES = ['f7dece', 'f3d2a2', 'd5ab88', 'af7e57', '7c533e', 'ffdbac', 'f1c27d', 'e0ac69', 'c68642', '8d5524'].map(hex);
const EMOJI_COLOURS = ['dd2e44', 'f4900c', 'fdcb58', '78b159', '55acee', 'aa8ed6', 'c1694f', '292f33', 'e6e7e8', 'ffcc4d'].map(hex);

/**
 * Images a channel might use as custom emoji (none of them one of YouTube's), 64 px, some transparent, and
 * the same in every run (they have a generator of their own): flat and near-flat squares and flat discs in
 * the colours above, and a few busier images.
 */
function customEmojiImages() {
  const next = random(0x5eed);
  const shade = (rgb, by) => rgb.map((v) => v + by);
  const checkerboard = (a, b) => imageUrl(64, (x, y) => ((Math.floor(x * 8) + Math.floor(y * 8)) % 2 ? a : b));
  const inCircle = (x, y) => (x - 0.5) ** 2 + (y - 0.5) ** 2 < 0.22;
  const images = [];
  for (const rgb of [...SKIN_TONES, ...EMOJI_COLOURS]) {
    images.push(imageUrl(64, () => rgb)); // a flat square
    images.push(checkerboard(shade(rgb, 3), shade(rgb, -3))); // a near-flat one
    images.push(imageUrl(64, (x, y) => (inCircle(x, y) ? rgb : [0, 0, 0, 0]))); // a disc
  }
  for (const rgb of SKIN_TONES) {
    images.push(imageUrl(64, (x, y) => shade(rgb, 16 * y - 8))); // a gentle gradient
    images.push(imageUrl(64, () => shade(rgb, Math.round(8 * next() - 4)))); // faint noise
  }
  // Two browns 6 levels apart: the near-flat tile that --seed=7 once drew and the matcher took for 🏾.
  images.push(checkerboard([166, 118, 63], [160, 115, 65]));
  const [a, b] = [colour(next), colour(next)];
  const photo = photoLike(next);
  images.push(
    checkerboard(a, b),
    imageUrl(64, (x, y) => (inCircle(x, y) ? photo(x, y) : [0, 0, 0, 0])), // a round photo
    imageUrl(64, (x, y) => [...((x + y) % 0.25 < 0.125 ? a : b), 255]), // stripes
    imageUrl(64, () => colour(next)), // noise
    imageUrl(64, (x, y) => { // a logo: two bars on a rounded tile
      const tile = Math.max(Math.abs(x - 0.5), Math.abs(y - 0.5)) < 0.42;
      const bars = (y > 0.25 && y < 0.38 && x > 0.22 && x < 0.78) || (x > 0.44 && x < 0.56 && y > 0.25 && y < 0.78);
      return tile ? (bars ? [250, 250, 250] : a) : [0, 0, 0, 0];
    }),
  );
  return images;
}

// Invented names and words: nothing here is anyone's real comment.
const WORDS = ['maple', 'orbit', 'quartz', 'lantern', 'velvet', 'pixel', 'harbor', 'cobalt', 'drift', 'meadow',
  'ember', 'tundra', 'saffron', 'glyph', 'nimbus', 'cinder', 'willow', 'zephyr', 'basalt', 'fable', 'gg', 'lol', 'W'];
const NAMES = ['@QuillMarrow', '@Tessaline_77', '@brindle.fox', 'Orla Penhallow', '@VexHollow', '@nubbin_plays'];
const SEPARATORS = ['', '', ' ', ' ', '  ', ' ab ', ' x'];

async function openStage() {
  const ses = session.fromPartition('emoji-match-smoke'); // in memory: page zoom stays out of any profile
  handleAppScheme(ses);
  const win = new BrowserWindow({
    show: false, x: 0, y: 0, width: 640, height: 480, useContentSize: true, frame: false, skipTaskbar: true,
    paintWhenInitiallyHidden: true,
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  await win.loadURL(appUrl('src/stage/stage.html'));
  await win.webContents.executeJavaScript('new Promise((resolve) => { (function wait() { if (window.stage) resolve(); else setTimeout(wait, 20); })(); })');
  return win;
}

/** Renders `props` and returns the row's box and the CSS px rects of what `collect` (page-side) names. */
async function render(wc, props, collect) {
  const result = await wc.executeJavaScript(`window.stage.render(${JSON.stringify(props)}).then((box) => {
    const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    return { box: rect(document.querySelector('yt-live-chat-renderer')), warnings: box.warnings, parts: (${collect})(rect) };
  })`);
  if (result.warnings?.length) throw new Error(`The stage could not draw the row (offline?): ${result.warnings.join(' ')}`);
  return result;
}

let saved = 0;
async function capture(wc, box, scale, contents) {
  const shot = await captureRegion(wc, box, scale);
  if (SAVE) {
    fs.mkdirSync(SAVE, { recursive: true });
    const name = path.join(SAVE, `capture-${String(++saved).padStart(3, '0')}`);
    fs.writeFileSync(`${name}.png`, shot.png);
    fs.writeFileSync(`${name}.json`, JSON.stringify({ scale, crop: shot.crop, ...contents }));
  }
  return { image: nativeImage.createFromBuffer(shot.png), crop: shot.crop };
}

/** A CSS px rect of the page as the device px rect it covers in the capture. */
function deviceRect(rect, scale, crop) {
  const x = Math.round(rect.x * scale) - crop.x;
  const y = Math.round(rect.y * scale) - crop.y;
  return { x, y, width: Math.round((rect.x + rect.width) * scale) - crop.x - x, height: Math.round((rect.y + rect.height) * scale) - crop.y - y };
}

/**
 * The bounding box of the ink (a channel INK+ levels off `background`) in `area` of `image`, or with
 * `largestPiece`, of its tallest 8-connected piece; null if there is none.
 */
function inkBox(image, area, background, { largestPiece = false } = {}) {
  const x0 = Math.max(0, Math.floor(area.x));
  const y0 = Math.max(0, Math.floor(area.y));
  const x1 = Math.min(image.width, Math.ceil(area.x + area.width));
  const y1 = Math.min(image.height, Math.ceil(area.y + area.height));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return null;
  const ink = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((y0 + y) * image.width + x0 + x) * 4;
      ink[y * w + x] = [0, 1, 2].some((c) => Math.abs(image.data[i + c] - background[c]) >= INK) ? 1 : 0;
    }
  }
  const pieces = [];
  const seen = new Uint8Array(w * h);
  for (let start = 0; start < w * h; start++) {
    if (!ink[start] || seen[start]) continue;
    const piece = { left: w, top: h, right: -1, bottom: -1 };
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const p = stack.pop();
      const px = p % w;
      const py = (p - px) / w;
      Object.assign(piece, { left: Math.min(piece.left, px), right: Math.max(piece.right, px), top: Math.min(piece.top, py), bottom: Math.max(piece.bottom, py) });
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const qx = px + dx;
          const qy = py + dy;
          const q = qy * w + qx;
          if (qx >= 0 && qy >= 0 && qx < w && qy < h && ink[q] && !seen[q]) {
            seen[q] = 1;
            stack.push(q);
          }
        }
      }
    }
    pieces.push(piece);
  }
  if (!pieces.length) return null;
  const chosen = largestPiece
    ? pieces.reduce((a, b) => (b.bottom - b.top > a.bottom - a.top ? b : a))
    : pieces.reduce((a, b) => ({ left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) }));
  return { x: x0 + chosen.left, y: y0 + chosen.top, width: chosen.right - chosen.left + 1, height: chosen.bottom - chosen.top + 1 };
}

/** The most common colour of an image: the chat background (what a layout analysis would measure). */
function dominantColour({ data }) {
  const counts = new Map();
  for (let i = 0; i < data.length; i += 4 * 7) {
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const [key] = [...counts].reduce((a, b) => (b[1] > a[1] ? b : a));
  return [key >> 16, (key >> 8) & 255, key & 255];
}

const jitter = (box) => {
  const move = () => pickInt(2 * JITTER + 1) - JITTER;
  const left = box.x + move();
  const top = box.y + move();
  const right = box.x + box.width + move();
  const bottom = box.y + box.height + move();
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
};

// ---- Emoji ------------------------------------------------------------------------------------------
const tally = new Map(); // `${variant} ${theme}@${scale}` → { n, top1, top5, rejected }
const confusions = [];
const rightRatios = []; // the ratio (see matchEmoji) of every right answer: { ratio, variant, key, truth }
let invisible = 0;
const timing = { emoji: { ms: 0, n: 0 }, decoy: { ms: 0, n: 0 } };

function timedMatch(kind, image, options) {
  const t0 = performance.now();
  const result = matchEmoji(image, options);
  timing[kind].ms += performance.now() - t0;
  timing[kind].n++;
  return result;
}

/** Recognises one emoji crop, records how it went and returns the answer. */
function recognise(variant, key, truth, image, options) {
  const id = `${variant} ${key}`;
  if (!tally.has(id)) tally.set(id, { n: 0, top1: 0, top5: 0, rejected: 0 });
  const t = tally.get(id);
  t.n++;
  const result = timedMatch('emoji', image, options);
  if (!result) {
    t.rejected++;
    // How far over its limit it was, for the report.
    const best = matchEmoji(image, { ...options, tolerance: Infinity });
    if (sameImage(best.emoji, truth)) rightRatios.push({ ratio: best.ratio, variant, key, truth });
    confusions.push({ variant, key, truth, got: null, best });
    return result;
  }
  if (sameImage(result.emoji, truth)) {
    t.top1++;
    rightRatios.push({ ratio: result.ratio, variant, key, truth });
  } else {
    const truthScore = result.candidates.find((c) => sameImage(c.emoji, truth))?.score;
    confusions.push({ variant, key, truth, got: result.emoji, score: result.score, truthScore });
  }
  if (result.candidates.some((c) => sameImage(c.emoji, truth))) t.top5++;
  return result;
}

// The first row's capture and plain answers, to check that the renderer gives the same (see rendererSuite).
let rendererSample = null;
const RENDERER_SAMPLE = 40;

async function emojiSuite(win) {
  const wc = win.webContents;
  const avatarSrc = imageUrl(64, photoLike());
  for (const theme of THEMES) {
    for (const scale of SCALES) {
      const key = `${theme}@${scale}`;
      await applyCaptureScale(wc, scale);
      const codes = sample(COUNT);
      for (let from = 0; from < codes.length; from += PER_ROW) {
        const part = codes.slice(from, from + PER_ROW);
        const message = part.map((code) => SEPARATORS[pickInt(SEPARATORS.length)] + fromCode(code)).join('');
        const props = { name: NAMES[pickInt(NAMES.length)], message, theme, role: 'viewer', avatarSrc, rowWidth: ROW_WIDTH, margin: 0 };
        const row = await render(wc, props, `(rect) => [...document.querySelectorAll('#message img.emoji')].map(rect)`);
        if (row.parts.length !== part.length) throw new Error(`${key}: ${row.parts.length} emoji images for ${part.length} emoji.`);
        const { image, crop } = await capture(wc, row.box, scale, { theme, emoji: part, rects: row.parts });
        const plain = rgbaOf(image);
        const jpeg = rgbaOf(nativeImage.createFromBuffer(image.toJPEG(JPEG_QUALITY)));
        const size = image.getSize();
        const resized = image.resize({ width: Math.round(size.width * RESAMPLE), height: Math.round(size.height * RESAMPLE), quality: 'best' });
        const resampled = rgbaOf(resized);
        const fx = resampled.width / plain.width;
        const fy = resampled.height / plain.height;
        const background = BACKGROUND[theme];
        const jpegBackground = dominantColour(jpeg);
        const resampledBackground = dominantColour(resampled);
        const sampling = !rendererSample;
        if (sampling) rendererSample = { png: image.toPNG(), scale, background, items: [] };
        part.forEach((code, i) => {
          const truth = fromCode(code);
          const cell = deviceRect(row.parts[i], scale, crop);
          const box = inkBox(plain, cell, background);
          if (!box) {
            invisible++; // nothing 40 levels off the background: a layout analysis would not see it either
            return;
          }
          const answer = recognise('plain', key, truth, plain, { box, scale, background });
          if (sampling && rendererSample.items.length < RENDERER_SAMPLE) rendererSample.items.push({ box, answer });
          const piece = inkBox(plain, cell, background, { largestPiece: true });
          recognise('component', key, truth, plain, { box: piece, scale, background });
          recognise('jitter', key, truth, plain, { box: jitter(box), scale, background });
          const jpegBox = inkBox(jpeg, cell, jpegBackground);
          if (jpegBox) recognise('jpeg', key, truth, jpeg, { box: jpegBox, scale, background: jpegBackground });
          const scaledCell = { x: cell.x * fx, y: cell.y * fy, width: cell.width * fx, height: cell.height * fy };
          const resampledBox = inkBox(resampled, scaledCell, resampledBackground);
          if (resampledBox) recognise('resampled', key, truth, resampled, { box: resampledBox, scale: scale * fx, background: resampledBackground });
        });
      }
      const line = VARIANTS.map((variant) => {
        const t = tally.get(`${variant} ${key}`);
        return t ? `${variant} ${(100 * t.top1 / t.n).toFixed(1)}%` : `${variant} -`;
      }).join('  ');
      const plain = tally.get(`plain ${key}`);
      console.log(`  ${key.padEnd(11)} n=${String(plain?.n ?? 0).padEnd(5)} top-5 ${plain ? (100 * plain.top5 / plain.n).toFixed(1) : '-'}%  top-1: ${line}`);
    }
  }
}

/**
 * The matcher is meant for the renderer as much as for Node: decode the first row's capture in the page
 * (into ImageData, as a screenshot the user drops would arrive), import the module there and check that it
 * gives the same answers as it did here.
 */
async function rendererSuite(win) {
  const { png, scale, background, items } = rendererSample;
  const page = await win.webContents.executeJavaScript(`(async () => {
    const { matchEmoji } = await import('/src/screenshot/emoji-match.js');
    const img = new Image();
    img.src = 'data:image/png;base64,${png.toString('base64')}';
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const context = canvas.getContext('2d');
    context.drawImage(img, 0, 0);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const started = performance.now();
    const answers = ${JSON.stringify(items.map((item) => item.box))}.map((box) => {
      const answer = matchEmoji(image, { box, scale: ${scale}, background: ${JSON.stringify(background)} });
      return answer && { emoji: answer.emoji, score: answer.score, ratio: answer.ratio, box: answer.box };
    });
    return { answers, ms: (performance.now() - started) / answers.length };
  })()`);
  const differing = items.filter(({ answer }, i) => {
    const there = page.answers[i];
    return !answer !== !there || (answer && (answer.emoji !== there.emoji || Math.abs(answer.score - there.score) > 1e-9
      || Math.abs(answer.ratio - there.ratio) > 1e-9 || JSON.stringify(answer.box) !== JSON.stringify(there.box)));
  });
  check(items.length > 0 && differing.length === 0,
    `in the renderer, on ImageData: the same answers for ${items.length} emoji (${differing.length} differ; ${page.ms.toFixed(1)} ms per match)`);
}

// ---- Things that are not emoji ------------------------------------------------------------------------
const decoys = []; // { kind, key, ratio (the answer's, Infinity beyond DECOY_TOLERANCE), emoji, score }

async function decoySuite(win) {
  const wc = win.webContents;
  const memberBadge = appUrl('test/visual/fixtures/member-badge-32.png');
  // Default letter avatars, made by the app's own avatar code in the page.
  const letterAvatars = await wc.executeJavaScript(`import('/src/comment/avatar.js').then((m) => Promise.all(
    ${JSON.stringify(NAMES)}.map((name) => m.makeDefaultAvatar({ name, size: 64 }))))`);
  const rows = [
    { role: 'moderator', verified: true, moderatorBadge: 'shield' },
    { role: 'moderator', moderatorBadge: 'wrench' },
    { role: 'member', memberBadgeSrc: memberBadge },
    { role: 'owner', verified: true },
    { role: 'viewer', verified: true },
  ];
  // Every custom emoji at every scale and theme, shared out between the rows, each standing in for an emoji
  // of the message (the stage draws an emoji's image from emojiOverrides when it has one).
  const custom = customEmojiImages();
  const standIns = CODES.filter((code) => /^1f[0-9a-f]{3}$/.test(code)).map(fromCode);
  for (const theme of THEMES) {
    for (const scale of SCALES) {
      const key = `${theme}@${scale}`;
      await applyCaptureScale(wc, scale);
      for (const [index, extra] of rows.entries()) {
        const images = custom.filter((_, i) => i % rows.length === index);
        const stand = standIns.slice(0, images.length);
        const emojiOverrides = Object.fromEntries(stand.map((emoji, i) => [emoji, images[i]]));
        const words = Array.from({ length: 14 }, () => WORDS[pickInt(WORDS.length)]);
        const message = `${words.slice(0, 7).join(' ')} ${stand.join(' ')} ${words.slice(7).join(' ')}`;
        const avatarSrc = index % 2 ? imageUrl(64, photoLike()) : letterAvatars[pickInt(letterAvatars.length)];
        const props = { name: NAMES[pickInt(NAMES.length)], message, theme, avatarSrc, rowWidth: 400, margin: 0, emojiOverrides, ...extra };
        const row = await render(wc, props, `(rect) => {
          const words = [];
          for (const root of [document.querySelector('#author-name'), document.querySelector('#message')]) {
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            for (let node; (node = walker.nextNode());) {
              for (const match of node.data.matchAll(/\\S+/g)) {
                const range = document.createRange();
                range.setStart(node, match.index);
                range.setEnd(node, match.index + match[0].length);
                words.push(rect(range));
              }
            }
          }
          return {
            avatar: [rect(document.querySelector('#author-photo'))],
            badge: [...document.querySelectorAll('yt-live-chat-author-badge-renderer')].map(rect),
            chip: document.querySelector('yt-live-chat-author-chip[is-highlighted]') ? [rect(document.querySelector('#author-name'))] : [],
            custom: [...document.querySelectorAll('#message img.emoji')].map(rect),
            word: words,
          };
        }`);
        const { image, crop } = await capture(wc, row.box, scale, { theme, decoys: row.parts });
        const shot = rgbaOf(image);
        const background = BACKGROUND[theme];
        const tryDecoy = (kind, area) => {
          const box = inkBox(shot, area, background);
          if (!box) return;
          const result = timedMatch('decoy', shot, { box, scale, background, tolerance: DECOY_TOLERANCE });
          decoys.push({ kind, key, ratio: result ? result.ratio : Infinity, emoji: result?.emoji, score: result?.score });
        };
        for (const [kind, rects] of Object.entries(row.parts)) {
          for (const rect of rects) {
            const area = deviceRect(rect, scale, crop);
            tryDecoy(kind, area);
            // A window of text about an emoji wide, as a layout analysis might cut a run of letters.
            if (kind === 'word') tryDecoy('text window', { ...area, width: Math.max(area.width, 24 * scale) });
          }
        }
      }
    }
  }
}

// ---- Report -----------------------------------------------------------------------------------------
function report() {
  console.log('\n== Recognition (top-1 among emoji with visible ink; twins count as right)');
  for (const variant of VARIANTS) {
    let n = 0;
    let top1 = 0;
    let top5 = 0;
    let rejected = 0;
    for (const [id, t] of tally) {
      if (!id.startsWith(`${variant} `)) continue;
      n += t.n;
      top1 += t.top1;
      top5 += t.top5;
      rejected += t.rejected;
    }
    check(n > 0 && top1 / n >= REQUIRED[variant],
      `${variant.padEnd(9)} top-1 ${(100 * top1 / n).toFixed(2)}%  top-5 ${(100 * top5 / n).toFixed(2)}%  (${n} emoji, ${n - top1 - rejected} wrong, ${rejected} rejected; need ${100 * REQUIRED[variant]}%)`);
  }
  console.log(`        ${invisible} emoji had no ink ${INK}+ levels off the background (dark on the dark theme) and were skipped`);
  const perMatch = ({ ms, n }) => `${(ms / Math.max(1, n)).toFixed(1)} ms`;
  console.log(`        ${perMatch(timing.emoji)} per emoji matched (${timing.emoji.n}), ${perMatch(timing.decoy)} per non-emoji (${timing.decoy.n}, at tolerance ${DECOY_TOLERANCE})`);

  const shown = confusions.slice(0, 40);
  if (shown.length) {
    console.log(`\n-- Misses (${confusions.length}; first ${shown.length}): truth → result (score; the truth's score among the candidates)`);
    for (const c of shown) {
      const detail = c.got
        ? `${c.got} (${c.score.toFixed(2)}; ${c.truthScore?.toFixed(2) ?? 'not a candidate'})`
        : `rejected (best: ${c.best.emoji}, ${c.best.ratio.toFixed(2)} × the limit; score ${c.best.score.toFixed(2)}, limit ${c.best.limit.toFixed(2)})`;
      console.log(`        ${c.variant.padEnd(9)} ${c.key.padEnd(11)} ${c.truth} → ${detail}`);
    }
  }

  console.log('\n== Not emoji (avatars, badges, owner chips, custom emoji, words, text windows)');
  for (const kind of [...new Set(decoys.map((d) => d.kind))]) {
    const ofKind = decoys.filter((d) => d.kind === kind);
    const accepted = ofKind.filter((d) => d.ratio <= 1);
    const near = ofKind.filter((d) => d.ratio < DECOY_MARGIN);
    const closest = ofKind.reduce((a, b) => (b.ratio < a.ratio ? b : a));
    const nearest = Number.isFinite(closest.ratio) ? `${closest.ratio.toFixed(2)} × the limit (${closest.emoji} at ${closest.key})` : `over ${DECOY_TOLERANCE} × the limit`;
    check(near.length === 0, `${kind.padEnd(11)} ${ofKind.length} crops, ${accepted.length} taken for emoji, ${near.length} within ${DECOY_MARGIN} × the limit; the closest came within ${nearest}`);
    for (const d of near.slice(0, 5)) console.log(`        ${d.ratio <= 1 ? 'accepted' : 'too near'}: ${d.kind} at ${d.key} as ${d.emoji} (${d.score.toFixed(2)}, ${d.ratio.toFixed(2)} × the limit)`);
  }

  // The limit has to sit between the right answers and everything else.
  const ratios = rightRatios.map((r) => r.ratio).sort((a, b) => a - b);
  const at = (p) => ratios[Math.min(ratios.length - 1, Math.floor(p * ratios.length))]?.toFixed(2);
  const worst = rightRatios.reduce((a, b) => (b.ratio > a.ratio ? b : a), { ratio: 0 });
  const nearest = decoys.reduce((a, b) => (b.ratio < a.ratio ? b : a), { ratio: Infinity });
  console.log(`\n== Ratio to the limit: right answers median ${at(0.5)}, 99th percentile ${at(0.99)}, 99.9th ${at(0.999)}, `
    + `worst ${worst.ratio.toFixed(2)} (${worst.truth} ${worst.variant} ${worst.key}); `
    + `the closest non-emoji ${nearest.ratio.toFixed(2)} (${nearest.kind} at ${nearest.key})`);
}

async function main() {
  await app.whenReady();
  const win = await openStage();
  const t0 = performance.now();
  console.log(`Electron ${process.versions.electron}; ${ALL ? 'every emoji' : `${COUNT} random emoji (seed ${SEED})`} per scale and theme`);
  console.log('\n== Emoji rows');
  await emojiSuite(win);
  console.log('\n== The matcher in the renderer');
  await rendererSuite(win);
  console.log('\n== Rows of things that are not emoji');
  await decoySuite(win);
  win.destroy();
  report();
  console.log(`\n${((performance.now() - t0) / 1000).toFixed(0)} s. ${failures ? `${failures} check(s) FAILED` : 'All emoji-match checks passed'}`);
  app.exit(failures ? 1 : 0);
}

app.on('window-all-closed', () => {});
main().catch((error) => {
  console.error(error);
  app.exit(1);
});
