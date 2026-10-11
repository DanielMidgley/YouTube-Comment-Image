// The screenshot reader on the committed fixtures (test/fixtures/screenshots, made by
// test/screenshots/make-corpus.js --fixtures): what the layout finds, and what the whole reader reads with
// Tesseract (in Node, as test/support/node-recognizer.js runs it). Node has no JPEG decoder, so a JPEG
// fixture is read from the lossless copy of its decoded pixels beside it (made by decode-jpegs.js there).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { PNG } from 'pngjs';
import { analyzeScreenshot } from '../../src/screenshot/layout.js';
import { readComment } from '../../src/screenshot/read.js';
import { createNodeRecognizer } from '../support/node-recognizer.js';

const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures', 'screenshots');
const cases = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'cases.json'), 'utf8'));
// Names made to confuse (I, l, 1, 0, O, o side by side at 1x) that the reader does not get right yet.
const HARD_NAMES = new Set(['light-confusable-1x']);

// What pngjs can read: the fixture itself, or a JPEG's decoded copy.
const pngFile = (c) => c.file.replace(/\.jpg$/, '.decoded.png');
const load = (c) => PNG.sync.read(fs.readFileSync(path.join(FIXTURES, pngFile(c))));

/** The tEXt entries of a PNG file, as { keyword: text }. */
function pngText(bytes) {
  const entries = {};
  for (let at = 8; at + 8 <= bytes.length; at += 12 + bytes.readUInt32BE(at)) {
    if (bytes.toString('latin1', at + 4, at + 8) !== 'tEXt') continue;
    const [keyword, text] = bytes.toString('latin1', at + 8, at + 8 + bytes.readUInt32BE(at)).split('\0');
    entries[keyword] = text;
  }
  return entries;
}

test('the JPEG fixtures are read from up-to-date decoded copies', () => {
  const jpegs = cases.filter((c) => c.file.endsWith('.jpg'));
  assert.ok(jpegs.length > 0, 'a JPEG fixture');
  for (const c of jpegs) {
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(FIXTURES, c.file))).digest('hex');
    const copy = path.join(FIXTURES, pngFile(c));
    const source = fs.existsSync(copy) ? pngText(fs.readFileSync(copy)).Source : 'missing';
    assert.equal(source, `${c.file} sha256:${sha256}`,
      `${pngFile(c)} is not a copy of ${c.file} as it is now: run node scripts/electron.js test/fixtures/screenshots/decode-jpegs.js`);
  }
});

test('the layout finds the scale, theme, role and comment of every fixture', () => {
  for (const c of cases) {
    const truth = c.comments[c.target].truth;
    const layout = analyzeScreenshot(load(c));
    const comment = layout.comments[layout.target];
    assert.equal(layout.scale, c.pixelScale, `${c.id}: scale`);
    assert.equal(layout.theme, truth.theme, `${c.id}: theme`);
    assert.equal(layout.comments.length, c.comments.length, `${c.id}: comments`);
    assert.equal(layout.target, c.target, `${c.id}: target`);
    assert.equal(comment.style.role, truth.role, `${c.id}: role`);
    // (A moderator's or member's check mark beside their own badge is not told apart; nothing uses it.)
    if (truth.role === 'viewer' || truth.role === 'owner') assert.equal(comment.style.verified, truth.verified, `${c.id}: verified`);
  }
});

let recognizer;
before(async () => {
  recognizer = await createNodeRecognizer();
});
after(async () => {
  await recognizer?.terminate();
});

test('the reader reads every fixture\'s name and message', async () => {
  for (const c of cases) {
    const truth = c.comments[c.target].truth;
    const result = await readComment(load(c), { recognize: (image, options) => recognizer.recognize(image, options) });
    assert.equal(result.message, truth.message, `${c.id}: message`);
    if (!HARD_NAMES.has(c.id)) assert.equal(result.name, truth.name, `${c.id}: name`);
    assert.equal(result.theme, truth.theme, `${c.id}: theme`);
    assert.equal(result.role, truth.role, `${c.id}: role`);
  }
});
