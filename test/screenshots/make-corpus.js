// Builds a ground-truth corpus of YouTube live-chat comment screenshots, for developing and measuring the
// screenshot reader. Every image is drawn by the app's own renderer (the stage page, captured through
// electron/capture.js, which test/visual/golden.js proves pixel-identical to YouTube), so the exact text of
// each comment and the geometry of everything in it are known.
//
//   node scripts/electron.js test/screenshots/make-corpus.js [--count N] [--seed S] [--out DIR] [--jobs N] [--overlays N]
//       N synthetic cases (default 400) into DIR (default test/screenshots/corpus/, git-ignored)
//   node scripts/electron.js test/screenshots/make-corpus.js --fixtures
//       the small curated set committed in test/fixtures/screenshots/ for fast unit tests
//   node scripts/electron.js test/screenshots/make-corpus.js --real
//       the rows of the chat saved in yt_example_page/ (skipped if there is none), at 1, 1.25, 1.5 and 2×, into
//       test/screenshots/corpus-real/: git-ignored, and the only place real rows are ever written
//   --jobs N renders on N hidden windows at once (default 3); --overlays N draws N debug overlays into
//   DIR/debug/ (the fixtures' into the git-ignored test/screenshots/corpus/fixtures-debug/; not '--debug':
//   Electron reads that as a Node flag); --offline blocks the emoji downloads, to check the stage's text
//   fallback (what the app draws offline), which each case records in its notes.
//   Each value can also be given as --name=value, which a value with a colon needs (a seed like "run:2"):
//   Electron refuses to start, silently, when an argument that looks like a URL is followed by another.
//
// A seed always gives the same files, byte for byte, whatever --jobs is: each case is drawn as if in a fresh
// session (see ownPng). Every case is checked (validate.js) against the file written, and the run reports
// how many cases fall in each category.
//
// DIR/cases.json is an array of cases:
//   { id, file, width, height,
//     scale        device px per CSS px the rows were rendered at;
//     pixelScale   device px per CSS px in the final image (scale × the horizontal resample ratio);
//     transform    { jpegQuality, pad: { left, top, right, bottom }, resample, stack: { count, cutTop, cutBottom },
//                    avatarCut }: each null when not applied; pads, cuts and avatarCut (columns cut from the left)
//                    in device px of the render;
//     comments     every row visible in the image, top to bottom:
//                  [{ complete  false when an image edge cuts its timestamp, name, badges or message (the avatar
//                               may be cut or left out: snips do that);
//                     truth     { name, message, timestamp, theme, role, verified, moderatorBadge, avatar } as the
//                               image shows them: names and messages with CSS's collapsed spaces, messages without
//                               U+FE0F and with emoji as their characters; moderatorBadge 'shield' | 'wrench' for
//                               moderators, else null; avatar 'letter' | 'image' | 'none';
//                     props     the RenderProps rendered, avatarSrc / memberBadgeSrc as short labels;
//                     geometry  boxes { x, y, width, height } in device px of the final image, which may reach past
//                               its edges: row, avatar (null if hidden), timestamp (null if hidden), nameChip
//                               (#author-name: the owner chip's padding and the verified badge included), nameText
//                               (the name's text), badges [{ type, box }], message (#message), lines [{ box, text }]
//                               (each rendered line of the message and the text on it, emoji as characters), emoji
//                               [{ box, emoji }]. Text boxes are layout boxes (advance width × the font's ascent +
//                               descent), not ink bounds. }];
//     target       the index of the comment a reader should return: the first complete one;
//     tags         'key:value' labels to slice results by (theme, role, scale, transform, emoji, lines, …);
//     notes        anything unusual, e.g. an emoji that could not be downloaded and is drawn as text }
import { app, BrowserWindow, nativeImage, net, session } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { APP_ROOT, SCHEME, appUrl, handleAppScheme, registerAppScheme } from '../../electron/protocol.js';
import { applyCaptureScale, captureRegion } from '../../electron/capture.js';
import { avatarSizeFor, badgeSizeFor, pickAvatarColor } from '../../src/comment/avatar.js';
import { emojiUrl, splitEmoji } from '../../src/comment/emoji.js';
import { makeImageAvatar } from './avatars.js';
import { contentBoxes, insideImage, mapBoxes, overlapsImage, rounded, toDevice } from './geometry.js';
import {
  appMessage, appName, appTimestamp, caseTags, removeOverlays, removePreviousOutput, shownMessage, shownText, writeManifest,
} from './manifest.js';
import { drawOverlay } from './overlay.js';
import { planCorpus, planFixtures, planReal } from './plan.js';
import { createRng } from './random.js';
import { loadRealRows } from './real-rows.js';
import { collectGeometry, letterAvatar, measureBox, renderRows } from './stage-page.js';
import { applyTransforms } from './transforms.js';
import { BACKGROUND, validateCase } from './validate.js';

const argv = process.argv.slice(2);
const VALUE_OPTIONS = ['count', 'seed', 'out', 'jobs', 'overlays'];
const FLAGS = ['real', 'fixtures', 'offline'];

/** Stops before anything runs, for a mistake in the command line. */
function refuse(message) {
  console.error(message);
  process.exit(2);
}

// Anything else is refused rather than ignored: a typo (--cuont=2) would render the default 400 cases.
for (let i = 0; i < argv.length; i++) {
  const [, name, value] = /^--([^=]*)(?:=(.*))?$/s.exec(argv[i]) ?? [];
  if (VALUE_OPTIONS.includes(name)) {
    if (value === undefined) i++; // its value follows (option() checks it)
  } else if (!(FLAGS.includes(name) && value === undefined)) {
    refuse(`Unknown argument ${argv[i]}.`);
  }
}

/** The value of --name, given as --name=value or --name value; an empty or missing one is refused. */
const option = (name) => {
  const i = argv.findIndex((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  const value = argv[i] === `--${name}` ? argv[i + 1] : argv[i].slice(name.length + 3);
  if (!value || value.startsWith('--')) refuse(`--${name} needs a value.`);
  return value;
};
const flag = (name) => argv.includes(`--${name}`);

function whole(name, fallback, min) {
  const value = Number(option(name) ?? fallback);
  if (!Number.isInteger(value) || value < min) refuse(`--${name} must be a whole number of at least ${min}.`);
  return value;
}

const MODE = flag('real') ? 'real' : flag('fixtures') ? 'fixtures' : 'corpus';
// (Any --out at all, an empty one included: real rows go nowhere but their git-ignored folder.)
if (MODE === 'real' && argv.some((arg) => arg === '--out' || arg.startsWith('--out='))) {
  refuse('--real always writes to test/screenshots/corpus-real/ (git-ignored): real rows must not go anywhere else.');
}
const DEFAULT_DIRS = { corpus: 'test/screenshots/corpus', fixtures: 'test/fixtures/screenshots', real: 'test/screenshots/corpus-real' };
const OUT_DIR = path.resolve(APP_ROOT, MODE === 'real' ? DEFAULT_DIRS.real : option('out') ?? DEFAULT_DIRS[MODE]);
// Overlays of the committed fixtures go to the git-ignored corpus folder, never next to the fixtures.
const DEBUG_DIR = MODE === 'fixtures' && !option('out') ? path.join(APP_ROOT, 'test', 'screenshots', 'corpus', 'fixtures-debug') : path.join(OUT_DIR, 'debug');
const COUNT = whole('count', 400, 1);
const SEED = option('seed') ?? 'chat-corpus-1';
const JOBS = whole('jobs', 3, 1);
const DEBUG_COUNT = whole('overlays', MODE === 'fixtures' ? 20 : 10, 0);
const OFFLINE = flag('offline');
const STAGE_URL = appUrl('src/stage/stage.html');
// A case takes well under a second; this only catches a stage that stopped answering.
const CASE_TIMEOUT_MS = 60_000;
const VARIATION_SELECTOR = String.fromCharCode(0xfe0f);
const MEMBER_BADGE = (size) => `test/visual/fixtures/member-badge-${size}.png`;
// Cases with these tags are drawn as debug overlays first, so a few overlays cover the hard parts.
const OVERLAY_PRIORITY = ['transform:stack-cut', 'lines:4+', 'role:owner', 'transform:avatar-cut', 'transform:resample',
  'transform:jpeg', 'transform:pad', 'emoji:middle', 'avatar:none', 'role:moderator-wrench', 'scale:3', 'theme:light'];

// A throwaway profile per run (zoom levels and caches stay out of the app's own, whose single-instance lock
// the app may be holding). Chromium keeps it locked until exit, so each run removes older runs' leftovers.
const PROFILE_PREFIX = 'youtube-comment-corpus-';
for (const entry of fs.readdirSync(os.tmpdir())) {
  if (!entry.startsWith(PROFILE_PREFIX)) continue;
  const dir = path.join(os.tmpdir(), entry);
  try {
    if (Date.now() - fs.statSync(dir).mtimeMs > 10 * 60 * 1000) fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Still in use, or already gone.
  }
}
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), PROFILE_PREFIX)));
registerAppScheme();

// ---- Rendering --------------------------------------------------------------------------------------------

// Emoji images come from fonts.gstatic.com as in the app, but each is downloaded once per run and served from
// memory to every window, under the case's own URL (see ownUrl): no case waits on the network twice for one.
const emojiDownloads = new Map(); // URL without its query → Promise<{ status, type, bytes }>

async function emojiResponse(request) {
  const url = new URL(request.url);
  if (url.host !== 'fonts.gstatic.com') return net.fetch(request, { bypassCustomProtocolHandlers: true });
  if (OFFLINE) return new Response('Blocked by --offline', { status: 503 });
  const key = url.origin + url.pathname;
  if (!emojiDownloads.has(key)) {
    emojiDownloads.set(key, net.fetch(key, { bypassCustomProtocolHandlers: true }).then(async (response) => ({
      status: response.status, type: response.headers.get('content-type') ?? 'image/png', bytes: Buffer.from(await response.arrayBuffer()),
    })));
  }
  try {
    const { status, type, bytes } = await emojiDownloads.get(key);
    return new Response(bytes, { status, headers: { 'content-type': type } });
  } catch (error) {
    emojiDownloads.delete(key); // a later case may try again; this one falls back to text, as the app does
    return new Response(`Could not download ${key}: ${error.message}`, { status: 502 });
  }
}

/**
 * A hidden window showing the stage, like capture.js's own: each in its own in-memory partition, because page
 * zoom (the capture scale) is shared by every page of a host within a session.
 */
async function openWorker(index) {
  const ses = session.fromPartition(`screenshot-corpus-${index}`);
  if (!ses.protocol.isProtocolHandled(SCHEME)) {
    handleAppScheme(ses);
    ses.protocol.handle('https', emojiResponse);
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
  }
  const win = new BrowserWindow({
    show: false, x: 0, y: 0, width: 640, height: 480, useContentSize: true, frame: false, skipTaskbar: true,
    paintWhenInitiallyHidden: true,
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, backgroundThrottling: false, spellcheck: false },
  });
  // executeJavaScript never settles once the renderer is gone, so whatever waits on the page races this
  // (as capture.js does): a crash fails the case at once, and makeCase retries it in a fresh window.
  const gone = new Promise((_, reject) => {
    win.webContents.once('render-process-gone', (_event, details) => reject(new Error(`the stage page stopped (${details.reason})`)));
    win.once('closed', () => reject(new Error('the stage window was closed')));
  });
  gone.catch(() => {}); // only meaningful while something waits on it
  await Promise.race([win.loadURL(STAGE_URL), gone]);
  const ready = await Promise.race([win.webContents.executeJavaScript(`new Promise((resolve) => {
    const started = performance.now();
    (function check() {
      if (typeof window.stage?.render === 'function') resolve(true);
      else if (performance.now() - started > 5000) resolve(false);
      else setTimeout(check, 25);
    })();
  })`), gone]);
  if (!ready) throw new Error(`${STAGE_URL} does not expose window.stage.render().`);
  return { index, win, wc: win.webContents, gone };
}

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Runs one of stage-page.js's functions in the page; a rejection keeps its message. */
async function inPage(wc, fn, ...args) {
  const result = await wc.executeJavaScript(`Promise.resolve().then(() => (${fn})(...${JSON.stringify(args)})).then(
    (value) => ({ ok: true, value }), (error) => ({ ok: false, message: String(error && error.message || error) }))`, true);
  if (!result?.ok) throw new Error(`${fn.name} failed in the stage page: ${result?.message ?? 'no result'}`);
  return result.value;
}

// Chromium keeps decoded images per URL, and how it scales one down can depend on what it drew from that image
// before (a few pixels one level off). So every image a case shows gets a URL no other case uses, and each
// case is drawn as the app draws it in a fresh session, whatever was rendered before it: the avatar carries a
// PNG text chunk naming the case, the member badge and emoji a query string their servers ignore.

/** `dataUrl` (a PNG) with a tEXt chunk naming the case after its header: other bytes, the same pixels. */
function ownPng(dataUrl, caseId) {
  const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  const body = Buffer.concat([Buffer.from('Comment', 'latin1'), Buffer.from([0]), Buffer.from(`corpus case ${caseId}`, 'latin1')]);
  const chunk = Buffer.alloc(12 + body.length);
  chunk.writeUInt32BE(body.length, 0);
  chunk.write('tEXt', 4, 'latin1');
  body.copy(chunk, 8);
  chunk.writeUInt32BE(zlib.crc32(chunk.subarray(4, 8 + body.length)), 8 + body.length);
  const afterHeader = 8 + 12 + png.readUInt32BE(8); // the signature, then IHDR's length, type, data and CRC
  return `data:image/png;base64,${Buffer.concat([png.subarray(0, afterHeader), chunk, png.subarray(afterHeader)]).toString('base64')}`;
}

const ownUrl = (url, caseId) => `${url}?case=${encodeURIComponent(caseId)}`;

/** The avatar image YouTube would serve at this scale (32 or 64 px), with a short label for the manifest. */
async function avatarFor(worker, row, plan) {
  const size = avatarSizeFor(plan.scale);
  if (row.avatar.kind === 'letter') {
    const color = row.avatar.color ?? pickAvatarColor(row.name);
    const src = await inPage(worker.wc, letterAvatar, row.name, color, size);
    return { src: ownPng(src, plan.id), label: `letter:${color}:${size}px` };
  }
  if (row.avatar.kind === 'image') {
    const { style, seed } = row.avatar;
    const { bgra } = makeImageAvatar(createRng(`avatar:${style}:${seed}`), size, style);
    const src = nativeImage.createFromBitmap(bgra, { width: size, height: size }).toDataURL();
    return { src: ownPng(src, plan.id), label: `image:${style}-${seed}:${size}px` };
  }
  return { src: null, label: null };
}

/** RenderProps as the editor builds them (src/editor/editor.js buildProps), member badge sized as golden.js does. */
function propsFor(plan, row, avatar) {
  const message = appMessage(row.message);
  const emoji = splitEmoji(message).filter((run) => run.type === 'emoji').map((run) => run.emoji);
  return {
    name: appName(row.name),
    message,
    theme: plan.theme,
    role: row.role,
    verified: row.verified,
    moderatorBadge: row.moderatorBadge,
    hideAvatar: plan.hideAvatar,
    avatarSrc: avatar.src,
    memberBadgeSrc: row.role === 'member' && row.memberBadge ? ownUrl(appUrl(MEMBER_BADGE(badgeSizeFor(plan.scale))), plan.id) : null,
    timestamp: appTimestamp(row.timestamp),
    rowWidth: plan.rowWidth,
    margin: plan.margin,
    // render.js's hook for emoji image URLs: the usual Noto URLs, made the case's own.
    emojiOverrides: Object.fromEntries(emoji.map((e) => [e, ownUrl(emojiUrl(e), plan.id)])),
  };
}

const sameBox = (a, b) => ['x', 'y', 'width', 'height'].every((k) => Math.abs(a[k] - b[k]) < 1e-6);

/** Renders and captures a plan's rows: the PNG, its crop, and each row's geometry in CSS px. */
async function render(worker, plan) {
  const { wc } = worker;
  await applyCaptureScale(wc, plan.scale); // lay out at the scale it is captured at
  const avatars = [];
  for (const row of plan.rows) avatars.push(await avatarFor(worker, row, plan));
  const propsList = plan.rows.map((row, i) => propsFor(plan, row, avatars[i]));
  const { box, warnings } = await inPage(wc, renderRows, propsList);
  const shot = await captureRegion(wc, box, plan.scale);
  // Measured after capturing, which may have grown the window: the layout must not have moved meanwhile.
  if (!sameBox(await inPage(wc, measureBox), box)) throw new Error('the layout changed while it was captured');
  const css = await inPage(wc, collectGeometry);
  if (css.length !== plan.rows.length) throw new Error(`rendered ${css.length} rows instead of ${plan.rows.length}`);
  return { avatars, propsList, warnings, shot, css };
}

function decode(bytes) {
  const image = nativeImage.createFromBuffer(bytes);
  const { width, height } = image.getSize();
  return { width, height, data: image.toBitmap() };
}

/** High-quality resampling (Skia's best filter), as an image editor or chat app rescales a screenshot. */
function resize(bitmap, width, height) {
  const image = nativeImage.createFromBitmap(bitmap.data, { width: bitmap.width, height: bitmap.height })
    .resize({ width, height, quality: 'best' });
  return { ...image.getSize(), data: image.toBitmap() };
}

const hasTransform = (transform) => Object.values(transform).some((value) => value != null);

/** Turns a rendered plan into its image file and manifest entry. */
function finishCase(plan, { avatars, propsList, warnings, shot, css }) {
  const notes = [...warnings];
  if (!shot.stable) notes.push('The capture was still changing after 1.5 s; the latest frame was used.');
  const device = css.map((geometry) => mapBoxes(geometry, toDevice(plan.scale, shot.crop)));
  const result = applyTransforms(decode(shot.png), device, plan, { background: BACKGROUND[plan.theme], resize });
  const { width, height } = result.bitmap;

  const comments = [];
  result.geometries.forEach((full, i) => {
    if (!overlapsImage(full.row, width, height)) return;
    const geometry = mapBoxes(full, rounded);
    const { emojiOverrides, ...props } = propsList[i]; // the overrides only make the URLs the case's own
    const truth = {
      name: shownText(props.name),
      message: shownMessage(props.message),
      timestamp: shownText(props.timestamp),
      theme: plan.theme,
      role: props.role,
      verified: props.verified,
      moderatorBadge: props.role === 'moderator' ? props.moderatorBadge : null,
      avatar: plan.rows[i].avatar.kind,
    };
    if (css[i].nameLines > 1) notes.push(`Row ${i}: the name wraps onto ${css[i].nameLines} lines.`);
    if (truth.name !== props.name || truth.message !== props.message.replaceAll(VARIATION_SELECTOR, '')) {
      notes.push(`Row ${i}: the truth has the message's or name's spaces collapsed, as CSS shows them.`);
    }
    if (plan.rows[i].meta?.customEmoji) notes.push(`Row ${i}: ${plan.rows[i].meta.customEmoji} custom emoji of the saved row are drawn as their alt text.`);
    comments.push({
      rowIndex: i,
      complete: contentBoxes(geometry).every((box) => insideImage(box, width, height)),
      truth,
      props: {
        ...props,
        avatarSrc: avatars[i].label,
        memberBadgeSrc: props.memberBadgeSrc ? path.basename(MEMBER_BADGE(badgeSizeFor(plan.scale))) : null,
      },
      geometry,
    });
  });
  const target = comments.findIndex((comment) => comment.complete);
  if (target < 0) throw new Error('no comment is wholly inside the image');

  // The app's own export, untouched, when nothing was done to it; otherwise re-encoded.
  const exact = plan.rows.length === 1 && !hasTransform(result.transform);
  const jpeg = result.transform.jpegQuality != null;
  const image = nativeImage.createFromBitmap(result.bitmap.data, { width, height });
  const bytes = exact ? shot.png : jpeg ? image.toJPEG(result.transform.jpegQuality) : image.toPNG();
  const entry = {
    id: plan.id,
    file: `${plan.id}.${jpeg ? 'jpg' : 'png'}`,
    width,
    height,
    scale: plan.scale,
    pixelScale: Math.round(plan.scale * result.resampleX * 10000) / 10000,
    transform: result.transform,
    comments: comments.map(({ rowIndex, ...comment }) => comment),
    target,
    tags: [],
    notes,
  };
  entry.tags = caseTags(plan, entry, plan.rows[comments[target].rowIndex]);
  return { entry, bytes };
}

async function makeCase(workers, slot, plan) {
  for (let attempt = 1; ; attempt++) {
    try {
      const worker = workers[slot];
      return finishCase(plan, await withTimeout(Promise.race([render(worker, plan), worker.gone]), CASE_TIMEOUT_MS, 'rendering'));
    } catch (error) {
      if (attempt >= 2) throw new Error(`${plan.id}: ${error.message}`);
      console.warn(`  ${plan.id}: ${error.message}; retrying in a fresh window`);
      if (!workers[slot].win.isDestroyed()) workers[slot].win.destroy();
      workers[slot] = await openWorker(slot);
    }
  }
}

// ---- Report -------------------------------------------------------------------------------------------------

/** A few cases to draw overlays of: the first case of each priority tag, then evenly spread others. */
function pickOverlays(entries, count) {
  const picked = new Set();
  for (const tag of OVERLAY_PRIORITY) {
    if (picked.size >= count) break;
    const entry = entries.find((e) => e.tags.includes(tag) && !picked.has(e));
    if (entry) picked.add(entry);
  }
  for (let i = 0; picked.size < Math.min(count, entries.length); i++) {
    picked.add(entries[Math.floor((i * entries.length) / count) % entries.length]);
    if (i > entries.length * 2) break;
  }
  return [...picked];
}

function printCategories(entries) {
  const groups = new Map();
  for (const entry of entries) {
    for (const tag of entry.tags) {
      const [key, value] = tag.split(/:(.*)/s);
      if (!groups.has(key)) groups.set(key, new Map());
      groups.get(key).set(value, (groups.get(key).get(value) ?? 0) + 1);
    }
  }
  console.log('\nCases per category (of the target comment; transforms may combine):');
  for (const [key, values] of groups) {
    const sorted = [...values].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }));
    console.log(`  ${key.padEnd(10)} ${sorted.map(([value, n]) => `${value} ${n}`).join(' · ')}`);
  }
  const comments = entries.flatMap((e) => e.comments);
  console.log(`  comments   ${comments.length} rows in ${entries.length} images (${comments.filter((c) => c.complete).length} complete, ${comments.filter((c) => !c.complete).length} cut by an edge)`);
}

// ---- Main ----------------------------------------------------------------------------------------------------

async function main() {
  const started = performance.now();
  let plans;
  if (MODE === 'real') {
    const real = await loadRealRows(path.join(APP_ROOT, 'yt_example_page'));
    if (!real) {
      console.log('SKIP: no saved YouTube live-chat page under yt_example_page/ (see README: Tests).');
      return 0;
    }
    console.log(`Read ${real.rows.length} chat rows from the saved page.`);
    plans = planReal(real.rows, { seed: SEED });
  } else {
    plans = MODE === 'fixtures' ? planFixtures() : planCorpus({ count: COUNT, seed: SEED });
  }
  console.log(`Rendering ${plans.length} ${MODE} cases into ${path.relative(APP_ROOT, OUT_DIR)}/ on ${Math.min(JOBS, plans.length)} hidden window(s)…`);

  // Everything is rendered before anything is written, so a failed run leaves the previous output intact.
  const workers = await Promise.all(Array.from({ length: Math.min(JOBS, plans.length) }, (_, i) => openWorker(i)));
  const results = new Array(plans.length);
  let next = 0;
  let done = 0;
  await Promise.all(workers.map(async (_, slot) => {
    while (next < plans.length) {
      const index = next++;
      results[index] = await makeCase(workers, slot, plans[index]);
      if (++done % 50 === 0 || done === plans.length) console.log(`  ${done}/${plans.length} (${((performance.now() - started) / 1000).toFixed(1)} s)`);
    }
  }));
  for (const worker of workers) if (!worker.win.isDestroyed()) worker.win.destroy();
  const renderSeconds = (performance.now() - started) / 1000;

  const entries = results.map((r) => r.entry);
  if (MODE === 'fixtures') {
    const fallback = entries.filter((e) => e.comments.some((c) => c.geometry.emoji.some((item) => item.fallback)));
    if (fallback.length) throw new Error(`Emoji could not be downloaded for ${fallback.map((e) => e.id).join(', ')}; fixtures must show the real emoji images.`);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  removePreviousOutput(OUT_DIR);
  removeOverlays(DEBUG_DIR);
  for (const { entry, bytes } of results) fs.writeFileSync(path.join(OUT_DIR, entry.file), bytes);
  writeManifest(OUT_DIR, entries);

  // Validate every case against the file actually written (JPEG decoded back, not the bitmap it came from).
  let problemCount = 0;
  for (const entry of entries) {
    const problems = validateCase(entry, decode(fs.readFileSync(path.join(OUT_DIR, entry.file))));
    problemCount += problems.length;
    for (const problem of problems) console.log(`  PROBLEM ${entry.id}: ${problem}`);
  }

  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const overlays = pickOverlays(entries, DEBUG_COUNT);
  for (const entry of overlays) {
    const overlay = drawOverlay(decode(fs.readFileSync(path.join(OUT_DIR, entry.file))), entry);
    fs.writeFileSync(path.join(DEBUG_DIR, `${entry.id}.png`), nativeImage.createFromBitmap(overlay.data, { width: overlay.width, height: overlay.height }).toPNG());
  }

  printCategories(entries);
  const noted = entries.filter((e) => e.notes.length);
  if (noted.length) {
    const kinds = new Map();
    for (const note of noted.flatMap((e) => e.notes)) {
      const kind = note.replace(/^Row \d+: /, '').replace(/Emoji .* could not/, 'Emoji … could not').replace(/\d+/g, 'N');
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    }
    console.log(`\nNotes in ${noted.length} case(s):`);
    for (const [kind, n] of kinds) console.log(`  ${n}× ${kind}`);
  }
  const bytes = entries.reduce((sum, e) => sum + fs.statSync(path.join(OUT_DIR, e.file)).size, 0);
  console.log(`\n${entries.length} cases (${(bytes / 1024 / 1024).toFixed(2)} MB of images) and cases.json in ${OUT_DIR}`);
  console.log(`${overlays.length} debug overlays in ${DEBUG_DIR}`);
  console.log(`Rendered in ${renderSeconds.toFixed(1)} s (${((renderSeconds * 1000) / entries.length).toFixed(0)} ms per case), ${((performance.now() - started) / 1000).toFixed(1)} s in all.`);
  console.log(problemCount ? `\n${problemCount} validation problem(s).` : '\nAll cases passed validation.');
  return problemCount ? 1 : 0;
}

// Keep running while worker windows are replaced after a failure.
app.on('window-all-closed', () => {});
app.whenReady().then(main).then(
  (code) => app.exit(code),
  (error) => {
    console.error(error);
    app.exit(2);
  },
);
