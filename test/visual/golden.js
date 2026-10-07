// Golden test: renders real chat rows from the saved YouTube page (yt_example_page/, git-ignored) with
// YouTube's own markup and CSS, renders the same comments through the app (stage + capture path), and
// compares the PNGs pixel by pixel. Role/theme/timestamp variants that don't occur in the saved chat are
// made by editing a real row in place, so they are still drawn by YouTube's CSS. Both sides are captured
// by the same code (electron/capture.js), at each scale.
//
//   npm run test:visual [-- --only <case-name-substring>] [-- --scales 1,1.5]
//
// Images are written to test/visual/out/: <case>@<scale>x.youtube.png / .app.png / .diff.png (if different).
import { app, BrowserWindow, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { APP_ROOT, HOST, SCHEME, appUrl, fileResponse, registerAppScheme, resolveInside } from '../../electron/protocol.js';
import { applyCaptureScale, captureComment, captureRegion, disposeCapture } from '../../electron/capture.js';

// A YouTube watch page saved by a browser as "Webpage, Complete" into yt_example_page/ (git-ignored): the
// live chat's document is one of the saved_resource*.html files in the page's "<title>_files" folder, beside
// the chat stylesheet it links and YouTube's chat script.
const SAVED_PAGES = 'yt_example_page';
const SAVED = findSavedChat(path.join(APP_ROOT, SAVED_PAGES));
const OUT_DIR = path.join(APP_ROOT, 'test', 'visual', 'out');
const FONTS_DIR = path.join(APP_ROOT, 'src', 'assets', 'fonts');
const SCROLLBAR = 15; // the chat's item list always shows a 15px scrollbar beside the rows

// The saved page loads Roboto from //fonts.gstatic.com; under app:// that host is served from our copies.
const ROBOTO_V48 = {
  KFO7CnqEu92Fr1ME7kSn66aGLdTylUAMa3GUBGEe: 'cyrillic-ext', KFO7CnqEu92Fr1ME7kSn66aGLdTylUAMa3iUBGEe: 'cyrillic',
  KFO7CnqEu92Fr1ME7kSn66aGLdTylUAMa3CUBGEe: 'greek-ext', 'KFO7CnqEu92Fr1ME7kSn66aGLdTylUAMa3-UBGEe': 'greek',
  KFO7CnqEu92Fr1ME7kSn66aGLdTylUAMawCUBGEe: 'math', KFO7CnqEu92Fr1ME7kSn66aGLdTylUAMaxKUBGEe: 'symbols',
  KFO7CnqEu92Fr1ME7kSn66aGLdTylUAMa3OUBGEe: 'vietnamese', KFO7CnqEu92Fr1ME7kSn66aGLdTylUAMa3KUBGEe: 'latin-ext',
  KFO7CnqEu92Fr1ME7kSn66aGLdTylUAMa3yUBA: 'latin',
};

const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const ONLY = option('only');
const SCALES = (option('scales') ?? '1,1.25,1.5,2').split(',').map(Number);

// Each case starts from a real saved row (`row`: 1-based index, or `displayName`: the first row whose author
// shows a display name rather than an @handle, as some older accounts do) and optionally applies a
// variant. `chat` is the chat width in CSS px (rows are SCROLLBAR px narrower); 400 is YouTube's default.
const CASES = [
  { name: 'two-lines', row: 1 },
  { name: 'single-line', row: 3 },
  { name: 'three-lines', row: 4 },
  { name: 'long-message', row: 13 },
  { name: 'emoji-in-text', row: 11 },
  { name: 'two-emoji', row: 31 },
  { name: 'moderator', row: 17 },
  { name: 'display-name', displayName: true },
  { name: 'user-width-415', row: 13, chat: 415 },
  { name: 'narrow-340', row: 4, chat: 340 },
  { name: 'member', row: 3, variant: 'member' },
  { name: 'owner', row: 3, variant: 'owner' },
  { name: 'verified', row: 3, variant: 'verified' },
  { name: 'owner-verified', row: 3, variant: 'owner-verified' },
  { name: 'timestamp', row: 1, timestamp: true },
  { name: 'moderator-timestamp', row: 17, timestamp: true },
  { name: 'light-two-lines', row: 1, theme: 'light' },
  { name: 'light-moderator', row: 17, theme: 'light' },
  { name: 'light-owner-verified', row: 3, variant: 'owner-verified', theme: 'light' },
  { name: 'light-member-timestamp', row: 3, variant: 'member', theme: 'light', timestamp: true },
  // YouTube's classic moderator badge (its new-shield flag off): the wrench and the classic moderator blue.
  { name: 'moderator-classic', row: 17, variant: 'moderator-classic' },
  { name: 'light-moderator-classic-timestamp', row: 17, variant: 'moderator-classic', theme: 'light', timestamp: true },
  // No avatar: YouTube's row snipped from the avatar's right edge vs the app's hideAvatar export.
  { name: 'avatar-cropped', row: 1, cropAvatar: true },
  { name: 'avatar-cropped-emoji', row: 11, cropAvatar: true },
  { name: 'avatar-cropped-light-owner', row: 3, variant: 'owner-verified', theme: 'light', cropAvatar: true },
];

/** Light-theme values of YouTube's hashed colour tokens: the saved stylesheet is the dark build, whose
    :root block declares every token's light value first and then overrides it with the dark one. */
function lightTokens() {
  const css = fs.readFileSync(SAVED.css, 'utf8');
  const blocks = [...css.matchAll(/:root\{([^}]*)\}/g)].map((m) => m[1]);
  const tokens = {};
  for (const declaration of blocks.sort((a, b) => b.length - a.length)[0].split(';')) {
    const match = declaration.match(/^\s*(--t[0-9a-f]+)\s*:\s*(.+?)\s*$/);
    if (match && !(match[1] in tokens)) tokens[match[1]] = match[2];
  }
  return tokens;
}

/** YouTube's classic moderator icon ('live-chat-badges:moderator'), straight from the saved chat code. */
function findSavedChat(root) {
  if (!fs.existsSync(root)) return null;
  for (const folder of fs.readdirSync(root).filter((name) => name.endsWith('_files'))) {
    const dir = path.join(root, folder);
    for (const file of fs.readdirSync(dir).filter((name) => /^saved_resource.*\.html$/.test(name))) {
      const html = fs.readFileSync(path.join(dir, file), 'utf8');
      if (!html.includes('<yt-live-chat-text-message-renderer')) continue;
      const css = html.match(/href="\.\/(rs=[\w-]+)"/)?.[1];
      if (css) return { folder, file, css: path.join(dir, css), js: path.join(dir, 'live_chat_polymer.js.download') };
    }
  }
  return null;
}

function classicModeratorPath() {
  const js = fs.readFileSync(SAVED.js, 'utf8');
  const iconset = js.slice(js.indexOf('<iron-iconset-svg name=' + String.fromCharCode(92) + '"live-chat-badges'));
  return iconset.match(/<g id=\\"moderator\\"><path d=\\"([^\\]+)\\"/)[1];
}

/** Serves the saved page in its own session: fonts from our copies, and without YouTube's scripts (they
    would rebuild the saved DOM; with none at all, executeJavaScript and requestAnimationFrame still work). */
function serveSavedPage(ses) {
  ses.protocol.handle(SCHEME, async (request) => {
    const { host, pathname } = new URL(request.url);
    if (host === 'fonts.gstatic.com') {
      const subset = ROBOTO_V48[pathname.match(/^\/s\/roboto\/v48\/([\w-]+)\.woff2$/)?.[1]];
      return subset ? fileResponse(path.join(FONTS_DIR, `roboto-v48-${subset}.woff2`), request) : new Response('', { status: 404 });
    }
    const filePath = host === HOST && resolveInside(APP_ROOT, pathname);
    if (!filePath) return new Response('', { status: 404 });
    if (path.basename(filePath) === SAVED.file) {
      const html = fs.readFileSync(filePath, 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    return fileResponse(filePath, request);
  });
  // Everything is local: block the network so results never depend on it.
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
}

// ---- Page-side (runs in the saved page) -------------------------------------------------------------
function prepareCase(spec, lightTokenValues, rowWidth, memberBadgeUrl, classicModeratorPath) {
  const VERIFIED_PATH = 'M12,2C6.5,2,2,6.5,2,12c0,5.5,4.5,10,10,10s10-4.5,10-10C22,6.5,17.5,2,12,2z M9.8,17.3l-4.2-4.1L7,11.8l2.8,2.7L17,7.4 l1.4,1.4L9.8,17.3z';
  const BADGE = 'yt-live-chat-author-badge-renderer';
  const icon = (d) => `<yt-icon class="style-scope ${BADGE}"><span class="yt-icon-shape style-scope yt-icon ytSpecIconShapeHost"><div style="width: 100%; height: 100%; display: block; fill: currentcolor;"><svg xmlns="http://www.w3.org/2000/svg" height="24" viewBox="0 0 24 24" width="24" focusable="false" aria-hidden="true" style="pointer-events: none; display: inherit; width: 100%; height: 100%;"><path d="${d}"></path></svg></div></span></yt-icon>`;
  const badge = (type, label, inner) => `<${BADGE} class="style-scope yt-live-chat-author-chip" enable-new-moderator-badge="" aria-label="${label}" type="${type}" shared-tooltip-text="${label}"><div id="image" class="style-scope ${BADGE}">${inner}</div></${BADGE}>`;

  const html = document.documentElement;
  const items = document.querySelector('#items');
  window.__rows = window.__rows || [...items.querySelectorAll(':scope > yt-live-chat-text-message-renderer')];
  const source = spec.displayName
    ? window.__rows.find((r) => !r.querySelector('#author-name').firstChild.textContent.startsWith('@'))
    : window.__rows[spec.row - 1];
  const row = source.cloneNode(true);
  const chip = row.querySelector('yt-live-chat-author-chip');
  const name = row.querySelector('#author-name');
  const setRole = (role) => {
    row.setAttribute('author-type', role);
    name.className = `${role} style-scope yt-live-chat-author-chip style-scope yt-live-chat-author-chip`;
  };
  const variant = spec.variant ?? '';
  let memberBadgeSrc = null;
  if (variant === 'member') {
    setRole('member');
    memberBadgeSrc = memberBadgeUrl;
    row.querySelector('#chat-badges').innerHTML = badge('member', 'Member', `<img src="${memberBadgeSrc}" class="style-scope ${BADGE}" alt="Member">`);
  }
  if (variant.startsWith('owner')) {
    setRole('owner');
    row.setAttribute('author-is-owner', '');
    chip.setAttribute('is-highlighted', '');
  }
  if (variant === 'moderator-classic') {
    // What YouTube renders with its new-shield flag off: no new-moderator attributes, and the legacy icon
    // cloned the way iron-iconset-svg does (_prepareSvgClone in live_chat_polymer.js).
    chip.removeAttribute('enable-new-moderator-text-color');
    const moderatorBadge = row.querySelector('#chat-badges yt-live-chat-author-badge-renderer');
    moderatorBadge.removeAttribute('enable-new-moderator-badge');
    moderatorBadge.querySelector('yt-icon').innerHTML = `<svg viewBox="0 0 16 16" preserveAspectRatio="xMidYMid meet" focusable="false" style="pointer-events: none; display: block; width: 100%; height: 100%;"><g><path d="${classicModeratorPath}"></path></g></svg>`;
  }
  if (variant.endsWith('verified')) {
    chip.setAttribute('is-verified', '');
    row.querySelector('#chip-badges').innerHTML = badge('verified', 'Verified', icon(VERIFIED_PATH));
  }

  // Show only this row, at a fixed width, near the top: YouTube's list is bottom-anchored inside an
  // overflow:hidden box, under the chat header.
  items.replaceChildren(row);
  for (const selector of ['yt-live-chat-header-renderer', '#ticker', 'yt-live-chat-docked-message', '#promo']) {
    document.querySelectorAll(selector).forEach((el) => { el.style.display = 'none'; });
  }
  document.querySelector('#item-offset').style.height = 'auto';
  document.querySelector('#item-scroller').style.overflow = 'hidden';
  Object.assign(items.style, { position: 'static', width: `${rowWidth}px`, padding: '0px' });

  const light = spec.theme === 'light';
  html.toggleAttribute('dark', !light);
  document.querySelector('yt-live-chat-app').toggleAttribute('dark', !light);
  for (const [token, value] of Object.entries(lightTokenValues)) {
    if (light) html.style.setProperty(token, value); else html.style.removeProperty(token);
  }
  document.querySelector('yt-live-chat-renderer').toggleAttribute('hide-timestamps', !spec.timestamp);

  // Put the row's top on a 4px grid, i.e. on whole device pixels at 1, 1.25, 1.5 and 2x (as the app's is).
  const top = row.getBoundingClientRect().top;
  items.style.paddingTop = `${Math.ceil(top / 4) * 4 - top}px`;

  // What the app needs to draw the same comment.
  const emojiOverrides = {};
  let message = '';
  for (const node of row.querySelector('#message').childNodes) {
    if (node.nodeType === Node.TEXT_NODE) message += node.data;
    else if (node.tagName === 'IMG') { message += node.alt; emojiOverrides[node.alt] = node.src; }
  }
  return {
    name: name.firstChild.textContent,
    message,
    theme: light ? 'light' : 'dark',
    role: row.getAttribute('author-type') || 'viewer',
    verified: chip.hasAttribute('is-verified'),
    moderatorBadge: variant === 'moderator-classic' ? 'wrench' : 'shield',
    avatarSrc: row.querySelector('#author-photo img').src,
    memberBadgeSrc,
    timestamp: spec.timestamp ? row.querySelector('#timestamp').textContent : null,
    emojiOverrides,
  };
}

async function settleRow() {
  const row = document.querySelector('#items > yt-live-chat-text-message-renderer');
  const text = row.textContent;
  await Promise.all(['400 14px Roboto', '500 14px Roboto', '400 11px Roboto'].map((f) => document.fonts.load(f, text)));
  await document.fonts.ready;
  await Promise.all([...row.querySelectorAll('img')].map((img) => img.decode().catch(() => {})));
  const r = row.getBoundingClientRect();
  const avatarRight = row.querySelector('#author-photo').getBoundingClientRect().right;
  return { x: r.left, y: r.top, width: r.width, height: r.height, avatarRight };
}

// ---- Harness ---------------------------------------------------------------------------------------
async function openSavedPage() {
  const ses = session.fromPartition('golden-yt');
  serveSavedPage(ses);
  const win = new BrowserWindow({
    show: false, x: 0, y: 0, width: 640, height: 480, useContentSize: true, frame: false, skipTaskbar: true,
    paintWhenInitiallyHidden: true,
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  await win.loadURL(appUrl(`${SAVED_PAGES}/${SAVED.folder}/${SAVED.file}`));
  const run = (fn, ...fnArgs) => win.webContents.executeJavaScript(`(${fn})(...${JSON.stringify(fnArgs)})`, true);
  return { win, run, classicModeratorPath: classicModeratorPath() };
}

async function captureYouTube(page, spec, scale, tokens) {
  const rowWidth = (spec.chat ?? 400) - SCROLLBAR;
  await applyCaptureScale(page.win.webContents, scale); // lay out at the scale it is captured at
  // Member badges come pre-sized like YouTube serves them: the first of 16/32px at least 16 × scale wide.
  const memberBadgeUrl = appUrl(`test/visual/fixtures/member-badge-${scale <= 1 ? 16 : 32}.png`);
  const props = await page.run(prepareCase, spec, tokens, rowWidth, memberBadgeUrl, page.classicModeratorPath);
  const { avatarRight, ...row } = await page.run(settleRow);
  // A plain crop of the real row from the avatar's right edge: what snipping the avatar out gives.
  const rect = spec.cropAvatar ? { ...row, x: avatarRight, width: row.x + row.width - avatarRight } : row;
  const { png } = await captureRegion(page.win.webContents, rect, scale);
  const avatar = spec.cropAvatar ? { hideAvatar: true, avatarSrc: null } : {};
  return { png, props: { ...props, ...avatar, rowWidth: row.width, margin: 0 } };
}

function compare(youtubePng, appPng) {
  const a = PNG.sync.read(youtubePng);
  const b = PNG.sync.read(appPng);
  if (a.width !== b.width || a.height !== b.height) {
    return { sameSize: false, sizes: `${a.width}×${a.height} vs ${b.width}×${b.height}` };
  }
  const diff = new PNG({ width: a.width, height: a.height });
  const differing = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0, includeAA: true });
  let maxDelta = 0;
  for (let i = 0; i < a.data.length; i++) maxDelta = Math.max(maxDelta, Math.abs(a.data[i] - b.data[i]));
  return { sameSize: true, sizes: `${a.width}×${a.height}`, differing, maxDelta, diffPng: PNG.sync.write(diff) };
}

async function main() {
  if (!SAVED) {
    console.log(`SKIP: no saved YouTube live-chat page under ${SAVED_PAGES}/ (see README: Tests).`);
    return 0;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tokens = lightTokens();
  const page = await openSavedPage();
  const results = [];
  for (const spec of CASES.filter((c) => !ONLY || c.name.includes(ONLY))) {
    for (const scale of SCALES) {
      const label = `${spec.name}@${scale}x`;
      try {
        const youtube = await captureYouTube(page, spec, scale, tokens);
        const ours = await captureComment(youtube.props, { scale });
        const result = compare(youtube.png, ours.png);
        fs.writeFileSync(path.join(OUT_DIR, `${label}.youtube.png`), youtube.png);
        fs.writeFileSync(path.join(OUT_DIR, `${label}.app.png`), ours.png);
        const diffFile = path.join(OUT_DIR, `${label}.diff.png`);
        if (result.differing) fs.writeFileSync(diffFile, result.diffPng); else fs.rmSync(diffFile, { force: true });
        results.push({ label, ...result });
      } catch (error) {
        results.push({ label, error: error.message });
      }
    }
  }
  page.win.destroy();
  disposeCapture();

  let failures = 0;
  for (const r of results) {
    const pass = !r.error && r.sameSize && r.differing === 0;
    if (!pass) failures++;
    const detail = r.error ? `ERROR ${r.error}` : !r.sameSize ? `SIZE ${r.sizes}` : `${r.sizes}  differing=${r.differing}  maxDelta=${r.maxDelta}`;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${r.label.padEnd(30)} ${detail}`);
  }
  console.log(`\n${results.length - failures}/${results.length} identical. Images: ${OUT_DIR}`);
  return failures ? 1 : 0;
}

// Keep test state (zoom levels, caches) out of the real app's profile.
app.setPath('userData', path.join(OUT_DIR, 'userdata'));
registerAppScheme();
app.whenReady().then(main).then(
  (code) => app.exit(code),
  (error) => { console.error(error); app.exit(2); },
);
