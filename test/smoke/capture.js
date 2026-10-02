// Smoke test for electron/capture.js. Run: node scripts/electron.js test/smoke/capture.js [options]
//   --stub-only     skip the real stage (src/stage/stage.html) even when it exists
//   --force-dsf=N   run as if every display had scale factor N (Chromium switch), write the PNGs to
//                   out/smoke/dsf-N/ and compare them with a normal run's: zoom-based scaling on a 1×
//                   display must give the same pixels as a real N× display.
// Captures sample comments at several scales through the hidden stage window, checks PNG sizes and
// content, robustness (concurrency, bad input, timeouts, renderer crash, stale frames, zoom isolation),
// captureRegion() on a page in another in-memory partition, and writes the PNGs to test/visual/out/smoke/.
import { app, BrowserWindow, nativeImage, screen, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT, appUrl, handleAppScheme, registerAppScheme } from '../../electron/protocol.js';
import {
  DEFAULT_STAGE_URL, applyCaptureScale, captureComment, captureRegion, configureCapture, deviceRect, disposeCapture, pngSize,
} from '../../electron/capture.js';

const forcedDsf = process.argv.find((arg) => arg.startsWith('--force-dsf='))?.split('=')[1];
if (forcedDsf) app.commandLine.appendSwitch('force-device-scale-factor', forcedDsf);
registerAppScheme();

const BASE_DIR = path.join(APP_ROOT, 'test', 'visual', 'out', 'smoke');
// Own profile: scripts run as bare entries share %APPDATA%/Electron, where Chromium persists per-host zoom.
app.setPath('userData', path.join(BASE_DIR, 'user-data'));
const OUT_DIR = forcedDsf ? path.join(BASE_DIR, `dsf-${forcedDsf}`) : BASE_DIR;
const STUB_URL = appUrl('test/smoke/stub-stage.html');
const REAL_STAGE_FILE = path.join(APP_ROOT, 'src', 'stage', 'stage.html');
const SCALES = [1, 1.25, 1.5, 2];
const BG = { dark: [0x0f, 0x0f, 0x0f], light: [0xff, 0xff, 0xff] };

let failures = 0;
const notes = [];
const written = [];
function check(ok, label) {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${label}`);
  return ok;
}
const note = (text) => { notes.push(text); console.log(`  note  ${text}`); };
const ms = (t0) => `${(performance.now() - t0).toFixed(0)} ms`;

/** A square avatar: solid colour with a lighter centre, so circular clipping is visible in the PNG. */
function makeAvatarDataUrl(size = 88) {
  const bgra = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inner = Math.hypot(x - size / 2, y - size / 2) < size / 4;
      bgra.set(inner ? [0xff, 0xe0, 0xc0, 0xff] : [0xc0, 0x6b, 0x5c, 0xff], (y * size + x) * 4);
    }
  }
  return nativeImage.createFromBitmap(bgra, { width: size, height: size }).toDataURL();
}

let AVATAR;
const sampleProps = (overrides = {}) => ({
  name: '@YourChannel',
  message: 'This stream is amazing \u{1F525}',
  theme: 'dark',
  role: 'viewer',
  verified: false,
  avatarSrc: AVATAR,
  memberBadgeSrc: null,
  timestamp: null,
  rowWidth: 400,
  margin: 0,
  ...overrides,
});

/** Pixel checks on the decoded PNG: not blank, and the corner shows the chat background. */
function inspect(png, theme) {
  const image = nativeImage.createFromBuffer(png);
  const { width, height } = image.getSize();
  const bgra = image.toBitmap();
  const colours = new Set();
  for (let i = 0; i < bgra.length && colours.size < 64; i += 4) colours.add(bgra.readUInt32LE(i));
  const corner = [bgra[2], bgra[1], bgra[0]];
  return {
    width,
    height,
    colours: colours.size,
    corner,
    cornerIsBackground: BG[theme].every((v, i) => Math.abs(v - corner[i]) <= 1),
  };
}

const fileFor = (label, scale) => `${label}-${String(scale).replace('.', '_')}x.png`;

async function captureAndCheck(label, props, scale, { expectWidth, expectHeight, write = true, exactBackground = true } = {}) {
  const t0 = performance.now();
  let result;
  try {
    result = await captureComment(props, { scale });
  } catch (error) {
    check(false, `${label} @${scale}×: threw ${error.message}`);
    return null;
  }
  const elapsed = ms(t0);
  const { png, width, height, box, stable } = result;
  const ihdr = pngSize(png);
  const wantW = expectWidth ?? Math.round(box.width * scale);
  const wantH = expectHeight ?? Math.round(box.height * scale);
  const px = inspect(png, props.theme);
  check(ihdr.width === width && ihdr.height === height && px.width === width && px.height === height,
    `${label} @${scale}×: reported size matches the PNG`);
  check(width === wantW && height === wantH,
    `${label} @${scale}×: ${width}×${height} px (expected ${wantW}×${wantH}; box ${box.width}×${box.height} at ${box.x},${box.y}) [${elapsed}]`);
  check(stable, `${label} @${scale}×: two consecutive frames identical`);
  check(px.colours > 2, `${label} @${scale}×: not blank (${px.colours}${px.colours >= 64 ? '+' : ''} distinct colours)`);
  if (exactBackground) check(px.cornerIsBackground, `${label} @${scale}×: top-left pixel is the ${props.theme} chat background (rgb ${px.corner.join(',')})`);
  else if (!px.cornerIsBackground) note(`${label} @${scale}×: top-left pixel rgb ${px.corner.join(',')} is not the plain ${props.theme} background`);
  if (write) {
    const file = path.join(OUT_DIR, fileFor(label, scale));
    fs.writeFileSync(file, png);
    written.push(file);
  }
  return result;
}

async function expectRejection(label, promise, pattern, withinMs) {
  const t0 = performance.now();
  try {
    await promise;
    check(false, `${label}: resolved, expected an error`);
  } catch (error) {
    const elapsed = performance.now() - t0;
    check(pattern.test(error.message) && (!withinMs || elapsed < withinMs), `${label}: rejected in ${elapsed.toFixed(0)} ms with "${error.message}"`);
  }
}

async function stubSuite() {
  console.log(`\n== Stub stage (${STUB_URL})`);
  configureCapture({ stageUrl: STUB_URL });

  // A window on the default session at the same origin, like the editor: capture zoom must not reach it.
  const neighbour = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: { sandbox: true, contextIsolation: true } });
  await neighbour.loadURL(STUB_URL);
  const neighbourZoom = neighbour.webContents.getZoomFactor();
  const neighbourDpr = await neighbour.webContents.executeJavaScript('devicePixelRatio');

  let t0 = performance.now();
  await captureAndCheck('stub-dark', sampleProps(), 1, { expectWidth: 400, expectHeight: 32, write: false });
  console.log(`        first capture incl. window + page load: ${ms(t0)}`);
  for (const scale of SCALES) {
    await captureAndCheck('stub-dark', sampleProps(), scale, { expectWidth: Math.round(400 * scale), expectHeight: Math.round(32 * scale) });
  }
  await captureAndCheck('stub-light-timestamp', sampleProps({ theme: 'light', timestamp: '2:41 PM' }), 1.5, { expectWidth: 600, expectHeight: 48 });
  await captureAndCheck('stub-dark', sampleProps(), 1.75, { expectWidth: 700, expectHeight: 56 });
  await captureAndCheck('stub-dark', sampleProps(), 3, { expectWidth: 1200, expectHeight: 96 });
  await captureAndCheck('stub-dark', sampleProps(), 0.5, { expectWidth: 200, expectHeight: 16 });
  await captureAndCheck('stub-dark', sampleProps(), 4, { expectWidth: 1600, expectHeight: 128 });

  console.log('\n-- odd geometry / rounding');
  // 347 CSS px: × 1.25 = 433.75 and × 1.75 = 607.25 (non-integer device sizes).
  await captureAndCheck('stub-odd', sampleProps({ rowWidth: 333, margin: 7 }), 1.25, { expectWidth: 434 });
  await captureAndCheck('stub-odd', sampleProps({ rowWidth: 333, margin: 7 }), 1.75, { expectWidth: 607 });
  // Fractional box height (32.5 CSS px) and a box that does not start at the document origin.
  await captureAndCheck('stub-fractional', sampleProps({ _extraHeight: 0.5 }), 1.25, { expectWidth: 500, expectHeight: 41 });
  await captureAndCheck('stub-offset', sampleProps({ _offset: 10, margin: 6 }), 1.5, { expectWidth: 618, expectHeight: 66 });
  // Multi-line message, and a capture far larger than the 1200×900 window.
  await captureAndCheck('stub-multiline', sampleProps({ rowWidth: 240, message: 'word '.repeat(60) }), 2);
  await captureAndCheck('stub-huge', sampleProps({ rowWidth: 1200, margin: 200, message: 'word '.repeat(300) + 'END' }), 2);

  console.log('\n-- stale frames: alternating comments must reproduce their reference images exactly');
  const a = sampleProps({ name: '@alpha', message: 'first comment' });
  const b = sampleProps({ name: '@beta', message: 'a different, longer second comment', theme: 'light' });
  const refA = (await captureComment(a, { scale: 1.5 })).png;
  const refB = (await captureComment(b, { scale: 1.25 })).png;
  let mismatches = 0;
  for (let i = 0; i < 6; i++) {
    const [props, scale, ref] = i % 2 ? [b, 1.25, refB] : [a, 1.5, refA];
    if (!(await captureComment(props, { scale })).png.equals(ref)) mismatches++;
  }
  check(mismatches === 0, `6 alternating captures (different text, theme and scale) matched their references (${mismatches} mismatches)`);

  console.log('\n-- concurrency (4 captures queued at once)');
  t0 = performance.now();
  const scales = [2, 1, 1.5, 1.25];
  const order = [];
  const results = await Promise.all(scales.map((scale, i) => captureComment(sampleProps({ name: `@user${i}` }), { scale })
    .then((r) => { order.push(i); return r; })));
  check(results.every((r, i) => r.width === Math.round(400 * scales[i]) && r.height === Math.round(32 * scales[i])),
    `concurrent captures sized ${results.map((r) => `${r.width}×${r.height}`).join(', ')} [${ms(t0)} total]`);
  check(order.join() === '0,1,2,3', `concurrent captures completed in submission order (${order.join(',')})`);

  console.log('\n-- warm timings');
  for (const scale of [1, 2]) {
    const times = [];
    for (let i = 0; i < 5; i++) {
      t0 = performance.now();
      await captureComment(sampleProps({ message: `timing run ${i}` }), { scale });
      times.push(performance.now() - t0);
    }
    console.log(`        @${scale}×: ${times.map((t) => t.toFixed(0)).join(', ')} ms (scale unchanged, text changes)`);
  }
  t0 = performance.now();
  for (const scale of [1, 1.5, 2, 1.25]) await captureComment(sampleProps(), { scale });
  console.log(`        4 captures alternating scale: ${ms(t0)}`);

  check(neighbour.webContents.getZoomFactor() === neighbourZoom && (await neighbour.webContents.executeJavaScript('devicePixelRatio')) === neighbourDpr,
    `same-origin window on the default session kept zoom ${neighbourZoom} / devicePixelRatio ${neighbourDpr}`);
  neighbour.destroy();

  console.log('\n-- input validation (must reject before touching the window)');
  for (const scale of [0, 0.25, 5, NaN, Infinity, '2', undefined]) {
    await expectRejection(`scale ${String(scale)}`, captureComment(sampleProps(), { scale }), /scale must be/, 50);
  }
  for (const props of [null, [], 'x']) {
    await expectRejection(`props ${JSON.stringify(props)}`, captureComment(props, { scale: 1 }), /props must be an object/, 50);
  }
  await expectRejection('missing options', captureComment(sampleProps()), /scale must be/, 50);
  await expectRejection('oversized output', captureComment(sampleProps({ rowWidth: 5000 }), { scale: 4 }), /too large to export/, 5000);

  console.log('\n-- timeout, crash recovery, broken stages');
  configureCapture({ timeoutMs: 1500 });
  await expectRejection('stage.render never settles', captureComment(sampleProps({ _hang: true }), { scale: 1 }), /timed out/, 4000);
  configureCapture({ timeoutMs: 20_000 });
  await captureAndCheck('stub-after-timeout', sampleProps(), 1, { expectWidth: 400, expectHeight: 32, write: false });

  const stageWindow = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === STUB_URL);
  if (check(Boolean(stageWindow), 'hidden stage window exists')) {
    check(!stageWindow.isVisible(), 'stage window is not visible');
    stageWindow.webContents.forcefullyCrashRenderer();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await captureAndCheck('stub-after-crash', sampleProps(), 1.5, { expectWidth: 600, expectHeight: 48, write: false });
  }

  configureCapture({ stageUrl: appUrl('test/smoke/no-such-stage.html') });
  await expectRejection('stage page 404', captureComment(sampleProps(), { scale: 1 }), /Could not load the stage page .*HTTP 404/, 1500);
  configureCapture({ stageUrl: appUrl('src/styles/roboto.css') });
  await expectRejection('page without stage.render', captureComment(sampleProps(), { scale: 1 }), /does not expose window\.stage\.render/, 8000);
  configureCapture({ stageUrl: STUB_URL });
  await captureAndCheck('stub-recovered', sampleProps(), 1, { expectWidth: 400, expectHeight: 32, write: false });
}

async function regionSuite() {
  console.log('\n== captureRegion on pages in another in-memory partition');
  const ses = session.fromPartition('smoke-region');
  handleAppScheme(ses);
  const win = new BrowserWindow({
    show: false, width: 800, height: 600, useContentSize: true, paintWhenInitiallyHidden: true,
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  const wc = win.webContents;
  const measure = (selector) => wc.executeJavaScript(`(async () => {
    await document.fonts.load('13px Roboto', 'a');
    await document.fonts.ready;
    const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  })()`);
  try {
    // The golden harness's path (its own window + captureRegion) must equal the app's (captureComment).
    configureCapture({ stageUrl: STUB_URL });
    await win.loadURL(STUB_URL);
    for (const scale of [1, 1.25, 1.5, 2]) {
      await applyCaptureScale(wc, scale);
      const box = await wc.executeJavaScript(`stage.render(${JSON.stringify(sampleProps())})
        .then(({ x, y, width, height }) => ({ x, y, width, height }))`);
      const region = await captureRegion(wc, box, scale);
      const comment = await captureComment(sampleProps(), { scale });
      check(region.png.equals(comment.png) && region.stable,
        `stub @${scale}×: captureRegion in another partition === captureComment (${region.width}×${region.height})`);
    }

    // A script-free page, a fractional rect and both snapping rules.
    await win.loadURL(appUrl('test/smoke/region.html'));
    for (const scale of [1, 1.25, 1.5]) {
      await applyCaptureScale(wc, scale);
      const rect = await measure('#target');
      for (const snap of ['round', 'outward']) {
        const want = deviceRect(rect, scale, snap);
        const result = await captureRegion(wc, rect, scale, { snap });
        const px = inspect(result.png, 'dark');
        check(result.width === want.width && result.height === want.height && px.colours > 2 && result.stable,
          `region.html #target ${JSON.stringify(rect)} @${scale}× snap ${snap}: ${result.width}×${result.height} at ${want.x},${want.y}`);
        if (scale === 1.25) fs.writeFileSync(path.join(OUT_DIR, `region-${snap}-1_25x.png`), result.png);
      }
    }
    const far = await measure('#far');
    const [w0, h0] = win.getContentSize();
    const farShot = await captureRegion(wc, far, 2);
    const [w1, h1] = win.getContentSize();
    check(farShot.width === Math.round(far.width * 2) && h1 > h0 && inspect(farShot.png, 'dark').colours > 2,
      `region below the viewport (y=${far.y}) @2×: window grew ${w0}×${h0} → ${w1}×${h1} DIP, ${farShot.width}×${farShot.height} px`);

    // Scroll at the scale it is captured at (changing the zoom can make the page fit, which unscrolls it).
    await wc.executeJavaScript('window.scrollTo(0, 120)');
    await expectRejection('scrolled page', captureRegion(wc, far, 2), /page is scrolled/, 5000);
    await wc.executeJavaScript('window.scrollTo(0, 0)');
    for (const rect of [null, { x: 0, y: 0, width: 0, height: 10 }, { x: -1, y: 0, width: 5, height: 5 }, { x: 0, y: 0, width: NaN, height: 5 }]) {
      await expectRejection(`rect ${JSON.stringify(rect)}`, captureRegion(wc, rect, 1), /invalid rect/, 50);
    }
    await expectRejection('bad snap', captureRegion(wc, far, 1, { snap: 'floor' }), /snap must be/, 50);
    await expectRejection('scale 9', captureRegion(wc, far, 9), /scale must be/, 50);
  } finally {
    win.destroy();
  }
}

async function realStageSuite() {
  if (!fs.existsSync(REAL_STAGE_FILE)) {
    note(`real stage not present (${path.relative(APP_ROOT, REAL_STAGE_FILE)}); skipped`);
    return;
  }
  console.log(`\n== Real stage (${DEFAULT_STAGE_URL})`);
  configureCapture({ stageUrl: DEFAULT_STAGE_URL });
  try {
    await captureComment(sampleProps(), { scale: 1 });
  } catch (error) {
    if (/does not expose window\.stage\.render|Could not load the stage page/.test(error.message)) {
      note(`real stage not usable yet; skipped (${error.message})`);
      return;
    }
  }
  for (const theme of ['dark', 'light']) {
    for (const scale of SCALES) {
      await captureAndCheck(`real-${theme}`, sampleProps({ theme }), scale, { exactBackground: false });
    }
  }
  await captureAndCheck('real-moderator-ts', sampleProps({ role: 'moderator', verified: true, timestamp: '2:41 PM' }), 1.5, { exactBackground: false });
  await captureAndCheck('real-member', sampleProps({ role: 'member' }), 1.25, { exactBackground: false });
  await captureAndCheck('real-owner', sampleProps({ role: 'owner', theme: 'light' }), 1.75, { exactBackground: false });
  await captureAndCheck('real-multiline', sampleProps({ rowWidth: 300, margin: 8, message: 'word '.repeat(40) }), 1.5, { exactBackground: false });
}

/** With --force-dsf=N: the N× capture here (zoom 1) must equal the normal run's N× capture (zoom N). */
function compareWithBaseline() {
  let compared = 0;
  for (const file of written) {
    const baseline = path.join(BASE_DIR, path.basename(file));
    if (!fs.existsSync(baseline)) continue;
    const a = nativeImage.createFromPath(file);
    const b = nativeImage.createFromPath(baseline);
    const [sa, sb] = [a.getSize(), b.getSize()];
    let differing = -1;
    if (sa.width === sb.width && sa.height === sb.height) {
      const [pa, pb] = [a.toBitmap(), b.toBitmap()];
      differing = 0;
      for (let i = 0; i < pa.length; i += 4) if (pa.readUInt32LE(i) !== pb.readUInt32LE(i)) differing++;
    }
    compared++;
    check(differing === 0, `${path.basename(file)}: real ${forcedDsf}× display vs zoom on the baseline display: ${differing < 0 ? `size ${sa.width}×${sa.height} vs ${sb.width}×${sb.height}` : `${differing} differing pixels`}`);
  }
  if (!compared) note('no baseline PNGs to compare with; run once without --force-dsf first');
}

async function main() {
  await app.whenReady();
  handleAppScheme(session.defaultSession);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  AVATAR = makeAvatarDataUrl();

  const primary = screen.getPrimaryDisplay();
  console.log(`Electron ${process.versions.electron} / Chromium ${process.versions.chrome}; primary display scale ${primary.scaleFactor}${forcedDsf ? ` (forced ${forcedDsf})` : ''}`);
  await stubSuite();
  await regionSuite();
  if (!process.argv.includes('--stub-only')) await realStageSuite();
  if (forcedDsf) {
    console.log('\n== Comparison with the baseline run');
    compareWithBaseline();
  }
  disposeCapture();

  console.log(`\n${written.length} PNGs written to ${OUT_DIR}`);
  if (notes.length) console.log(`${notes.length} note(s):\n${notes.map((n) => `  - ${n}`).join('\n')}`);
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll capture checks passed');
  app.exit(failures ? 1 : 0);
}

// Keep running while the hidden stage window is recreated between tests.
app.on('window-all-closed', () => {});
main().catch((error) => {
  console.error(error);
  app.exit(1);
});
