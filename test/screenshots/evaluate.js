// Measures the screenshot reader (src/screenshot/read.js) on a corpus made by make-corpus.js: how often it
// reads the name and the message exactly, the message's character error rate, and both broken down by the
// cases' tags. Runs under Electron, whose nativeImage decodes PNG and JPEG alike; Tesseract runs as in
// test/support/node-recognizer.js. Run:
//   npm run test:screenshots -- [corpus folder] [--only=text] [--limit=n] [--min=percent] [--out=file]
// The folder defaults to test/screenshots/corpus (make it with make-corpus.js); test/fixtures/screenshots is
// committed. --only keeps the cases whose JSON contains the text (an id, or a tag such as "transform:jpeg"),
// --limit the first n, --min fails the run when fewer than that percentage are read exactly, --out writes
// the failed cases there as JSON (for the real corpus, only inside its git-ignored folder or the temp folder:
// they hold real people's comments). `--only text` works too, except for a tag followed by more arguments:
// Electron refuses to start, silently, when an argument that looks like a URL (letters, then a colon) is
// followed by another, so give a tag as --only=transform:jpeg.
import { app, nativeImage } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readComment } from '../../src/screenshot/read.js';
import { createNodeRecognizer } from '../support/node-recognizer.js';

const CASE_TIMEOUT_MS = 60_000;
const DEFAULT_CORPUS = path.join(import.meta.dirname, 'corpus');
const REAL_CORPUS = path.join(import.meta.dirname, 'corpus-real');
const PROFILE_PREFIX = 'youtube-comment-evaluate-';
const OPTIONS = ['only', 'limit', 'min', 'out'];
const USAGE = 'Usage: npm run test:screenshots -- [corpus folder] [--only=text] [--limit=n] [--min=percent] [--out=file]';

/** Stops before anything runs, for a mistake in the command line. */
function refuse(message) {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}

/** The corpus folder and the options, each given as --name=value or --name value. */
function parseArguments(list) {
  const options = {};
  const folders = [];
  for (let i = 0; i < list.length; i++) {
    const arg = list[i];
    if (arg === '--') continue; // (it ends Electron's check too; npm run keeps the first one for itself)
    const [, name, value] = /^--([^=]*)(?:=(.*))?$/s.exec(arg) ?? [];
    if (name === undefined) folders.push(arg);
    else if (!OPTIONS.includes(name)) refuse(`Unknown option ${arg}.`);
    else {
      // (An empty value is refused too: --out= would name the current folder, --only= keep every case.)
      const given = value ?? (list[i + 1]?.startsWith('--') ? undefined : list[++i]);
      if (!given) refuse(`--${name} needs a value.`);
      options[name] = given;
    }
  }
  if (folders.length > 1) refuse(`Give one corpus folder, not ${folders.length}: ${folders.join(', ')}`);
  return { folder: folders[0], options };
}

/** `file` made absolute, with the links (symbolic links, junctions) in the part of it that exists resolved. */
function realPath(file) {
  const absolute = path.resolve(file);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    const parent = path.dirname(absolute);
    return parent === absolute ? absolute : path.join(realPath(parent), path.basename(absolute));
  }
}

/** Whether `file` is the folder `dir` or lies inside it. */
function isInside(dir, file) {
  const relative = path.relative(realPath(dir), realPath(file));
  return relative.split(path.sep)[0] !== '..' && !path.isAbsolute(relative);
}

const { folder: folderArgument, options } = parseArguments(process.argv.slice(2).filter((a) => !a.endsWith('evaluate.js')));
const folder = path.resolve(folderArgument ?? DEFAULT_CORPUS);
// A --min that is not a number would never fail the run, so a mistyped gate is refused rather than ignored.
const number = (text) => (text === undefined ? undefined : text.trim() === '' ? NaN : Number(text));
const LIMIT = number(options.limit);
if (LIMIT !== undefined && !(Number.isInteger(LIMIT) && LIMIT >= 1)) refuse('--limit must be a whole number of at least 1.');
const MIN = number(options.min);
if (MIN !== undefined && !(MIN >= 0 && MIN <= 100)) refuse('--min must be a percentage from 0 to 100.');
const OUT = options.out === undefined ? undefined : path.resolve(options.out);
// The real corpus holds other people's names and messages, and so do its failed cases. As make-corpus.js
// --real does, keep them in its git-ignored folder (or the temp folder): anywhere else they can be committed.
if (OUT && isInside(REAL_CORPUS, folder) && !isInside(REAL_CORPUS, OUT) && !isInside(os.tmpdir(), OUT)) {
  refuse(`The real corpus's failed cases hold real people's comments: --out must be inside test/screenshots/corpus-real/ (git-ignored) or ${os.tmpdir()}.`);
}

// A throwaway Electron profile. Electron holds it until it exits, so earlier runs' are removed here.
for (const name of fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(PROFILE_PREFIX))) {
  try {
    const dir = path.join(os.tmpdir(), name);
    if (Date.now() - fs.statSync(dir).mtimeMs > 10 * 60 * 1000) fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Still in use, or already gone.
  }
}
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), PROFILE_PREFIX)));
app.disableHardwareAcceleration();

/** RGBA pixels of a PNG or JPEG file. */
function decode(file) {
  const image = nativeImage.createFromPath(file);
  const { width, height } = image.getSize();
  const bgra = image.toBitmap();
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = bgra[i + 2];
    data[i + 1] = bgra[i + 1];
    data[i + 2] = bgra[i];
    data[i + 3] = bgra[i + 3];
  }
  return { width, height, data };
}

/** Edit distance between two strings, in code points. */
function distance(a, b) {
  const x = [...a];
  const y = [...b];
  let row = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const next = [i];
    for (let j = 1; j <= y.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    row = next;
  }
  return row[y.length];
}

const percent = (n, d) => `${((100 * n) / Math.max(1, d)).toFixed(1)}%`;

async function main() {
  const casesFile = path.join(folder, 'cases.json');
  if (!fs.existsSync(casesFile)) {
    throw new Error(`No corpus at ${folder}: make one with node scripts/electron.js test/screenshots/make-corpus.js, or pass test/fixtures/screenshots.`);
  }
  let cases = JSON.parse(fs.readFileSync(casesFile, 'utf8'));
  if (options.only) cases = cases.filter((c) => JSON.stringify(c).includes(options.only));
  if (LIMIT) cases = cases.slice(0, LIMIT);

  let recognizer = await createNodeRecognizer();
  const results = [];
  const started = performance.now();
  for (const [index, c] of cases.entries()) {
    const truth = c.comments[c.target].truth;
    const image = decode(path.join(folder, c.file));
    const t0 = performance.now();
    let got;
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), CASE_TIMEOUT_MS);
      });
      got = await Promise.race([readComment(image, { recognize: (grey, o) => recognizer.recognize(grey, o) }), timeout]);
    } catch (error) {
      got = { error: error.message, name: '', message: '', doubtful: [], warnings: [] };
      if (error.message === 'timed out') {
        await recognizer.terminate().catch(() => {});
        recognizer = await createNodeRecognizer();
      }
    } finally {
      clearTimeout(timer);
    }
    const ms = Math.round(performance.now() - t0);
    const nameOk = got.name === truth.name;
    const messageOk = got.message === truth.message;
    console.log(`[${index + 1}/${cases.length}] ${c.id} ${image.width}x${image.height} ${ms} ms ${nameOk && messageOk ? 'ok' : 'FAIL'}${got.error ? ` (${got.error})` : ''}`);
    results.push({
      id: c.id, file: c.file, tags: c.tags, ms, nameOk, messageOk,
      truthName: truth.name, gotName: got.name, truthMessage: truth.message, gotMessage: got.message, error: got.error,
      cer: distance(got.message ?? '', truth.message) / Math.max(1, [...truth.message].length), doubtful: got.doubtful, warnings: got.warnings,
    });
  }
  await recognizer.terminate();

  const n = results.length;
  const exact = results.filter((r) => r.nameOk && r.messageOk).length;
  const cer = results.reduce((sum, r) => sum + r.cer, 0) / Math.max(1, n);
  const times = results.map((r) => r.ms).sort((a, b) => a - b);
  const failed = results.filter((r) => !(r.nameOk && r.messageOk));
  console.log(`\n${n} cases in ${((performance.now() - started) / 1000).toFixed(1)} s (median ${times[n >> 1] ?? 0} ms, slowest ${times.at(-1) ?? 0} ms)`);
  console.log(`  name ${percent(results.filter((r) => r.nameOk).length, n)}, message ${percent(results.filter((r) => r.messageOk).length, n)}, both ${percent(exact, n)}; `
    + `message character error rate ${(100 * cer).toFixed(2)}%; ${results.filter((r) => r.error).length} errors`);
  console.log(`  failed cases with a doubtful-word note: ${failed.filter((r) => r.doubtful?.length).length} of ${failed.length}; right ones with one: ${results.filter((r) => r.nameOk && r.messageOk && r.doubtful?.length).length}`);
  const byTag = new Map();
  for (const r of results) {
    for (const tag of r.tags ?? []) {
      const entry = byTag.get(tag) ?? { n: 0, both: 0, name: 0, message: 0 };
      entry.n++;
      entry.both += r.nameOk && r.messageOk;
      entry.name += r.nameOk;
      entry.message += r.messageOk;
      byTag.set(tag, entry);
    }
  }
  const imperfect = [...byTag].filter(([, e]) => e.both < e.n).sort(([a], [b]) => a.localeCompare(b));
  if (imperfect.length) console.log('\nBy tag (where any case failed):');
  for (const [tag, e] of imperfect) {
    console.log(`  ${tag.padEnd(26)} ${String(e.n).padStart(4)}  both ${percent(e.both, e.n).padStart(6)}  name ${percent(e.name, e.n).padStart(6)}  message ${percent(e.message, e.n).padStart(6)}`);
  }
  if (failed.length) console.log('\nFailed:');
  for (const r of failed) {
    const show = (ok, truth, got) => (ok ? '' : `\n    ${JSON.stringify(truth)} read as ${JSON.stringify(got)}`);
    console.log(`  ${r.id}${r.error ? ` (${r.error})` : ''}${show(r.nameOk, r.truthName, r.gotName)}${show(r.messageOk, r.truthMessage, r.gotMessage)}`);
  }
  if (OUT) {
    fs.writeFileSync(OUT, JSON.stringify(failed, null, 1));
    console.log(`\nFailed cases written to ${OUT}`);
  }
  if (MIN !== undefined && (100 * exact) / Math.max(1, n) < MIN) {
    throw new Error(`Only ${percent(exact, n)} read exactly, under the ${MIN}% asked for.`);
  }
}

app.whenReady().then(main).then(
  () => app.exit(0),
  (error) => {
    console.error(error.message);
    app.exit(1);
  },
);
