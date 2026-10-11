// The screenshot reader on test/fixtures/screenshot-scenarios: renders (by the app, of invented comments) of
// the cases that used to go wrong, from drawn-out words read with zeros to an owner's chip touching the emoji
// on the next line. Each is read with Tesseract in Node and must come out exact.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { PNG } from 'pngjs';
import { readComment } from '../../src/screenshot/read.js';
import { createNodeRecognizer } from '../support/node-recognizer.js';

const FOLDER = path.join(import.meta.dirname, '..', 'fixtures', 'screenshot-scenarios');
const cases = JSON.parse(fs.readFileSync(path.join(FOLDER, 'cases.json'), 'utf8'));

let recognizer;
before(async () => {
  recognizer = await createNodeRecognizer();
});
after(async () => {
  await recognizer?.terminate();
});

for (const c of cases) {
  test(`reads ${c.about} (${c.file})`, async () => {
    const image = PNG.sync.read(fs.readFileSync(path.join(FOLDER, c.file)));
    const result = await readComment(image, { recognize: (grey, options) => recognizer.recognize(grey, options) });
    assert.equal(result.name, c.name);
    assert.equal(result.message, c.message);
  });
}
