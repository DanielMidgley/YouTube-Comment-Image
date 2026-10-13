// End-to-end check of the real app. Run: node scripts/electron.js test/smoke/app.js
// Starts electron/main.js (editor hidden, throwaway profile, recorded save dialog and clipboard), waits for
// the editor and its live preview, then drives it like a user: File > Save PNG… and Copy Image through the
// menu, scale/theme changes, an avatar upload through the file input, a typing video, reading a comment from a
// screenshot (paste, File > Read Comment, drop; Undo, cancelling, size limits), the Premiere Pro panel's side
// of a comment sent from a frame (over HTTP, as the panel sends it), invalid IPC input, blocked navigation.
// Fails on any console error or warning from the editor (and errors from the capture window).
import { BRIDGE_PORT, OUT_DIR, recorded } from './app-setup.js'; // must stay the first import
import '../../electron/main.js';
import { app, BrowserWindow, Menu, nativeImage, session } from 'electron';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import { appUrl } from '../../electron/protocol.js';
import { captureComment, pngSize } from '../../electron/capture.js';
import { HEADER, PROTOCOL } from '../../electron/premiere-bridge.js';

const EDITOR_PREFIX = appUrl('src/editor/');
const STAGE_URL = appUrl('src/stage/stage.html');

let failures = 0;
const notes = [];
function check(ok, label) {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${label}`);
  return ok;
}
const note = (text) => { notes.push(text); console.log(`  note  ${text}`); };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function poll(read, done, timeoutMs, what) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${what} (last value: ${JSON.stringify(value)})`);
    await delay(50);
  }
}

/** A 120×80 test avatar: left third transparent, the rest red with a white dot, so the crop is visible. */
function writeTestAvatar(file) {
  const width = 120;
  const height = 80;
  const bgra = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dot = Math.hypot(x - 60, y - 40) < 8;
      const pixel = x < 40 ? [0, 0, 0, 0] : dot ? [255, 255, 255, 255] : [0x35, 0x39, 0xe5, 255]; // BGRA
      bgra.set(pixel, (y * width + x) * 4);
    }
  }
  fs.writeFileSync(file, nativeImage.createFromBitmap(bgra, { width, height }).toPNG());
}

/** A white PNG of width × height px at 1 bit per pixel: a few hundred KB, however big an image it declares. */
function whitePng(width, height) {
  const row = Buffer.alloc(1 + Math.ceil(width / 8), 0xff);
  row[0] = 0; // no filter
  const rows = Buffer.alloc(row.length * height);
  for (let y = 0; y < height; y++) row.copy(rows, y * row.length);
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13); // bit depth 1, greyscale
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 1;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

/** A width × height frame of a video in `rgb`, with the PNG `png` (if any) drawn at `at`: as a PNG. */
function videoFrame(width, height, rgb, png = null, at = { x: 0, y: 0 }) {
  const frame = Buffer.alloc(width * height * 4);
  for (let i = 0; i < frame.length; i += 4) frame.set([rgb[2], rgb[1], rgb[0], 255], i); // BGRA
  if (png) {
    const image = nativeImage.createFromBuffer(png);
    const { width: w, height: h } = image.getSize();
    const bitmap = image.toBitmap();
    for (let y = 0; y < h; y++) bitmap.copy(frame, ((at.y + y) * width + at.x) * 4, y * w * 4, (y + 1) * w * 4);
  }
  return nativeImage.createFromBitmap(frame, { width, height }).toPNG();
}

const rgbAt = (image, x, y) => {
  const { width } = image.getSize();
  const bgra = image.toBitmap();
  const i = (y * width + x) * 4;
  return [bgra[i + 2], bgra[i + 1], bgra[i]];
};

async function run() {
  const editor = await poll(
    () => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith(EDITOR_PREFIX)),
    Boolean, 15_000, 'the editor window');
  const wc = editor.webContents;
  if (wc.isLoading()) await new Promise((resolve) => wc.once('did-finish-load', resolve));
  const js = (code) => wc.executeJavaScript(code, true);
  const status = () => js("document.getElementById('status').textContent");
  const previewReady = async () => {
    await delay(150); // let a scheduled (debounced) render start
    return poll(() => js('document.documentElement.dataset.preview'), (v) => v === 'ready' || v === 'error', 10_000, 'the preview');
  };
  const menuClick = (id) => Menu.getApplicationMenu().getMenuItemById(id).click();
  const waitStatus = (pattern) => poll(status, (text) => pattern.test(text) || /error|invalid|could not/i.test(text), 15_000, `status ${pattern}`);

  console.log('== Launch');
  check(!editor.isVisible(), 'editor window exists and stays hidden in smoke mode');
  check(editor.getTitle() === 'YouTube Chat Comment', `window title "${editor.getTitle()}"`);
  const [minWidth, minHeight] = editor.getMinimumSize();
  check(minWidth === 960 && minHeight === 520, `minimum size ${minWidth}×${minHeight}`);
  check(await js("Object.keys(window.ytComment).sort().join()")
    === 'capture,copy,getDisplayScale,onDisplayScaleChange,onMenuCommand,onPremiereJob,onPremiereUpdate,openScreenshot,premiereDeliver,premiereStatus,save,saveVideo',
    'window.ytComment exposes exactly its twelve calls');
  check(await js("document.getElementById('premiere').hidden"), 'the Premiere Pro bar stays hidden until the panel sends a comment');
  check(await js('typeof require + typeof process + typeof module') === 'undefinedundefinedundefined', 'no Node.js globals in the editor');
  const displayScale = await js('ytComment.getDisplayScale()');
  check(typeof displayScale === 'number' && displayScale > 0, `getDisplayScale() → ${displayScale}`);

  console.log('\n== Preview');
  const previewState = await previewReady();
  check(previewState === 'ready', `preview rendered (${previewState === 'ready' ? 'ready' : await js("document.getElementById('preview-error').textContent")})`);
  const frame = await js("(() => { const f = document.getElementById('preview'); return { w: f.offsetWidth, h: f.offsetHeight, src: f.contentWindow.location.href }; })()");
  check(frame.w === 400 && frame.h === 32 && frame.src === STAGE_URL, `preview iframe ${frame.w}×${frame.h} CSS px showing ${frame.src}`);
  const exportText = await js("document.getElementById('export-size').textContent");
  const expected1 = { width: Math.round(400 * displayScale), height: Math.round(32 * displayScale) };
  check(exportText === `Export: ${expected1.width} × ${expected1.height} px at ${displayScale}×`, `export size line "${exportText}"`);
  check(await js("document.getElementById('scale').options[0].textContent") === `Match display (${displayScale}×)`, 'scale menu offers "Match display"');

  console.log('\n== File > Save PNG… (menu / Ctrl+S path)');
  fs.rmSync(recorded.saveTo, { force: true });
  menuClick('save');
  const saveText = await waitStatus(/^Saved/);
  const saved = fs.existsSync(recorded.saveTo) ? pngSize(fs.readFileSync(recorded.saveTo)) : null;
  check(saved?.width === expected1.width && saved?.height === expected1.height, `saved ${recorded.saveTo} is ${saved?.width}×${saved?.height} px`);
  check(saveText === `Saved ${expected1.width} × ${expected1.height} px → ${recorded.saveTo}`, `status "${saveText}"`);
  const dialogOptions = recorded.dialogs.at(-1);
  check(path.basename(dialogOptions?.defaultPath ?? '') === 'youtube-comment-yourchannel.png' && dialogOptions.filters?.[0]?.extensions?.[0] === 'png',
    `save dialog default ${dialogOptions?.defaultPath}`);
  recorded.cancelNextSave = true;
  menuClick('save');
  check(await waitStatus(/cancel/i) === 'Save cancelled.', 'cancelling the dialog is reported, nothing written');
  recorded.saveTo = path.join(OUT_DIR, 'app-save-2.png');
  fs.rmSync(recorded.saveTo, { force: true });
  await js("document.getElementById('save').click()");
  await waitStatus(/^Saved .*app-save-2/);
  check(path.dirname(recorded.dialogs.at(-1).defaultPath) === OUT_DIR, 'the next save dialog opens in the last folder used');

  console.log('\n== Copy Image (menu / Ctrl+Shift+C path), then 2× light theme');
  menuClick('copy');
  check(await waitStatus(/^Copied/) === `Copied ${expected1.width} × ${expected1.height} px`, 'copy status');
  const copied = recorded.clipboard.at(-1);
  check(copied?.getSize().width === expected1.width && copied?.getSize().height === expected1.height, `clipboard image ${copied?.getSize().width}×${copied?.getSize().height}`);
  check(rgbAt(copied, 1, 1).every((v) => v === 0x0f), `dark chat background in the copied image (rgb ${rgbAt(copied, 1, 1)})`);

  await js(`(() => {
    const scale = document.getElementById('scale');
    scale.value = '2';
    scale.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('input[name="theme"][value="light"]').click();
  })()`);
  await previewReady();
  check(await js("document.getElementById('export-size').textContent") === 'Export: 800 × 64 px at 2×', 'export size follows the scale menu');
  menuClick('copy');
  await waitStatus(/^Copied 800/);
  const copied2 = recorded.clipboard.at(-1);
  check(copied2.getSize().width === 800 && copied2.getSize().height === 64, `2× clipboard image ${copied2.getSize().width}×${copied2.getSize().height}`);
  check(rgbAt(copied2, 1, 1).every((v) => v === 0xff), `light chat background (rgb ${rgbAt(copied2, 1, 1)})`);
  fs.writeFileSync(path.join(OUT_DIR, 'app-copy-light-2x.png'), copied2.toPNG());

  // A Windows contrast theme (forced colours) must not recolour the export: emulate it on the capture window.
  const captureWindow = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith(STAGE_URL));
  const cdp = captureWindow.webContents.debugger;
  cdp.attach('1.3');
  try {
    await cdp.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
    menuClick('copy');
    await waitStatus(/^Copied 800/);
    const forced = recorded.clipboard.at(-1);
    check(forced !== copied2 && rgbAt(forced, 1, 1).every((v) => v === 0xff) && forced.toBitmap().equals(copied2.toBitmap()),
      `contrast theme (forced colours) leaves the export unchanged (background rgb ${rgbAt(forced, 1, 1)})`);
  } finally {
    await cdp.sendCommand('Emulation.setEmulatedMedia', { features: [] }).catch(() => {});
    cdp.detach();
  }

  console.log('\n== Avatar upload through the file input');
  const avatarFile = path.join(OUT_DIR, 'app-test-avatar.png');
  writeTestAvatar(avatarFile);
  wc.debugger.attach('1.3');
  try {
    const { result } = await wc.debugger.sendCommand('Runtime.evaluate', { expression: "document.getElementById('avatar-file')" });
    await wc.debugger.sendCommand('DOM.setFileInputFiles', { files: [avatarFile], objectId: result.objectId });
  } finally {
    wc.debugger.detach();
  }
  await poll(() => js("!document.getElementById('avatar-thumb').hidden"), Boolean, 5000, 'the avatar thumbnail');
  check(await js("document.querySelector('input[name=\"avatarMode\"]:checked').value") === 'image', 'uploading switches the avatar to "Image"');
  const stored = await poll(() => js(`(async () => {
    const state = JSON.parse(localStorage.getItem('ytComment.editor.v1') ?? '{}');
    if (!state.avatarImage) return null;
    const sizes = [];
    for (const size of [32, 64]) {
      const img = new Image();
      img.src = state.avatarImage[size];
      await img.decode();
      sizes.push(img.naturalWidth + 'x' + img.naturalHeight);
    }
    return { sizes, scale: state.scale, theme: state.theme };
  })()`), Boolean, 5000, 'the saved editor state');
  check(stored.sizes.join() === '32x32,64x64' && stored.scale === 2 && stored.theme === 'light',
    `editor state saved to localStorage (avatar ${stored.sizes.join(' + ')}, scale ${stored.scale}, theme ${stored.theme})`);
  await previewReady();
  menuClick('copy');
  await waitStatus(/^Copied 800/);
  const withAvatar = recorded.clipboard.at(-1);
  fs.writeFileSync(path.join(OUT_DIR, 'app-copy-avatar-2x.png'), withAvatar.toPNG());
  // At 2× the 24 px avatar spans x 48–96, y 8–56: white dot in the middle, red around it, and the
  // transparent part of the crop composited onto white at its left edge.
  const [centre, red, left] = [rgbAt(withAvatar, 72, 32), rgbAt(withAvatar, 84, 40), rgbAt(withAvatar, 54, 32)];
  check(centre.every((v) => v > 230) && red[0] > 200 && red[1] < 90 && left.every((v) => v > 230),
    `uploaded avatar in the export (centre ${centre}, ring ${red}, left ${left})`);

  console.log('\n== No avatar (cropped out)');
  const setAvatarMode = (mode) => js(`(() => {
    const radio = document.querySelector('input[name="avatarMode"][value="${mode}"]');
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await setAvatarMode('none');
  await previewReady();
  check(await js("!document.getElementById('avatar-none').hidden && document.getElementById('avatar-image').hidden"), 'choosing None shows its hint');
  check(await js("document.getElementById('export-size').textContent") === 'Export: 704 × 64 px at 2×', 'the export loses the avatar column (800 − 2×48 px)');
  menuClick('copy');
  await waitStatus(/^Copied 704/);
  const cropped = recorded.clipboard.at(-1);
  fs.writeFileSync(path.join(OUT_DIR, 'app-copy-no-avatar-2x.png'), cropped.toPNG());
  // The image starts where the avatar ended: its first 32 px (the 16 px gap at 2×) are plain background.
  const gap = Array.from({ length: 32 }, (_, x) => rgbAt(cropped, x, 32));
  check(cropped.getSize().width === 704 && cropped.getSize().height === 64 && gap.every((rgb) => rgb.every((v) => v === 0xff)),
    `clipboard image ${cropped.getSize().width}×${cropped.getSize().height} starts with plain background`);
  await setAvatarMode('image');
  await previewReady();

  console.log('\n== Moderator badge (shield / classic wrench)');
  const setRadio = (name, value) => js(`(() => {
    const radio = document.querySelector('input[name="${name}"][value="${value}"]');
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const badgePath = () => js("document.getElementById('preview').contentDocument.querySelector('#chat-badges path')?.getAttribute('d').slice(0, 10)");
  check(await js("document.getElementById('moderator-field').hidden"), 'the badge choice is hidden for viewers');
  await setRadio('role', 'moderator');
  await previewReady();
  check(await js("!document.getElementById('moderator-field').hidden"), 'choosing Moderator shows the badge choice');
  check(await badgePath() === 'M3 4.998v9', 'the preview shows the current shield by default');
  await setRadio('moderatorBadge', 'wrench');
  await previewReady();
  check(await badgePath() === 'M9.6458914', 'choosing Wrench shows YouTube' + "'" + 's classic badge');
  await setRadio('moderatorBadge', 'shield');
  await setRadio('role', 'viewer');
  await previewReady();

  console.log('\n== Keyboard focus and text limits');
  await js("document.getElementById('copy').focus()");
  menuClick('copy');
  await waitStatus(/^Copied/);
  check(await js('document.activeElement.id') === 'copy', 'focus stays on Copy image through an export');
  check(await js("document.getElementById('message').maxLength") === 1000, 'the message box takes at most 1000 characters (the export limit)');
  check(await js("document.querySelector('label[for=\"message\"]').textContent") === 'Text', 'the message box is labelled just "Text" (the counter is a description)');
  await js("document.getElementById('avatar-remove').click()");
  check(await js("document.activeElement.matches('input[name=\"avatarMode\"][value=\"default\"]')"), 'after Remove, focus moves to the Letter avatar option');
  // Put the uploaded avatar back for the checks below.
  wc.debugger.attach('1.3');
  try {
    const { result } = await wc.debugger.sendCommand('Runtime.evaluate', { expression: "document.getElementById('avatar-file')" });
    await wc.debugger.sendCommand('DOM.setFileInputFiles', { files: [avatarFile], objectId: result.objectId });
  } finally {
    wc.debugger.detach();
  }
  await poll(() => js("!document.getElementById('avatar-thumb').hidden"), Boolean, 5000, 'the avatar thumbnail');
  await previewReady();

  console.log('\n== Typing video (File > Save Typing Video…)');
  await js(`(() => {
    const set = (id, value, type) => {
      const el = document.getElementById(id);
      el.value = value;
      el.dispatchEvent(new Event(type, { bubbles: true }));
    };
    set('message', 'Hi 😆', 'input');
    set('cps', '10', 'input');
    set('lead-in', '0.2', 'change');
    set('hold', '0.5', 'change');
  })()`);
  await previewReady();
  // 4 characters: the last appears at 0.2 + 3/10 s, then 0.5 s of hold = 1.0 s, 30 frames at 30 fps.
  check(await js("document.getElementById('video-length').textContent") === '1.0 s video', 'the video length is shown');
  menuClick('video');
  const videoStatus = await poll(status, (text) => /^Saved .* video|error|invalid|could not|failed/i.test(text), 60_000, 'the video export');
  check(/^Saved 800 × 64 px, 1\.0 s video → /.test(videoStatus), `status "${videoStatus}"`);
  const mp4 = fs.readFileSync(recorded.saveVideoTo);
  check(mp4.toString('latin1', 4, 8) === 'ftyp', `${path.basename(recorded.saveVideoTo)} is an MP4 (${mp4.length} bytes)`);
  const { ALL_FORMATS, BufferSource, EncodedPacketSink, Input } = await import('mediabunny');
  const input = new Input({ source: new BufferSource(mp4), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  let packets = 0;
  for await (const _ of new EncodedPacketSink(track).packets()) packets++;
  const duration = await input.computeDuration();
  check(track.codec === 'avc' && track.displayWidth === 800 && track.displayHeight === 64 && packets === 30 && Math.abs(duration - 1) < 0.01,
    `H.264 track ${track.displayWidth}×${track.displayHeight}, ${packets} frames, ${duration.toFixed(3)} s`);

  console.log('\n== avatar.js in the page');
  const avatarInfo = await js(`import('../comment/avatar.js').then(async (m) => {
    const decode = async (src) => { const img = new Image(); img.src = src; await img.decode(); return img; };
    const letter = await decode(await m.makeDefaultAvatar({ name: '@Ana', color: '#1976D2', size: 64 }));
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(letter, 0, 0);
    const corner = [...ctx.getImageData(0, 0, 1, 1).data];
    const white = [...ctx.getImageData(0, 0, 64, 64).data].filter((v, i) => i % 4 === 0 && v > 240).length;
    let error = '';
    try { await m.prepareAvatar(new Blob(['not an image'], { type: 'text/plain' })); } catch (e) { error = e.message; }
    return {
      initials: ['@foo', '  @ ßeta', '', '@', '🔥fire', 'émile', 'Zoë'].map(m.avatarInitial),
      stable: m.pickAvatarColor('@YourChannel') === m.pickAvatarColor('@YourChannel'),
      palette: m.DEFAULT_AVATAR_COLORS.length,
      sizes: [m.avatarSizeFor(1), m.avatarSizeFor(1.25), m.avatarSizeFor(4 / 3), m.avatarSizeFor(1.5), m.badgeSizeFor(1), m.badgeSizeFor(1.25)],
      letter: { width: letter.naturalWidth, corner, white },
      error,
    };
  })`);
  check(avatarInfo.initials.join(' ') === 'F ß ? ? 🔥 É Z', `avatarInitial → ${avatarInfo.initials.join(' ')}`);
  check(avatarInfo.stable && avatarInfo.palette === 16, 'pickAvatarColor is stable over a 16-colour palette');
  check(avatarInfo.sizes.join() === '32,32,32,64,16,32', `image sizes by scale ${avatarInfo.sizes.join(',')}`);
  check(avatarInfo.letter.width === 64 && avatarInfo.letter.corner.join() === '25,118,210,255' && avatarInfo.letter.white > 40,
    `letter avatar 64 px, filled #1976D2, white initial (${avatarInfo.letter.white} white px)`);
  check(/not an image/.test(avatarInfo.error), `non-images rejected: "${avatarInfo.error}"`);

  console.log('\n== IPC validation (main process)');
  const tryCopy = (patch, opts = '{ scale: 1 }') => js(`(async () => {
    const props = { name: 'x', message: 'y', theme: 'dark', role: 'viewer', verified: false,
      avatarSrc: 'data:image/png;base64,iVBORw0KGgo=', memberBadgeSrc: null, timestamp: null, rowWidth: 400, margin: 0, ...${patch} };
    try { await ytComment.copy(props, ${opts}); return 'resolved'; } catch (e) { return e.message; }
  })()`);
  for (const [patch, pattern, opts] of [
    ["{ role: 'admin' }", /role must be one of/],
    ["{ avatarSrc: 'javascript:alert(1)' }", /must be a data:, app: or https: URL/],
    ["{ avatarSrc: 'http://example.com/a.png' }", /must be a data:, app: or https: URL/],
    ["{ avatarSrc: 'file:///C:/Windows/win.ini' }", /must be a data:, app: or https: URL/],
    ["{ memberBadgeSrc: 'data:text/html,<b>x</b>' }", /not an image data URL/],
    ["{ verified: 'yes' }", /verified must be true or false/],
    ["{ rowWidth: 'wide' }", /rowWidth must be a number/],
    ['{}', /Invalid export scale/, '{ scale: 10 }'],
    ['{}', /Invalid export scale/, 'undefined'],
  ]) {
    const message = await tryCopy(patch, opts);
    check(pattern.test(message), `copy(${patch}${opts ? `, ${opts}` : ''}) rejected: ${message.replace(/^Error invoking remote method '[^']+': /, '')}`);
  }
  const before = recorded.clipboard.length;
  const capped = await js(`ytComment.copy({ name: '@' + 'n'.repeat(300), message: 'm'.repeat(3000), theme: 'dark', role: 'viewer', verified: false,
    avatarSrc: document.getElementById('avatar-thumb').src, memberBadgeSrc: null, timestamp: null, rowWidth: 5000, margin: -4 },
    { scale: 1 }).then((r) => r.width, (e) => e.message)`);
  check(capped === 1200 && recorded.clipboard.length === before + 1, `over-long text is capped and widths clamped (export width ${capped} px)`);

  console.log('\n== Read a comment from a screenshot');
  // Screenshots made by the app's own capture, which draws comments exactly as YouTube does.
  const requests = [];
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    requests.push(details.url);
    callback({});
  });
  const avatarSrc = await js("document.getElementById('avatar-thumb').src");
  const comment = (name, message, extra = {}) => ({ name, message, theme: 'dark', role: 'viewer', verified: false, avatarSrc,
    memberBadgeSrc: null, timestamp: null, rowWidth: 400, margin: 0, ...extra });
  const readStatus = () => js("document.getElementById('read-status').textContent");
  const fields = async () => ({ name: await js("document.getElementById('name').value"), message: await js("document.getElementById('message').value") });
  const same = (a, b) => a.name === b.name && a.message === b.message;
  const readDone = (what) => poll(readStatus, (text) => !/^(Reading|Starting)/.test(text) && text !== '', 60_000, what);
  const clearStatus = () => js("document.getElementById('read-status').textContent = ''");
  const undoOffered = () => js("!document.getElementById('read-undo').hidden");
  // Pastes the File that the page code `file` gives (as Ctrl+V does with a fresh snip on the clipboard).
  const paste = (file, into = 'document.body') => js(`(async () => {
    const data = new DataTransfer();
    data.items.add(await ${file});
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    ${into}.dispatchEvent(event);
    return event.defaultPrevented;
  })()`);
  const snip = (props, scale) => `ytComment.capture(${JSON.stringify(props)}, { scale: ${scale} })
    .then((shot) => new File([shot.png], 'snip.png', { type: 'image/png' }))`;
  // Real typing, clicks and keys (through the DevTools protocol): Chromium's focus, 'change' and undo handling
  // follow only those. The window is hidden, so it is told it has the focus.
  wc.debugger.attach('1.3');
  const devtools = (method, params) => wc.debugger.sendCommand(method, params);
  await devtools('Emulation.setFocusEmulationEnabled', { enabled: true });
  const click = async (id) => {
    const { x, y } = await js(`(() => { const r = document.getElementById('${id}').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await devtools('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  };
  const ctrlZ = async () => {
    for (const type of ['rawKeyDown', 'keyUp']) await devtools('Input.dispatchKeyEvent', { type, modifiers: 2, windowsVirtualKeyCode: 90, key: 'z', code: 'KeyZ' });
  };

  // Typed in the message box, then a snip pasted there: as the box loses focus to the Undo button, Chromium
  // sends it a 'change' for that typing, which must not take Undo away from under the pointer.
  await js("(() => { const box = document.getElementById('message'); box.focus(); box.setSelectionRange(box.value.length, box.value.length); })()");
  await devtools('Input.insertText', { text: ' and more' });
  const typed = await fields();
  const pasted = comment('@Night_Owl42', 'see you all at the next stream, bye chat!');
  check(await paste(snip(pasted, 1.25), "document.getElementById('message')"), 'pasting an image (a fresh snip) into the message box reads it as a screenshot');
  const pasteStatus = await readDone('reading the pasted screenshot');
  check(/^Filled in the name and message/.test(pasteStatus), `status "${pasteStatus}"`);
  const afterPaste = await fields();
  check(same(afterPaste, pasted), `read ${JSON.stringify(afterPaste)} from a 1.25× screenshot`);
  check(await js("(() => { const s = document.getElementById('read-status'); return s.classList.contains('read-status') && getComputedStyle(s).marginTop === '8px'; })()"),
    'the status line keeps its own style (8 px below the hint)');
  check(await undoOffered(), 'Undo is offered');
  await click('read-undo');
  const undone = await fields();
  check(same(undone, typed), `clicking Undo puts back ${JSON.stringify(undone)}`);
  check(await js("document.getElementById('read-undo').hidden && document.activeElement.id === 'read-screenshot'"), 'Undo then hides, and focus moves to the Read button');

  const textPaste = await js(`(() => {
    const data = new DataTransfer();
    data.setData('text/plain', 'typed');
    data.items.add(new File([new Uint8Array([1, 2, 3])], 'x.png', { type: 'image/png' }));
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    document.getElementById('name').dispatchEvent(event);
    return event.defaultPrevented;
  })()`);
  check(!textPaste, 'pasting text into a field is left alone even when an image comes with it');
  await clearStatus();

  const opened = comment('@pixel.garden', 'how long have you been playing this game for', { theme: 'light', role: 'moderator', timestamp: '9:05\u202fPM' });
  const shot = await captureComment(opened, { scale: 2 });
  recorded.openFrom = path.join(OUT_DIR, 'read-screenshot.png');
  fs.writeFileSync(recorded.openFrom, shot.png);
  menuClick('read-screenshot');
  const openStatus = await readDone('reading the opened screenshot');
  const afterOpen = await fields();
  check(/^Filled in/.test(openStatus) && same(afterOpen, opened),
    `File > Read Comment from Screenshot… read ${JSON.stringify(afterOpen)} (light, moderator, timestamp, 2×)`);
  const openOptions = recorded.dialogs.at(-1);
  const [images, allFiles] = openOptions?.filters ?? [];
  check(openOptions?.properties?.includes('openFile') && ['png', 'jpg', 'jfif'].every((ext) => images?.extensions.includes(ext))
    && allFiles?.extensions.join() === '*', `the open dialog asks for one image file (${images?.extensions.join(', ')}) or offers All files`);
  recorded.openFrom = null;
  menuClick('read-screenshot');
  await delay(300);
  check((await fields()).name === opened.name && await readStatus() === openStatus, 'cancelling the open dialog changes nothing');
  // Edit > Undo is Chromium's undo, which would replay the typing above in the replaced message box (changing
  // nothing, and costing the Undo): it undoes the reading instead.
  wc.undo();
  await delay(200);
  const afterMenuUndo = await fields();
  check(same(afterMenuUndo, typed) && !await undoOffered(), `Edit > Undo undoes the reading: ${JSON.stringify(afterMenuUndo)}`);
  await clearStatus();

  const dropped = comment('@ana_k', 'first time here, loving the vibes');
  // A drop does what the half on its side of the window says, from the gap between the halves to the margins.
  const lit = await js(`(() => {
    const data = new DataTransfer();
    data.items.add(new File(['x'], 'x.png', { type: 'image/png' }));
    const fire = (type, x, y) => document.body.dispatchEvent(new DragEvent(type, { dataTransfer: data, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    fire('dragenter', 5, 5);
    const middle = innerWidth / 2;
    const points = [[middle - 1, innerHeight / 2], [middle + 1, innerHeight / 2], [4, 4], [innerWidth - 4, innerHeight - 4], [middle / 2, innerHeight / 2], [middle * 1.5, innerHeight / 2]];
    const lit = points.map(([x, y]) => {
      fire('dragover', x, y);
      return [...document.querySelectorAll('[data-drop].active')].map((target) => target.dataset.drop).join('+') || 'none';
    });
    fire('dragleave', 5, 5);
    return lit.join(', ');
  })()`);
  check(lit === 'screenshot, avatar, screenshot, avatar, screenshot, avatar', `the half on the pointer's side lights up, gap and margins included (${lit})`);
  const drop = (point) => js(`(async () => {
    const data = new DataTransfer();
    data.items.add(await ${snip(dropped, 1)});
    const fire = (type, x, y) => document.body.dispatchEvent(new DragEvent(type, { dataTransfer: data, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    const [x, y] = ${point};
    fire('dragenter', 5, 5);
    fire('dragover', x, y);
    const active = [...document.querySelectorAll('[data-drop].active')].map((target) => target.dataset.drop).join('+');
    fire('drop', x, y);
    return { active, hidden: document.getElementById('drop-overlay').hidden };
  })()`);
  const onScreenshot = await drop('[innerWidth / 2 - 1, 4]'); // between the halves, in the margin above them
  check(onScreenshot.active === 'screenshot' && onScreenshot.hidden, 'dragging over the "Read the comment" side highlights it; dropping closes the overlay');
  await readDone('reading the dropped screenshot');
  const afterDrop = await fields();
  check(same(afterDrop, dropped), `dropping there reads ${JSON.stringify(afterDrop)}`);
  const avatarBefore = await js("document.getElementById('avatar-thumb').src");
  await clearStatus();
  const onAvatar = await drop('[innerWidth - 4, innerHeight - 4]'); // in the corner of the margin
  await poll(() => js("document.getElementById('avatar-thumb').src"), (src) => src !== avatarBefore, 10_000, 'the dropped avatar');
  check(onAvatar.active === 'avatar' && (await fields()).name === dropped.name, 'dropping on the "Use as avatar" side sets the avatar instead');

  // In a Windows contrast theme (forced colours) only an outline and a solid border can mark the lit half.
  await devtools('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
  const contrast = await js(`(() => {
    const overlay = document.getElementById('drop-overlay');
    const [on, off] = overlay.querySelectorAll('[data-drop]');
    overlay.hidden = false;
    on.classList.add('active');
    const look = (target) => { const style = getComputedStyle(target); return style.borderTopStyle + ' border, ' + style.outlineStyle + ' outline'; };
    const looks = { on: look(on), off: look(off) };
    on.classList.remove('active');
    overlay.hidden = true;
    return looks;
  })()`);
  await devtools('Emulation.setEmulatedMedia', { features: [] });
  check(contrast.on === 'solid border, solid outline' && contrast.off === 'dashed border, none outline',
    `in a contrast theme the lit half has a ${contrast.on}, the other a ${contrast.off}`);

  await clearStatus();
  const blank = await js(`(async () => {
    const canvas = new OffscreenCanvas(300, 60);
    const context = canvas.getContext('2d');
    context.fillStyle = '#0f0f0f';
    context.fillRect(0, 0, 300, 60);
    const data = new DataTransfer();
    data.items.add(new File([await canvas.convertToBlob()], 'blank.png', { type: 'image/png' }));
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    return true;
  })()`);
  const blankStatus = blank && await readDone('reading a blank image');
  check(/No text|Couldn't find/.test(blankStatus) && (await fields()).name === dropped.name, `an image without a comment is refused: "${blankStatus}"`);
  check(await undoOffered(), 'a read that fails leaves the last reading undoable');
  // Ctrl+Z with the focus on a button: Chromium's own undo would act on the typing in the message box.
  await js("document.getElementById('read-screenshot').focus()");
  await ctrlZ();
  const afterCtrlZ = await fields();
  check(same(afterCtrlZ, typed) && !await undoOffered(), `Ctrl+Z undoes the last reading: ${JSON.stringify(afterCtrlZ)}`);

  // A message that is only a channel's own emoji can't be read: the name is filled in, and the message kept.
  const emote = await js(`(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 48;
    const context = canvas.getContext('2d');
    context.fillStyle = '#7b1fa2';
    context.beginPath();
    context.arc(24, 24, 22, 0, 2 * Math.PI);
    context.fill();
    return canvas.toDataURL();
  })()`);
  await clearStatus();
  await paste(snip(comment('@member_fan', '🔥', { emojiOverrides: { '🔥': emote } }), 1.5));
  const partStatus = await readDone('reading a comment whose message is an unknown emoji');
  const afterPart = await fields();
  check(partStatus.startsWith("Filled in the name from the screenshot. The message couldn't be read, so yours is kept.")
    && afterPart.name === '@member_fan' && afterPart.message === typed.message, `status "${partStatus}"`);
  const described = await js(`import('./screenshot.js').then(({ describeReading }) => [
    describeReading({ name: '', message: 'hi' }),
    describeReading({ name: '@a', message: 'hi', doubtful: ['one', 'two', 'one'] }),
    describeReading({ name: '@a', message: 'hi', doubtful: ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7'], warnings: ['The screenshot shows 2 comments; this is the first.'] }),
  ])`);
  check(described.join('\n') === [
    "Filled in the message from the screenshot. The name couldn't be read, so yours is kept.",
    'Filled in the name and message from the screenshot. Check “one”, “two”: hard to read.',
    'Filled in the name and message from the screenshot. Check “w1”, “w2”, “w3”, “w4”, “w5” and 2 more: hard to read. The screenshot shows 2 comments; this is the first.',
  ].join('\n'), `status lines say what was filled in and kept, and name up to five words to check:\n          ${described.join('\n          ')}`);

  // A screenshot pasted while another is being read replaces it: the first is never filled in, so Undo goes
  // back past both.
  const beforeBoth = await fields();
  const second = comment('@second_snip', 'this is the one that counts');
  await clearStatus();
  await js(`(async () => {
    const files = await Promise.all([${snip(comment('@first_snip', 'this one gets cancelled'), 1.25)}, ${snip(second, 1.25)}]);
    for (const file of files) {
      const data = new DataTransfer();
      data.items.add(file);
      document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }
  })()`);
  const bothStatus = await readDone('reading two screenshots pasted at once');
  const afterBoth = await fields();
  check(/^Filled in the name and message/.test(bothStatus) && same(afterBoth, second), `of two screenshots pasted at once, the second is read: ${JSON.stringify(afterBoth)}`);
  await click('read-undo');
  const backPastBoth = await fields();
  check(same(backPastBoth, beforeBoth), `the first was cancelled before it filled anything in: Undo goes back to ${JSON.stringify(backPastBoth)}`);

  // The size limits come before any decoding: a file over 50 MB, and a small file that declares a huge image.
  await clearStatus();
  await paste(`new File([new Uint8Array(${50 * 1024 * 1024 + 1})], 'huge.png', { type: 'image/png' })`);
  const hugeStatus = await readDone('reading a file over 50 MB');
  check(hugeStatus === 'That file is too big to be a screenshot of a comment.', `a pasted file over 50 MB is refused: "${hugeStatus}"`);
  await clearStatus();
  await paste("new File(['not an image'], 'notes.png', { type: 'image/png' })");
  const junkStatus = await readDone('reading a file that is no image');
  check(/^That file isn't an image the app can open/.test(junkStatus), `a file that isn't an image is refused: "${junkStatus}"`);
  const workingSet = () => app.getAppMetrics().find((m) => m.pid === wc.getOSProcessId())?.memory.workingSetSize ?? 0; // KB
  for (const [width, height] of [[16000, 16000], [30000, 30000]]) {
    const file = path.join(OUT_DIR, `read-${width}x${height}.png`);
    fs.writeFileSync(file, whitePng(width, height));
    await clearStatus();
    const base = workingSet();
    let peak = base;
    const sample = setInterval(() => { peak = Math.max(peak, workingSet()); }, 20);
    // Through the hidden file input: a file on disk, as a drop gives.
    const { result } = await devtools('Runtime.evaluate', { expression: "document.getElementById('read-file')" });
    await devtools('DOM.setFileInputFiles', { files: [file], objectId: result.objectId });
    const text = await readDone(`reading a ${width} × ${height} px image`);
    clearInterval(sample);
    const grew = Math.round((peak - base) / 1024);
    check(text === `That image is ${width} × ${height} px; crop it to the comment first.` && grew < 300,
      `a ${Math.round(fs.statSync(file).size / 1024)} KB PNG of ${width} × ${height} px is refused before decoding (renderer +${grew} MB): "${text}"`);
  }

  // The open dialog's file is read up to the cap and no further: the size the file system reports isn't trusted.
  const openFails = async (file) => {
    recorded.openFrom = file;
    await clearStatus();
    menuClick('read-screenshot');
    return readDone(`opening ${path.basename(file)}`);
  };
  const emptyFile = path.join(OUT_DIR, 'empty.png');
  fs.writeFileSync(emptyFile, '');
  const emptyStatus = await openFails(emptyFile);
  check(emptyStatus === 'empty.png is empty.', `an empty file is refused: "${emptyStatus}"`);
  const folderStatus = await openFails(OUT_DIR);
  check(folderStatus === `${path.basename(OUT_DIR)} isn't a file the app can open.`, `a folder is refused: "${folderStatus}"`);
  if (process.platform === 'win32') {
    // A named pipe is a "file" of 0 bytes that never ends, as is \\wsl$\<distro>\dev\zero (and it hands over a
    // little at a time).
    let mostSent = 0;
    const block = Buffer.alloc(64 * 1024);
    const server = net.createServer((socket) => {
      let sent = 0;
      socket.on('error', () => {}); // the app hangs up once it has read enough
      (function pump() {
        while (sent < 200 * 1024 * 1024) {
          sent += block.length;
          mostSent = Math.max(mostSent, sent);
          if (!socket.write(block)) {
            socket.once('drain', pump);
            return;
          }
        }
        socket.end();
      })();
    });
    const pipe = `\\\\.\\pipe\\youtube-comment-smoke-${process.pid}`;
    await new Promise((resolve) => server.listen(pipe, resolve));
    const pipeStatus = await openFails(pipe);
    server.close();
    check(pipeStatus === `${path.basename(pipe)} is too big to be a screenshot of a comment.` && mostSent < 60 * 1024 * 1024,
      `an endless "file" is read no further than the 50 MB cap (${Math.round(mostSent / 1024 / 1024)} MB sent): "${pipeStatus}"`);
  }
  recorded.openFrom = null;

  console.log('\n== Premiere Pro panel');
  {
    // The panel's side (premiere-plugin/), over HTTP as the panel speaks it: the frame at the playhead with a box
    // drawn around a comment; the editor reads it, the user checks it and sends it back, the panel fetches it.
    const bridge = `http://localhost:${BRIDGE_PORT}`; // as the panel says it (see electron/premiere-bridge.js)
    const ask = async (route, { method = 'GET', body, type } = {}) => {
      const response = await fetch(`${bridge}${route}`, { method, body, headers: { [HEADER]: String(PROTOCOL), ...(type ? { 'content-type': type } : {}) } });
      const bytes = Buffer.from(await response.arrayBuffer());
      let json = null;
      try {
        json = JSON.parse(bytes.toString('utf8'));
      } catch {
        // a file
      }
      return { status: response.status, type: response.headers.get('content-type'), bytes, json };
    };
    const hello = await ask('/v1/hello');
    check(hello.status === 200 && hello.json?.app === 'YouTube Chat Comment' && hello.json.protocol === PROTOCOL, `the app answers the panel on port ${BRIDGE_PORT}`);
    check((await fetch(`${bridge}/v1/hello`)).status === 403, 'and nothing that lacks its header');
    const sendFrame = (frame, rect, label = 'Sequence 01 at 00:00:05:00') => ask(
      `/v1/jobs?${new URLSearchParams({ ...Object.fromEntries(Object.entries(rect).map(([k, v]) => [k, String(v)])), label })}`,
      { method: 'POST', body: frame, type: 'image/png' },
    );
    const jobState = async (id) => (await ask(`/v1/jobs/${id}`)).json;
    const settled = (id, what) => poll(() => jobState(id), (j) => ['done', 'failed', 'cancelled'].includes(j?.state) || /failed/i.test(j?.message ?? ''), 90_000, what);
    const premiereBar = () => js(`(() => ({
      shown: !document.getElementById('premiere').hidden,
      label: document.getElementById('premiere-label').textContent,
      status: document.getElementById('premiere-status').textContent,
      send: !document.getElementById('premiere-image').hidden,
      close: document.getElementById('premiere-cancel').textContent,
    }))()`);
    const pixelsOf = (png) => {
      const image = nativeImage.createFromBuffer(png);
      return { ...image.getSize(), data: image.toBitmap() };
    };

    // A 1280 × 720 frame: a comment at 1.5× drawn at (180, 260) on the dark chat's background, and a box drawn
    // around it with some room to spare.
    const shown = comment('@harbor_lights', 'that drop was unreal, again again again');
    const shot = await captureComment(shown, { scale: 1.5 });
    const at = { x: 180, y: 260 };
    const frame = videoFrame(1280, 720, [15, 15, 15], shot.png, at);
    const box = { x: at.x - 14, y: at.y - 9, width: shot.width + 40, height: shot.height + 22 };
    const before = { ...await fields(), avatar: await js("document.getElementById('avatar-thumb').src"), avatarMode: await js("document.querySelector('input[name=\"avatarMode\"]:checked').value") };
    // Sent at the export bar's Scale, as Save PNG renders: here 1.5×, the size the comment was drawn at in this
    // frame, so its pixels can be compared.
    const scaleBefore = await js("document.getElementById('scale').value");
    const setScale = (value) => js(`(() => { const s = document.getElementById('scale'); s.value = '${value}'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await setScale('1.5');
    const job = await sendFrame(frame, box);
    check(job.status === 201 && job.json?.state === 'reading', `the frame starts a job (${job.status} ${job.json?.state})`);
    const review = await poll(() => jobState(job.json.id), (j) => j?.state !== 'reading', 90_000, 'the comment to be read');
    check(review.state === 'review', `the editor reads the comment and waits for the user: "${review.message}"`);
    const bar = await premiereBar();
    check(bar.shown && bar.label === 'Sequence 01 at 00:00:05:00' && bar.send && bar.close === 'Cancel', `the Premiere Pro bar shows the job: ${JSON.stringify(bar)}`);
    check(await js("document.getElementById('premiere-scale').textContent") === 'At 1.5× (Scale, below)', 'and the Scale it renders at');
    check(same(await fields(), shown), `the name and message are filled in (${JSON.stringify(await fields())})`);
    check(await js("document.querySelector('input[name=\"theme\"]:checked').value") === 'dark'
      && await js("document.querySelector('input[name=\"avatarMode\"]:checked').value") === 'image', 'in the video\'s theme, with the avatar from the video');
    await click('premiere-image');
    const sent = await settled(job.json.id, 'the image');
    check(sent.state === 'done' && sent.file?.kind === 'png' && sent.file.width === shot.width && sent.file.height === shot.height,
      `"Send image" hands over a PNG rendered at the 1.5× Scale (${sent.file?.width} × ${sent.file?.height}, the 1.5× render ${shot.width} × ${shot.height}; ${sent.message})`);
    check(!('placement' in sent), 'with no placement: the panel puts it on the timeline at its own size');
    const file = await ask(`/v1/jobs/${job.json.id}/file`);
    check(file.status === 200 && file.type === 'image/png' && pngSize(file.bytes)?.width === shot.width, `the panel fetches the PNG (${file.bytes.length} bytes)`);
    if (file.status === 200) {
      const [a, b] = [pixelsOf(file.bytes), pixelsOf(shot.png)];
      let off = 0;
      for (let i = 0; i < a.data.length; i += 4) {
        if (Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2])) > 24) off++;
      }
      const share = off / (a.width * a.height);
      check(share < 0.01, `and it looks like the original: ${(100 * share).toFixed(2)}% of its pixels differ visibly (the avatar is resampled)`);
    }
    await ask(`/v1/jobs/${job.json.id}/placed`, { method: 'POST', body: JSON.stringify({ message: 'Placed on V2 at 00:00:05:00.' }), type: 'application/json' });
    const afterPlaced = await poll(premiereBar, (b) => b.status === 'Placed on V2 at 00:00:05:00.', 10_000, 'the placed message');
    check(afterPlaced.close === 'Close' && !afterPlaced.send, 'the panel\'s "placed" shows in the bar, which now offers Close');
    check(await undoOffered(), 'the reading can still be undone');
    await click('read-undo');
    const undone = { ...await fields(), avatar: await js("document.getElementById('avatar-thumb').src"), avatarMode: await js("document.querySelector('input[name=\"avatarMode\"]:checked').value") };
    check(same(undone, before) && undone.avatar === before.avatar && undone.avatarMode === before.avatarMode,
      `Undo puts back the name, message and avatar from before (${JSON.stringify({ ...undone, avatar: undone.avatar.slice(0, 40) })})`);
    await click('premiere-cancel');
    check(await js("document.getElementById('premiere').hidden"), 'Close hides the bar');

    // A typing video at 3×: rendered at that size, whatever the video's.
    const second = await sendFrame(frame, box, 'Sequence 01 at 00:00:09:12');
    await poll(() => jobState(second.json.id), (j) => j?.state !== 'reading', 90_000, 'the second reading');
    await setScale('3');
    check(await js("document.getElementById('premiere-scale').textContent") === 'At 3× (Scale, below)', 'the bar follows the Scale');
    await click('premiere-video');
    const video = await settled(second.json.id, 'the typing video');
    check(video.state === 'done' && video.file?.kind === 'mp4' && Math.abs(video.file.width - 2 * shot.width) <= 1 && video.file.duration > 0.5,
      `"Send typing video" at 3× hands over an MP4 of ${video.file?.width} × ${video.file?.height} px, ${video.file?.duration?.toFixed(1)} s (${video.message})`);
    const mp4 = await ask(`/v1/jobs/${second.json.id}/file`);
    check(mp4.type === 'video/mp4' && mp4.bytes.toString('latin1', 4, 8) === 'ftyp', `the panel fetches the MP4 (${mp4.bytes.length} bytes)`);
    await setScale('1.5');
    await click('premiere-cancel');

    // A member's comment with a timestamp: the time is read from the frame and the badge cut out of it, so the
    // image sent back matches the original.
    const narrow = String.fromCharCode(0x202f);
    const member = comment('@pebble_parade', 'the bassline in this one is unreal', {
      role: 'member', timestamp: `2:41${narrow}PM`, memberBadgeSrc: appUrl('test/visual/fixtures/member-badge-32.png'),
    });
    const memberShot = await captureComment(member, { scale: 1.5 });
    const memberAt = { x: 260, y: 140 };
    const memberBox = { x: memberAt.x - 10, y: memberAt.y - 8, width: memberShot.width + 30, height: memberShot.height + 16 };
    const timeControls = "({ on: document.getElementById('timestamp-on').checked, text: document.getElementById('timestamp').value })";
    const timeBefore = await js(timeControls);
    const fourth = await sendFrame(videoFrame(1280, 720, [15, 15, 15], memberShot.png, memberAt), memberBox);
    await poll(() => jobState(fourth.json.id), (j) => j?.state !== 'reading', 90_000, "the member's reading");
    const look = await js(`(() => ({
      role: document.querySelector('input[name="role"]:checked').value,
      timestampOn: document.getElementById('timestamp-on').checked,
      timestamp: document.getElementById('timestamp').value,
      badge: !document.getElementById('badge-thumb').hidden,
    }))()`);
    check(look.role === 'member' && look.timestampOn && look.timestamp === '2:41 PM' && look.badge,
      `the video's role, timestamp and member badge are taken: ${JSON.stringify(look)}`);
    await click('premiere-image');
    const memberSent = await settled(fourth.json.id, "the member's image");
    const memberFile = memberSent.state === 'done' ? await ask(`/v1/jobs/${fourth.json.id}/file`) : null;
    if (memberFile?.status === 200) {
      const [a, b] = [pixelsOf(memberFile.bytes), pixelsOf(memberShot.png)];
      let off = a.width === b.width && a.height === b.height ? 0 : Infinity;
      for (let i = 0; Number.isFinite(off) && i < a.data.length; i += 4) {
        if (Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2])) > 24) off++;
      }
      const share = off / (b.width * b.height);
      check(share < 0.01, `and the image sent back matches it: ${(100 * share).toFixed(2)}% of pixels differ visibly`);
    } else {
      check(false, `the member's image was sent back (${memberSent.state}: ${memberSent.message})`);
    }
    await setScale(scaleBefore);
    await click('read-undo');
    const timeAfter = await js(timeControls);
    check(timeAfter.on === timeBefore.on && timeAfter.text === timeBefore.text, `Undo puts the timestamp back as it was (${JSON.stringify(timeAfter)})`);
    await click('premiere-cancel');

    // The panel gives a job up; a frame with no comment in it fails with the reason.
    const third = await sendFrame(frame, box);
    await poll(() => jobState(third.json.id), (j) => j?.state !== 'reading', 90_000, 'the third reading');
    await ask(`/v1/jobs/${third.json.id}/cancel`, { method: 'POST' });
    const cancelled = await poll(premiereBar, (b) => b.close === 'Close', 10_000, 'the cancel to reach the editor');
    check(cancelled.status === 'Premiere Pro cancelled this comment.' && !cancelled.send, `a cancel from the panel shows in the bar: "${cancelled.status}"`);
    const empty = await sendFrame(videoFrame(640, 360, [15, 15, 15]), { x: 20, y: 20, width: 300, height: 60 });
    const failedJob = await settled(empty.json.id, 'the empty frame');
    const failedBar = await premiereBar();
    check(failedJob.state === 'failed' && /text|comment/i.test(failedJob.message) && failedBar.close === 'Close' && /Draw the box again/.test(failedBar.status),
      `a box with no comment in it fails: "${failedJob.message}" / "${failedBar.status}"`);
    await click('premiere-cancel');
  }
  wc.debugger.detach();

  // (app:// is served from file:// reads, which pass through here too.)
  const offline = requests.filter((url) => !/^(app|file|data|blob):/.test(url) && !url.startsWith('https://fonts.gstatic.com/'));
  check(offline.length === 0, `reading screenshots needs no network (${offline.length ? offline.join(', ') : `${requests.length} requests, all local or emoji`})`);
  session.defaultSession.webRequest.onBeforeRequest(null);

  console.log('\n== Navigation and pop-ups');
  check(await js("window.open('https://example.com/') === null"), 'window.open is denied');
  check(BrowserWindow.getAllWindows().length <= 2, `no extra windows (${BrowserWindow.getAllWindows().length} total incl. the hidden capture window)`);
  await js("setTimeout(() => { location.href = 'https://example.com/'; }, 0); true");
  await delay(500);
  check(wc.getURL().startsWith(EDITOR_PREFIX), `navigating away is blocked (still at ${wc.getURL()})`);
  // The editor's CSP (frame-src 'self') stops this before will-frame-navigate would; either way it must fail.
  const failed = [];
  const onFail = (_event, code, description, url, isMainFrame) => { if (!isMainFrame) failed.push({ code, description, url }); };
  wc.on('did-fail-load', onFail);
  await js("document.getElementById('preview').src = 'https://example.com/'; true");
  await delay(800);
  wc.off('did-fail-load', onFail);
  const blocked = failed.find((f) => f.url === 'https://example.com/');
  check(Boolean(blocked) && [-30, -3, -20, -27].includes(blocked.code), `the preview frame cannot load other sites (${blocked ? `${blocked.description} ${blocked.code}` : 'no failure seen'})`);

  console.log('\n== Relaunch with saved state');
  // Every launch after the first restores the editor from localStorage; reloading runs that same path.
  await js(`(() => {
    const name = document.getElementById('name');
    name.value = '@RelaunchCheck';
    name.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  // (No preview wait here: the navigation checks above left an error page in the preview frame;
  // the reload below brings it back.)
  const reloaded = new Promise((resolve) => wc.once('did-finish-load', resolve));
  wc.reload(); // 'pagehide' saves the state at once
  await reloaded;
  const reloadStarted = performance.now();
  const afterReload = await poll(() => js('document.documentElement.dataset.preview'), (v) => v === 'ready' || v === 'error', 40_000, 'the preview after reload');
  console.log(`        (preview ${afterReload} ${((performance.now() - reloadStarted) / 1000).toFixed(1)} s after reload; note: ${await js("document.getElementById('preview-note').textContent")})`);
  check(afterReload === 'ready', 'after a reload with saved state the preview renders');
  check(await js("document.getElementById('name').value") === '@RelaunchCheck', 'the saved name is restored');
  check(await js("document.getElementById('avatar-image').hidden === false"), 'the uploaded avatar is restored');

  console.log('\n== Console');
  const fromEditor = recorded.console.filter((m) => m.page.startsWith(EDITOR_PREFIX) && (m.level === 'error' || m.level === 'warning'));
  const network = fromEditor.filter((m) => /fonts\.gstatic\.com|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED/.test(m.message));
  for (const m of network) note(`network: ${m.message}`);
  const problems = fromEditor.filter((m) => !network.includes(m) && !/example\.com/.test(m.message));
  for (const m of problems) console.log(`        ${m.level}: ${m.message} (${m.source})`);
  check(problems.length === 0, `no console errors or warnings from the editor (${recorded.console.filter((m) => m.page.startsWith(EDITOR_PREFIX)).length} messages in total)`);
  const captureErrors = recorded.console.filter((m) => m.page.startsWith(STAGE_URL) && m.level === 'error');
  for (const m of captureErrors) console.log(`        capture window: ${m.message} (${m.source})`);
  check(captureErrors.length === 0, 'no console errors from the hidden capture window');
}

function finish() {
  if (notes.length) console.log(`\n${notes.length} note(s):\n${notes.map((n) => `  - ${n}`).join('\n')}`);
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll app checks passed');
  app.exit(failures ? 1 : 0);
}

// main.js quits straight away when another instance holds the single-instance lock (keyed by the profile).
if (!app.hasSingleInstanceLock()) {
  console.error(`FAIL  another instance is using the smoke-test profile ${app.getPath('userData')}; is a smoke run already going?`);
  app.exit(1);
}

app.whenReady()
  .then(run)
  .catch((error) => {
    failures++;
    console.error(error);
  })
  .finally(finish);
