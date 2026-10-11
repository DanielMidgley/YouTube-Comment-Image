// Smoke test for src/screenshot/ocr.js in the app's renderer. Run: node scripts/electron.js test/smoke/ocr.js
// Opens a hidden window on a page with exactly the editor's Content-Security-Policy (read from
// src/editor/index.html) in an in-memory session that serves app:// and cancels every http(s) request. There it
// starts the recognizer, reads lines drawn with canvas in Roboto (14px × 3, black on white) and lines cropped
// from docs/example-dark.png (made black on white), checks the text and times start-up and every line, and
// reads a line with each of the three core builds the package ships. Fails on any console error or warning
// from the page or its workers (watched through the DevTools protocol), any CSP violation and any request for
// the network. Then reads the same images with test/support/node-recognizer.js and compares, and checks that
// failures (missing files, bad input, terminate) reject with Errors instead of hanging.
import { app, BrowserWindow, session } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP_ROOT, HOST, SCHEME, appUrl, fileResponse, registerAppScheme, resolveInside } from '../../electron/protocol.js';
import { createNodeRecognizer } from '../support/node-recognizer.js';

const PAGE_PATH = '/test/smoke/ocr-page.html'; // made up here: a blank page with the editor's CSP and Roboto
const MODULE_URL = appUrl('src/screenshot/ocr.js');
const MODULES = 'node_modules/';
// Where src/screenshot/ocr.js points tesseract.js; the failure checks break one path at a time.
const PATHS = {
  workerPath: appUrl(`${MODULES}tesseract.js/dist/worker.min.js`),
  corePath: appUrl(`${MODULES}tesseract.js-core/`),
  langPath: appUrl(`${MODULES}@tesseract.js-data/eng/4.0.0_best_int/`),
  workerBlobURL: false,
};
const TESSERACT_URL = appUrl(`${MODULES}tesseract.js/dist/tesseract.esm.min.js`);
// The LSTM-only builds of the core the worker chooses from (package.json "build" ships these three).
const CORES = ['tesseract-core-relaxedsimd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-lstm.wasm.js'];
const PROFILE_PREFIX = 'youtube-comment-ocr-smoke-';

// Drawn in the page at 14px × 3 (invented names and messages), read in `mode` (default 'line').
const DRAWN = [
  { label: 'name', text: '@pixel.pancake', weight: 500 },
  { label: 'name', text: '@Chef_Ramiro_77', weight: 500 },
  { label: 'name', text: '@sunny.daze-22', weight: 500 },
  { label: 'message', text: 'can u play the old intro pls', weight: 400 },
  { label: 'message', text: 'GG everyone 10/10 would watch again', weight: 400 },
  { label: 'message', text: 'the drop at 2:41 is crazy', weight: 400 },
  { label: 'word', text: 'incredible', weight: 400, mode: 'word' },
  { label: 'block', text: 'Can you say hi to my mom?\nShe is watching too', weight: 400, mode: 'block' },
];
// docs/example-dark.png is a 2× export of a dark-theme comment: text from x = 128 after the avatar, the name and
// its badge then the message on a first 40px line, the rest on a second line made 48px high by its emoji.
// Rects in its pixels, around the text and clear of the badge and the emoji.
const CROPPED = [
  { label: 'example name', text: '@mia_watches', rect: { x: 120, y: 8, width: 200, height: 38 } },
  { label: 'example line 1', text: 'first time catching one of', rect: { x: 358, y: 8, width: 340, height: 38 } },
  { label: 'example line 2', text: 'these live, the new song sounds incredible', rect: { x: 118, y: 46, width: 542, height: 50 } },
];

let failures = 0;
const notes = [];
function check(ok, label) {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${label}`);
  return ok;
}
const note = (text) => { notes.push(text); console.log(`  note  ${text}`); };
const ms = (value) => `${Math.round(value)} ms`;

// ---- Page side (runs in the test page; no access to this module's scope) ----------------------------------

/**
 * Draws the lines and crops the example screenshot: [{ width, height, data }], one byte per pixel. They stay in
 * the page as window.testImages (JSON, which carries arguments into the page, has no typed arrays).
 */
async function makeImages(drawn, cropped, exampleUrl) {
  const SCALE = 3;
  const greyOf = (ctx, width, height) => {
    const rgba = ctx.getImageData(0, 0, width, height).data;
    const data = new Uint8Array(width * height);
    for (let i = 0; i < data.length; i++) data[i] = Math.round(0.2126 * rgba[4 * i] + 0.7152 * rgba[4 * i + 1] + 0.0722 * rgba[4 * i + 2]);
    return { width, height, data };
  };
  const images = [];
  for (const { text, weight } of drawn) {
    const lines = text.split('\n');
    const font = `${weight} ${14 * SCALE}px Roboto`;
    await document.fonts.load(font, text);
    const measure = new OffscreenCanvas(1, 1).getContext('2d');
    measure.font = font;
    const pad = 4 * SCALE;
    const width = Math.ceil(Math.max(...lines.map((line) => measure.measureText(line).width))) + 2 * pad;
    const height = lines.length * 20 * SCALE + 2 * pad;
    const ctx = new OffscreenCanvas(width, height).getContext('2d', { alpha: false, willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#000';
    ctx.font = font;
    ctx.textBaseline = 'middle';
    lines.forEach((line, i) => ctx.fillText(line, pad, pad + (i + 0.5) * 20 * SCALE));
    images.push(greyOf(ctx, width, height));
  }
  const example = new Image();
  example.src = exampleUrl;
  await example.decode();
  for (const { rect } of cropped) {
    // The export is 2×; 1.5 more makes it 3× like the drawn lines. Light text on the dark chat: stretch the
    // luminance so the brightest ink becomes black and the chat background white.
    const width = Math.round(rect.width * 1.5);
    const height = Math.round(rect.height * 1.5);
    const ctx = new OffscreenCanvas(width, height).getContext('2d', { alpha: false, willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(example, rect.x, rect.y, rect.width, rect.height, 0, 0, width, height);
    const { data } = greyOf(ctx, width, height);
    let [min, max] = [255, 0];
    for (const value of data) [min, max] = [Math.min(min, value), Math.max(max, value)];
    for (let i = 0; i < data.length; i++) data[i] = Math.round((255 * (max - data[i])) / (max - min));
    images.push({ width, height, data });
  }
  window.testImages = images;
  return images;
}

/** Starts a recognizer and reads testImages[i] in `modes[i]` for each i of `indices`, timing every step. */
async function readAll(moduleUrl, indices, modes, options) {
  const { createRecognizer } = await import(moduleUrl);
  const statuses = new Set();
  const started = performance.now();
  const recognizer = await createRecognizer({ ...options, onProgress: ({ status }) => statuses.add(status) });
  const startMs = performance.now() - started;
  const results = [];
  for (const [k, i] of indices.entries()) {
    const t0 = performance.now();
    const result = await recognizer.recognize(window.testImages[i], { mode: modes[k] });
    results.push({ ms: performance.now() - t0, result });
  }
  await recognizer.terminate();
  return { startMs, statuses: [...statuses], results };
}

/**
 * Starts the recognizer once with each of `cores` (a corePath ending in .js is used as is, where a folder
 * lets the worker choose by CPU support) and reads testImages[index] with it.
 */
async function readWithEachCore(moduleUrl, tesseractUrl, paths, cores, index) {
  const { startRecognizer } = await import(moduleUrl);
  const { default: tesseract } = await import(tesseractUrl);
  const results = [];
  for (const core of cores) {
    const t0 = performance.now();
    const recognizer = await startRecognizer(tesseract, { ...paths, corePath: paths.corePath + core });
    const startMs = performance.now() - t0;
    const { text, confidence } = await recognizer.recognize(window.testImages[index]);
    await recognizer.terminate();
    results.push({ core, startMs, text, confidence });
  }
  return results;
}

/** What goes wrong must come back as an Error: missing files, bad input, calls cut short by terminate(). */
async function failureCases(moduleUrl, tesseractUrl, paths, lineIndex) {
  const { createRecognizer, startRecognizer } = await import(moduleUrl);
  const { default: tesseract } = await import(tesseractUrl);
  const line = window.testImages[lineIndex];
  const outcome = async (promise) => {
    const t0 = performance.now();
    try {
      const value = await promise;
      return { settled: 'resolved', value, ms: performance.now() - t0 };
    } catch (error) {
      return { settled: 'rejected', isError: error instanceof Error, type: error?.constructor?.name, message: error?.message, ms: performance.now() - t0 };
    }
  };
  const swap = (key, from, to) => ({ ...paths, [key]: paths[key].replace(from, to) });
  const result = {
    missingModel: await outcome(startRecognizer(tesseract, swap('langPath', '4.0.0_best_int', 'no-such-model'))),
    missingCore: await outcome(startRecognizer(tesseract, swap('corePath', 'tesseract.js-core', 'no-such-core'))),
    missingWorker: await outcome(startRecognizer(tesseract, swap('workerPath', 'worker.min.js', 'no-such-worker.js'))),
  };
  const recognizer = await createRecognizer();
  result.shortData = await outcome(recognizer.recognize({ width: 4, height: 4, data: new Uint8Array(3) }));
  result.badMode = await outcome(recognizer.recognize(line, { mode: 'page' }));
  result.blank = await outcome(recognizer.recognize({ width: 60, height: 20, data: new Uint8Array(1200).fill(255) }));
  // The line at the right end of the widest crop allowed (Tesseract does not finish one 32,760 px wide), then one
  // pixel more, which must be refused.
  const widened = (width) => {
    const data = new Uint8Array(width * line.height).fill(255);
    for (let y = 0; y < line.height; y++) data.set(line.data.subarray(y * line.width, (y + 1) * line.width), y * width + width - line.width);
    return { width, height: line.height, data };
  };
  const widest = await outcome(recognizer.recognize(widened(32_000)));
  result.widest = { ...widest, value: widest.value && { text: widest.value.text, x: widest.value.words[0]?.box.x } };
  result.tooWide = await outcome(recognizer.recognize(widened(32_001)));
  const queued = [0, 1, 2].map(() => outcome(recognizer.recognize(line)));
  await recognizer.terminate();
  result.queued = await Promise.all(queued);
  result.afterTerminate = await outcome(recognizer.recognize(line));
  return result;
}

// ---- Harness -------------------------------------------------------------------------------------------

/** The editor's CSP, exactly as its page declares it. */
function editorCsp() {
  const html = fs.readFileSync(path.join(APP_ROOT, 'src', 'editor', 'index.html'), 'utf8');
  const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)?.[1];
  if (!csp) throw new Error('src/editor/index.html declares no Content-Security-Policy.');
  return csp;
}

/** app:// as the app serves it, plus the test page; every request is logged, every http(s) one cancelled. */
function prepareSession(ses, csp, log) {
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>OCR smoke test</title><link rel="stylesheet" href="/src/styles/roboto.css"></head><body></body></html>`;
  ses.protocol.handle(SCHEME, (request) => {
    log.app.push(request.url);
    const { host, pathname } = new URL(request.url);
    if (host === HOST && pathname === PAGE_PATH) return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    const filePath = host === HOST && resolveInside(APP_ROOT, pathname);
    return filePath ? fileResponse(filePath, request) : new Response('Not found', { status: 404 });
  });
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    log.network.push(details.url);
    callback({ cancel: true });
  });
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
}

/**
 * Console output of the page and of every worker it starts, through the DevTools protocol (Electron's
 * console-message event does not report workers). Workers are held at their first line until watched.
 */
async function watchConsole(wc, entries, phase) {
  const dbg = wc.debugger;
  dbg.attach('1.3');
  const add = (sessionId, level, text) => entries.push({ phase: phase.current, where: sessionId ? 'worker' : 'page', level, text });
  dbg.on('message', (_event, method, params, sessionId) => {
    if (method === 'Target.attachedToTarget') {
      const child = params.sessionId;
      Promise.all([dbg.sendCommand('Runtime.enable', {}, child), dbg.sendCommand('Log.enable', {}, child)])
        .finally(() => dbg.sendCommand('Runtime.runIfWaitingForDebugger', {}, child))
        .catch(() => {}); // the worker may already be gone
    } else if (method === 'Runtime.consoleAPICalled') {
      const source = params.stackTrace?.callFrames[0]?.url;
      add(sessionId, params.type, `${params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ')}${source ? ` (${source})` : ''}`);
    } else if (method === 'Runtime.exceptionThrown') {
      const { exception, text } = params.exceptionDetails;
      add(sessionId, 'error', exception?.description ?? text);
    } else if (method === 'Log.entryAdded') {
      add(sessionId, params.entry.level, `${params.entry.source}: ${params.entry.text}${params.entry.url ? ` (${params.entry.url})` : ''}`);
    }
  });
  await dbg.sendCommand('Runtime.enable');
  await dbg.sendCommand('Log.enable');
  await dbg.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
}

async function main() {
  await app.whenReady();
  console.log(`Electron ${process.versions.electron} / Chromium ${process.versions.chrome} / Node ${process.versions.node}`);
  const csp = editorCsp();
  console.log(`Editor CSP: ${csp}`);

  const log = { app: [], network: [] };
  const ses = session.fromPartition('ocr-smoke'); // in memory: nothing persists
  prepareSession(ses, csp, log);
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    // As the editor's window, which is visible (so not throttled) when someone reads a screenshot.
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const wc = win.webContents;
  const consoleEntries = [];
  // Enabling the protocol replays what about:blank logged (Electron's warning about its missing CSP): 'setup'.
  const phase = { current: 'setup' };
  await win.loadURL('about:blank'); // the DevTools protocol needs a document to attach to
  await watchConsole(wc, consoleEntries, phase);
  phase.current = 'read';
  await win.loadURL(appUrl(PAGE_PATH.slice(1)));
  const run = (fn, ...args) => wc.executeJavaScript(`(${fn})(...${JSON.stringify(args)})`, true);
  await wc.executeJavaScript(`window.violations = [];
    document.addEventListener('securitypolicyviolation', (e) => violations.push(e.violatedDirective + ' ' + e.blockedURI)); true`);
  check(await wc.executeJavaScript('document.querySelector(\'meta[http-equiv="Content-Security-Policy"]\').content') === csp,
    'the test page carries the editor\'s CSP');

  const items = [
    ...DRAWN.map((d) => ({ label: d.label, text: d.text, mode: d.mode ?? 'line' })),
    ...CROPPED.map((c) => ({ label: c.label, text: c.text, mode: 'line' })),
  ];
  const images = await run(makeImages, DRAWN, CROPPED, appUrl('docs/example-dark.png'));
  const modes = items.map((item) => item.mode);
  check(images.length === items.length && images.every((im) => im.data instanceof Uint8Array && im.data.length === im.width * im.height),
    `${images.length} test images: ${images.map((im) => `${im.width}×${im.height}`).join(', ')}`);

  console.log('\n== Renderer (the editor\'s CSP, network blocked)');
  const appRequestsBefore = log.app.length;
  const renderer = await run(readAll, MODULE_URL, images.map((_, i) => i), modes, {});
  check(renderer.startMs < 15_000, `recognizer ready in ${ms(renderer.startMs)} (stages: ${renderer.statuses.join(', ')})`);
  renderer.results.forEach(({ ms: time, result }, i) => {
    const item = items[i];
    const shown = JSON.stringify(result.text);
    check(result.text === item.text, `${item.label} (${item.mode}): ${shown}${result.text === item.text ? '' : ` expected ${JSON.stringify(item.text)}`}, confidence ${result.confidence}, ${ms(time)}`);
  });
  const times = renderer.results.map((r) => r.ms);
  const lineTimes = renderer.results.filter((_, i) => modes[i] === 'line').map((r) => r.ms);
  console.log(`        per call: first ${ms(times[0])}, then ${ms(Math.min(...times.slice(1)))}–${ms(Math.max(...times.slice(1)))}; single lines average ${ms(lineTimes.reduce((s, t) => s + t, 0) / lineTimes.length)}`);

  const symbols = renderer.results.flatMap(({ result }) => result.words.flatMap((w) => w.symbols));
  const withChoices = symbols.filter((s) => Array.isArray(s.choices) && s.choices.length);
  const bestFirst = (s) => s.choices.every((c, k) => !k || c.confidence <= s.choices[k - 1].confidence);
  const including = withChoices.filter((s) => s.choices.some((c) => c.text === s.text)).length;
  check(withChoices.length >= 0.9 * symbols.length && withChoices.every((s) => bestFirst(s) && s.choices.every((c) => typeof c.text === 'string' && c.confidence > 0 && c.confidence <= 100)),
    `alternatives for ${withChoices.length} of ${symbols.length} characters, best first, confidences in (0, 100], ${including} including the character read`);
  const words = renderer.results.flatMap(({ result }) => result.words);
  check(words.length > 0 && words.every((w) => w.box.width > 0 && w.box.height > 0 && w.symbols.every((s) => s.box.x >= w.box.x && s.box.x + s.box.width <= w.box.x + w.box.width)),
    `${words.length} words with boxes, each character inside its word`);
  const blockWords = renderer.results[DRAWN.findIndex((d) => d.mode === 'block')].result.words;
  check(blockWords.length && blockWords.at(-1).box.y > blockWords[0].box.y + blockWords[0].box.height,
    'block mode: the second line\'s words lie below the first line\'s');

  const appRequests = log.app.slice(appRequestsBefore).map((url) => url.replace(appUrl(''), ''));
  const cores = appRequests.filter((url) => url.startsWith(`${MODULES}tesseract.js-core/`));
  check(cores.length === 1 && /\/tesseract-core-(relaxedsimd-|simd-)?lstm\.wasm\.js$/.test(cores[0]), `WebAssembly core loaded from the app: ${cores.join(', ')}`);
  check(appRequests.includes(`${MODULES}@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz`) && appRequests.includes(`${MODULES}tesseract.js/dist/worker.min.js`),
    'worker script and model (4.0.0_best_int) loaded from the app');
  const otherModules = appRequests.filter((url) => url.startsWith(MODULES) && !cores.includes(url)
    && ![`${MODULES}tesseract.js/dist/tesseract.esm.min.js`, `${MODULES}tesseract.js/dist/worker.min.js`, `${MODULES}@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz`].includes(url));
  check(otherModules.length === 0, `nothing else read from node_modules${otherModules.length ? `: ${otherModules.join(', ')}` : ''}`);

  console.log('\n== Renderer, dictionary off');
  const names = items.map((item, i) => [item, i]).filter(([item]) => /name/.test(item.label));
  const noDictionary = await run(readAll, MODULE_URL, names.map(([, i]) => i), names.map(() => 'line'), { dictionary: false });
  noDictionary.results.forEach(({ result }, k) => {
    const [item, i] = names[k];
    const withDictionary = renderer.results[i].result;
    check(result.text === item.text, `${item.label}: ${JSON.stringify(result.text)} (confidence ${result.confidence}; with the dictionary ${withDictionary.confidence})`);
  });
  console.log(`        started in ${ms(noDictionary.startMs)}`);

  console.log('\n== Each core the package ships (the worker picks one by CPU support)');
  const coreLine = DRAWN.findIndex((d) => d.label === 'message');
  const perCore = await run(readWithEachCore, MODULE_URL, TESSERACT_URL, PATHS, CORES, coreLine);
  for (const { core, startMs, text, confidence } of perCore) {
    check(text === items[coreLine].text, `${core}: ${JSON.stringify(text)}, confidence ${confidence}, started in ${ms(startMs)}`);
  }

  console.log('\n== Console, CSP and network while reading');
  const readEntries = consoleEntries.filter((e) => e.phase === 'read');
  for (const e of readEntries) console.log(`        ${e.where} ${e.level}: ${e.text}`);
  check(!readEntries.some((e) => ['error', 'warning', 'assert'].includes(e.level)), `no console errors or warnings from the page or its workers (${readEntries.length} messages in all)`);
  const violations = await wc.executeJavaScript('violations');
  check(violations.length === 0, `no CSP violations${violations.length ? `: ${violations.join('; ')}` : ''}`);
  check(log.network.length === 0, `no http(s) requests${log.network.length ? `: ${log.network.join(', ')}` : ''}`);

  console.log('\n== Node (test/support/node-recognizer.js) on the same images');
  let started = performance.now();
  const nodeRecognizer = await createNodeRecognizer();
  console.log(`        ready in ${ms(performance.now() - started)}`);
  let identical = 0;
  const nodeTimes = [];
  for (const [i, image] of images.entries()) {
    started = performance.now();
    const result = await nodeRecognizer.recognize(image, { mode: modes[i] });
    nodeTimes.push(performance.now() - started);
    const ours = renderer.results[i].result;
    // Same text is required; the confidences, boxes and alternatives are expected to match too.
    const same = JSON.stringify(result) === JSON.stringify(ours);
    if (same) identical++;
    else note(`${items[i].label}: Node and the renderer agree on the text but not on every confidence, box or alternative`);
    check(result.text === ours.text, `${items[i].label}: ${JSON.stringify(result.text)}, confidence ${result.confidence} (renderer ${ours.confidence})${same ? ', words, boxes and alternatives identical' : ''}`);
  }
  await nodeRecognizer.terminate();
  console.log(`        ${identical} of ${images.length} results identical in every field; Node took ${ms(nodeTimes.reduce((s, t) => s + t, 0))} for all, the renderer ${ms(times.reduce((s, t) => s + t, 0))}`);

  console.log('\n== Failures');
  phase.current = 'failures';
  const failedLine = DRAWN.findIndex((d) => d.label === 'message');
  const failed = await run(failureCases, MODULE_URL, TESSERACT_URL, PATHS, failedLine);
  const rejected = (o, pattern, type = 'Error') => o.settled === 'rejected' && o.isError && o.type === type && pattern.test(o.message);
  const describe = (o) => (o.settled === 'rejected' ? `${o.type}: ${o.message} (${ms(o.ms)})` : `resolved ${JSON.stringify(o.value)}`);
  check(rejected(failed.missingModel, /^Could not start text recognition: .*404/), `missing model → ${describe(failed.missingModel)}`);
  check(rejected(failed.missingCore, /^Could not start text recognition: .*no-such-core/), `missing core → ${describe(failed.missingCore)}`);
  check(rejected(failed.missingWorker, /^Could not start text recognition: its worker script could not be loaded/), `missing worker script → ${describe(failed.missingWorker)}`);
  check([failed.missingModel, failed.missingCore, failed.missingWorker].every((o) => o.ms < 10_000), 'each fails within 10 s (no hang until the start timeout)');
  check(rejected(failed.shortData, /one byte per pixel/, 'TypeError'), `image with too few bytes → ${describe(failed.shortData)}`);
  check(rejected(failed.badMode, /mode "page"/, 'TypeError'), `unknown mode → ${describe(failed.badMode)}`);
  check(failed.blank.settled === 'resolved' && failed.blank.value.text === '' && failed.blank.value.words.length === 0, `blank crop → ${describe(failed.blank)}`);
  check(failed.widest.settled === 'resolved' && failed.widest.value.text === items[failedLine].text && failed.widest.value.x > 31_000 && failed.widest.ms < 10_000,
    `the widest crop allowed (32,000 px, the line at its right end) → ${describe(failed.widest)} in ${ms(failed.widest.ms)}`);
  check(rejected(failed.tooWide, /too large/, 'RangeError'), `a crop 32,001 px wide → ${describe(failed.tooWide)}`);
  check(failed.queued.every((o) => rejected(o, /stopped before it finished/)), `3 calls queued, then terminate() → ${failed.queued.map((o) => o.settled).join(', ')} (${failed.queued[0].message})`);
  check(rejected(failed.afterTerminate, /has been stopped/), `call after terminate() → ${describe(failed.afterTerminate)}`);
  const failureEntries = consoleEntries.filter((e) => e.phase === 'failures');
  for (const e of failureEntries) console.log(`        (expected) ${e.where} ${e.level}: ${e.text}`);
  const lateViolations = await wc.executeJavaScript('violations');
  check(lateViolations.length === 0 && !failureEntries.some((e) => /Content.Security.Policy/i.test(e.text)), 'still no CSP violations');
  check(log.network.length === 0, 'still no http(s) requests');

  // The control: a request the page may make (an emoji image, which the CSP allows) must be seen and cancelled.
  const emoji = 'https://fonts.gstatic.com/s/e/notoemoji/15.1/1f525/72.png';
  const loaded = await wc.executeJavaScript(`new Promise((resolve) => {
    const img = new Image(); img.onload = () => resolve(true); img.onerror = () => resolve(false); img.src = ${JSON.stringify(emoji)};
  })`);
  check(!loaded && log.network.length === 1 && log.network[0] === emoji, `the network block works: an emoji image request was ${loaded ? 'NOT ' : ''}cancelled (${log.network.join(', ')})`);

  win.destroy();
}

// A fresh profile per run, so the test never touches (or is locked out by) the app's own. Chromium keeps a run's
// profile locked until it exits, so each run removes earlier runs' leftovers instead.
for (const entry of fs.readdirSync(os.tmpdir())) {
  if (!entry.startsWith(PROFILE_PREFIX)) continue;
  const dir = path.join(os.tmpdir(), entry);
  try {
    if (Date.now() - fs.statSync(dir).mtimeMs > 10 * 60 * 1000) fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Still in use or already gone.
  }
}
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), PROFILE_PREFIX)));
registerAppScheme();
app.on('window-all-closed', () => {});
// A recognition that never settles would otherwise keep the test running for ever.
setTimeout(() => {
  console.error('\nFAIL  the OCR smoke test did not finish within 2 minutes');
  app.exit(1);
}, 120_000).unref();
main()
  .catch((error) => {
    failures++;
    console.error(error);
  })
  .finally(() => {
    if (notes.length) console.log(`\n${notes.length} note(s):\n${notes.map((n) => `  - ${n}`).join('\n')}`);
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll OCR checks passed');
    app.exit(failures ? 1 : 0);
  });
