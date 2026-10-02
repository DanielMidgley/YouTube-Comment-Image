// Turns RenderProps into a PNG. The comment is rendered by the same stage page the editor previews, in a
// hidden window, and copied out of that window's compositor output (webContents.capturePage): the very
// pixels Chromium would put on screen, ClearType text included. Other scale factors are reached with page
// zoom. Chromium implements device scale factors as zoom as well (zoom-for-DSF), so a page at zoom
// scale/dsf renders like a page on a display whose scale factor is `scale` (pixel-identical to forced
// 1.5×/2×/3× displays and to offscreen rendering at a true device scale factor; see test/smoke/capture.js).
//
// Not CDP: Page.captureScreenshot never resolves for a hidden window (it waits for the frame to be
// presented on screen), and capturePage ignores Emulation.setDeviceMetricsOverride's scale factor.
//
// captureRegion() is the generic path (any page, any rect); captureComment() drives the stage through it,
// and the golden harness uses it for YouTube's own page, so both sides of that comparison match.
import { BrowserWindow, session } from 'electron';
import { SCHEME, appUrl, handleAppScheme } from './protocol.js';

export const DEFAULT_STAGE_URL = appUrl('src/stage/stage.html');
export const MIN_SCALE = 0.5;
export const MAX_SCALE = 4;

// Page zoom is remembered per host (and persisted by persistent sessions), and app://local is also the
// editor's host, so the stage window lives in its own in-memory session: its zoom never reaches the editor.
const PARTITION = 'youtube-comment-capture';
// The initial window must fit on any screen: Windows shrinks a window that does not fit when it is created,
// to an arbitrary size that at 125 %/175 % is not a whole number of device pixels. Larger comments grow it
// with setContentSize, which is not clamped. Position and size are multiples of 4 DIP.
const WINDOW_BOUNDS = { x: 0, y: 0, width: 640, height: 480 };
const LOAD_TIMEOUT_MS = 15_000;
const CAPTURE_TIMEOUT_MS = 20_000;
const SETTLE_TIMEOUT_MS = 2_000;
const STABLE_FRAME_BUDGET_MS = 1_500;
const DPR_EPSILON = 1e-3;
const SNAP_EPSILON = 1e-3; // device px; absorbs float noise such as 400.0000305 CSS px at 1.75×
// Chromium cannot allocate surfaces beyond its max texture size; refuse early with a clear message.
const MAX_OUTPUT_SIDE = 16_384;
const MAX_OUTPUT_PIXELS = 50_000_000;

const config = { stageUrl: DEFAULT_STAGE_URL, timeoutMs: CAPTURE_TIMEOUT_MS };
let stage = null; // { win, ready: Promise<stage> } for the current hidden stage window
let queue = Promise.resolve();

class CaptureTimeoutError extends Error {}

/** Test hooks: another page implementing the stage contract, and/or a different per-capture timeout. */
export function configureCapture({ stageUrl, timeoutMs } = {}) {
  if (timeoutMs !== undefined) config.timeoutMs = timeoutMs;
  if (stageUrl !== undefined && stageUrl !== config.stageUrl) {
    config.stageUrl = stageUrl;
    disposeCapture();
  }
}

/** The session the stage window uses (app:// is served in it); harnesses may add handlers to it. */
export function getCaptureSession() {
  const ses = session.fromPartition(PARTITION);
  if (!ses.protocol.isProtocolHandled(SCHEME)) {
    handleAppScheme(ses);
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
  }
  return ses;
}

/**
 * Renders `props` (RenderProps) on the stage and captures the box it reports at `scale` device pixels per
 * CSS pixel. Captures are serialised. Resolves to { png, width, height, box, scale, stable, warnings }
 * (warnings: strings from the stage, e.g. an emoji drawn as text because it could not be downloaded).
 */
export function captureComment(props, { scale } = {}) {
  if (props === null || typeof props !== 'object' || Array.isArray(props)) {
    return Promise.reject(new TypeError('captureComment: props must be an object.'));
  }
  if (!isValidScale(scale)) return Promise.reject(scaleError('captureComment'));
  const job = queue.then(() => withTimeout(captureOnce(props, scale), config.timeoutMs, 'Capturing the comment'));
  // A failed or timed-out capture must not block the ones queued after it.
  queue = job.catch((error) => {
    // Whatever the stalled capture was waiting on may still complete later; start from a fresh window.
    if (error instanceof CaptureTimeoutError) disposeCapture();
  });
  return job;
}

/**
 * Zooms the page in `webContents` so that its devicePixelRatio is `scale`, and waits until the page sees
 * it. Call it before measuring what you will pass to captureRegion, so layout happens at the scale it is
 * captured at. Resolves to the zoom factor. Zoom is shared by every page of the same host in the session
 * and persisted by persistent sessions: only use this on windows in an in-memory partition.
 */
export function applyCaptureScale(webContents, scale) {
  if (!isValidScale(scale)) return Promise.reject(scaleError('applyCaptureScale'));
  if (!webContents || webContents.isDestroyed?.() !== false) return Promise.reject(new TypeError('applyCaptureScale: webContents is not usable.'));
  return applyScale(webContents, scale);
}

/**
 * Captures `cssRect` ({ x, y, width, height } in CSS px from the document's top-left; the page must not be
 * scrolled) of the page in `webContents` at `scale` device pixels per CSS pixel, as a screenshot of a
 * display with that scale factor would show it. Applies the scale (see applyCaptureScale, same caveats),
 * grows the owning window if the rect lies beyond its viewport (it never shrinks it), waits for a stable
 * frame and crops in device pixels:
 *   snap 'round' (default): x = round(x·scale), width = round(width·scale) (exact box size, the app's rule);
 *   snap 'outward': the smallest whole-device-pixel rect enclosing the region (screen-snip semantics).
 * Needs only executeJavaScript and requestAnimationFrame in the page. Resolves to
 * { png, width, height, crop, stable }; stable is false if the region was still changing after 1.5 s
 * (the latest frame is used). Don't run two captures on the same webContents at once.
 */
export function captureRegion(webContents, cssRect, scale, { snap = 'round' } = {}) {
  if (!isValidScale(scale)) return Promise.reject(scaleError('captureRegion'));
  if (!webContents || webContents.isDestroyed?.() !== false) return Promise.reject(new TypeError('captureRegion: webContents is not usable.'));
  const rect = cssRect && { x: cssRect.x, y: cssRect.y, width: cssRect.width, height: cssRect.height };
  if (!isValidRect(rect)) return Promise.reject(new TypeError(`captureRegion: invalid rect ${JSON.stringify(cssRect)}.`));
  if (snap !== 'round' && snap !== 'outward') return Promise.reject(new TypeError("captureRegion: snap must be 'round' or 'outward'."));
  return withTimeout(captureRegionNow(webContents, rect, scale, snap), config.timeoutMs, 'Capturing the region');
}

/** Closes the hidden stage window (it is recreated on the next capture). */
export function disposeCapture() {
  const current = stage;
  stage = null;
  if (current && !current.win.isDestroyed()) current.win.destroy();
}

async function captureOnce(props, scale) {
  const { win } = await ensureStage();
  const wc = win.webContents;
  const zoom = await applyScale(wc, scale);

  // The stage lays the row out at a fixed width from the top-left corner, so the viewport only has to be
  // big enough. If the window had to grow, measure again in case the layout depends on it after all.
  let { box, warnings } = await renderOnStage(wc, props);
  for (let pass = 0; pass < 2; pass++) {
    checkOutputSize(box, scale);
    if (!(await ensureViewport(win, box, zoom))) break;
    const again = await renderOnStage(wc, props);
    warnings = again.warnings;
    if (sameBox(again.box, box)) break;
    box = again.box;
  }

  const { png, width, height, stable } = await captureRegionNow(wc, box, scale, 'round');
  return { png, width, height, box, scale, stable, warnings };
}

async function captureRegionNow(wc, rect, scale, snap) {
  const zoom = await applyScale(wc, scale);
  checkOutputSize(rect, scale);
  const scroll = await wc.executeJavaScript('({ x: window.scrollX, y: window.scrollY })');
  if (scroll.x !== 0 || scroll.y !== 0) throw new Error(`captureRegion: the page is scrolled (${scroll.x}, ${scroll.y}); rects are taken from the document origin.`);
  const win = BrowserWindow.fromWebContents(wc);
  if (win) await ensureViewport(win, rect, zoom);
  await nextFrames(wc, 2);

  // Copy from the document origin (in DIP, with 1 DIP of slack so rounding can never come up short) and
  // crop in device pixels, so fractional positions are rounded once, in the output's own pixel grid.
  const crop = deviceRect(rect, scale, snap);
  const toDip = zoom / scale; // device px → DIP (1 / the window's real device scale factor)
  let area = { x: 0, y: 0, width: Math.ceil((crop.x + crop.width) * toDip) + 1, height: Math.ceil((crop.y + crop.height) * toDip) + 1 };
  if (win) {
    const [viewWidth, viewHeight] = win.getContentSize();
    area = { ...area, width: Math.min(viewWidth, area.width), height: Math.min(viewHeight, area.height) };
  }
  const { image, stable } = await captureStableFrame(wc, area, crop);

  const png = image.toPNG();
  const { width, height } = pngSize(png);
  if (width !== crop.width || height !== crop.height) {
    throw new Error(`Captured ${width}×${height} px but expected ${crop.width}×${crop.height} px (${rect.width}×${rect.height} CSS px at ${scale}×).`);
  }
  if (!stable) console.warn(`[capture] the region was still changing after ${STABLE_FRAME_BUDGET_MS} ms; used the latest frame.`);
  return { png, width, height, crop, stable };
}

/** Creates (or reuses) the hidden stage window; resolves to { win } once its page exposes stage.render. */
function ensureStage() {
  if (stage && !stage.win.isDestroyed()) return stage.ready;

  const win = new BrowserWindow({
    show: false,
    ...WINDOW_BOUNDS,
    useContentSize: true,
    frame: false, // no non-client area: the content size is exactly what we ask for
    skipTaskbar: true,
    // Keep the renderer painting while hidden: captures need real compositor frames.
    paintWhenInitiallyHidden: true,
    webPreferences: {
      session: getCaptureSession(),
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  const current = { win, ready: null };
  stage = current;

  const drop = () => { if (stage === current) stage = null; };
  win.on('closed', drop);
  win.webContents.on('render-process-gone', () => {
    drop();
    if (!win.isDestroyed()) win.destroy();
  });

  current.ready = withTimeout(loadStage(win), LOAD_TIMEOUT_MS, 'Loading the stage page').then(() => current, (error) => {
    drop();
    if (!win.isDestroyed()) win.destroy();
    throw error;
  });
  return current.ready;
}

async function loadStage(win) {
  const url = config.stageUrl;
  // A missing file is served as a 404 page, which loads "successfully"; catch it by its status.
  let status = 0;
  win.webContents.once('did-navigate', (_event, _url, httpResponseCode) => { status = httpResponseCode; });
  try {
    await win.loadURL(url);
  } catch (error) {
    throw new Error(`Could not load the stage page ${url}: ${error.message}`);
  }
  if (status >= 400) throw new Error(`Could not load the stage page ${url}: HTTP ${status}.`);
  // A module script may define window.stage slightly after load; give it a moment.
  const hasRender = await win.webContents.executeJavaScript(`new Promise((resolve) => {
    const started = performance.now();
    (function check() {
      if (typeof window.stage?.render === 'function') resolve(true);
      else if (performance.now() - started > 3000) resolve(false);
      else setTimeout(check, 25);
    })();
  })`);
  if (!hasRender) throw new Error(`The stage page ${url} does not expose window.stage.render().`);
}

/** Zooms the page so that devicePixelRatio === scale; returns the zoom factor. */
async function applyScale(wc, scale) {
  let dpr = await pageDpr(wc);
  if (Math.abs(dpr - scale) >= DPR_EPSILON) {
    const dsf = dpr / wc.getZoomFactor(); // the window's real device scale factor
    wc.setZoomFactor(scale / dsf);
    const deadline = performance.now() + SETTLE_TIMEOUT_MS;
    while (Math.abs((dpr = await pageDpr(wc)) - scale) >= DPR_EPSILON) {
      if (performance.now() > deadline) {
        // Chromium clamps zoom to 0.25–5, e.g. 0.5× cannot be reached on a 300 % display.
        throw new Error(`Could not render at ${scale}× on this display (the page reports ${dpr}×).`);
      }
      await delay(5);
    }
  }
  return wc.getZoomFactor();
}

const pageDpr = (wc) => wc.executeJavaScript('window.devicePixelRatio');

/**
 * Grows the window (never shrinks it) until `rect` fits in the viewport with some slack, and waits until
 * the page sees the new size. Returns whether it grew. Sizes stay multiples of 4 DIP (see WINDOW_BOUNDS).
 */
async function ensureViewport(win, rect, zoom) {
  const roundUp4 = (value) => Math.ceil(value / 4) * 4;
  const [currentWidth, currentHeight] = win.getContentSize();
  const width = Math.max(currentWidth, roundUp4((rect.x + rect.width) * zoom + 2));
  const height = Math.max(currentHeight, roundUp4((rect.y + rect.height) * zoom + 2));
  if (width === currentWidth && height === currentHeight) return false;
  win.setContentSize(width, height);

  const [actualWidth, actualHeight] = win.getContentSize();
  const expected = { width: actualWidth / zoom, height: actualHeight / zoom };
  const deadline = performance.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    const inner = await win.webContents.executeJavaScript('({ width: innerWidth, height: innerHeight })');
    if (Math.abs(inner.width - expected.width) <= 1 && Math.abs(inner.height - expected.height) <= 1) return true;
    if (performance.now() > deadline) throw new Error('The capture window did not resize in time.');
    await delay(5);
  }
}

async function renderOnStage(wc, props) {
  // Settle inside the page so a rejection keeps its message (executeJavaScript would genericise it).
  const result = await wc.executeJavaScript(`Promise.resolve().then(() => window.stage.render(${JSON.stringify(props)})).then(
    (box) => ({ ok: true, box: box && { x: box.x, y: box.y, width: box.width, height: box.height }, warnings: box && box.warnings }),
    (error) => ({ ok: false, message: String(error && error.message || error) }))`, true);
  if (!result?.ok) throw new Error(`The stage failed to render the comment: ${result?.message ?? 'unknown error'}`);

  const { box } = result;
  if (!isValidRect(box)) throw new Error(`The stage returned an invalid capture box: ${JSON.stringify(box)}`);
  const warnings = Array.isArray(result.warnings) ? result.warnings.filter((w) => typeof w === 'string') : [];
  return { box, warnings };
}

/**
 * capturePage copies whatever frame the compositor last received, which can lag the DOM by a frame.
 * Capture until two consecutive copies of the crop (a frame apart) are identical, within a time budget.
 * Only the crop is compared, so animations elsewhere on the page don't matter.
 */
async function captureStableFrame(wc, area, crop) {
  const deadline = performance.now() + STABLE_FRAME_BUDGET_MS;
  let previous = null;
  for (;;) {
    const frame = await wc.capturePage(area, { stayHidden: true });
    if (frame.isEmpty()) throw new Error('Chromium returned an empty capture.');
    const size = frame.getSize();
    if (crop.x + crop.width > size.width || crop.y + crop.height > size.height) {
      throw new Error(`The ${crop.width}×${crop.height} px region at (${crop.x}, ${crop.y}) lies outside the captured ${size.width}×${size.height} px.`);
    }
    const image = frame.crop(crop);
    const bitmap = image.toBitmap();
    if (previous?.equals(bitmap)) return { image, stable: true };
    if (performance.now() > deadline) return { image, stable: false };
    previous = bitmap;
    await nextFrames(wc, 1);
  }
}

/** CSS px rect → device px rect at `scale` (see captureRegion's `snap`). */
export function deviceRect({ x, y, width, height }, scale, snap = 'round') {
  if (snap === 'outward') {
    const left = Math.floor(x * scale + SNAP_EPSILON);
    const top = Math.floor(y * scale + SNAP_EPSILON);
    const right = Math.ceil((x + width) * scale - SNAP_EPSILON);
    const bottom = Math.ceil((y + height) * scale - SNAP_EPSILON);
    return { x: left, y: top, width: right - left, height: bottom - top };
  }
  return { x: Math.round(x * scale), y: Math.round(y * scale), width: Math.round(width * scale), height: Math.round(height * scale) };
}

function checkOutputSize(rect, scale) {
  const width = Math.ceil((rect.x + rect.width) * scale);
  const height = Math.ceil((rect.y + rect.height) * scale);
  if (width > MAX_OUTPUT_SIDE || height > MAX_OUTPUT_SIDE || width * height > MAX_OUTPUT_PIXELS) {
    throw new RangeError(`The comment is too large to export at ${scale}× (${width}×${height} px). Use a smaller scale, margin or message.`);
  }
}

// After n animation frames, style, layout and paint for the current DOM have run; the frame they
// produced may still be on its way to the compositor (see captureStableFrame).
function nextFrames(wc, n) {
  return wc.executeJavaScript(`new Promise((resolve) => {
    let left = ${n};
    (function tick() { if (left-- <= 0) resolve(); else requestAnimationFrame(tick); })();
  })`);
}

const isValidScale = (scale) => typeof scale === 'number' && Number.isFinite(scale) && scale >= MIN_SCALE && scale <= MAX_SCALE;
const scaleError = (fn) => new RangeError(`${fn}: scale must be a number from ${MIN_SCALE} to ${MAX_SCALE}.`);
const isValidRect = (r) => Boolean(r) && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(r[k]))
  && r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0;
const sameBox = (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reads width/height from a PNG's IHDR chunk. */
export function pngSize(png) {
  const signature = '89504e470d0a1a0a';
  if (png.length < 24 || png.subarray(0, 8).toString('hex') !== signature || png.toString('latin1', 12, 16) !== 'IHDR') {
    throw new Error('Chromium returned something that is not a PNG.');
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new CaptureTimeoutError(`${what} timed out after ${ms / 1000} s.`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
