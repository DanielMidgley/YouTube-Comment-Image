// End-to-end check of the real app. Run: node scripts/electron.js test/smoke/app.js
// Starts electron/main.js (editor hidden, throwaway profile, recorded save dialog and clipboard), waits for
// the editor and its live preview, then drives it like a user: File > Save PNG… and Copy Image through the
// menu, scale/theme changes, an avatar upload through the file input, invalid IPC input, blocked
// navigation. Fails on any console error or warning from the editor (and errors from the capture window).
import { OUT_DIR, recorded } from './app-setup.js'; // must stay the first import
import '../../electron/main.js';
import { app, BrowserWindow, Menu, nativeImage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { appUrl } from '../../electron/protocol.js';
import { pngSize } from '../../electron/capture.js';

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
  check(await js("Object.keys(window.ytComment).sort().join()") === 'capture,copy,getDisplayScale,onDisplayScaleChange,onMenuCommand,save,saveVideo',
    'window.ytComment exposes exactly its eight calls');
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
