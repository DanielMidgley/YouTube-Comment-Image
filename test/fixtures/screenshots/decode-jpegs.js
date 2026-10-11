// Stores the pixels of each JPEG fixture, as Chromium decodes them, in a lossless PNG beside it
// (dark-jpeg-1_5x.jpg → dark-jpeg-1_5x.decoded.png), so that test/unit/screenshot-read.test.js can read the
// JPEG's artefacts in Node, which has no JPEG decoder. Each PNG names its JPEG and that file's SHA-256 in a
// tEXt chunk ("Source"), and the test fails once they no longer match. Run after make-corpus.js --fixtures
// changes a JPEG:
//   node scripts/electron.js test/fixtures/screenshots/decode-jpegs.js
import { app, nativeImage } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const FIXTURES = import.meta.dirname;

/** A PNG chunk: the length of `data`, the type, `data` and the CRC of type and data. */
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** The decoded pixels of `jpegFile` as a PNG whose tEXt chunk says where they came from. */
function decodedPng(jpegFile) {
  const image = nativeImage.createFromPath(jpegFile);
  if (image.isEmpty()) throw new Error(`Could not decode ${jpegFile}.`);
  const png = image.toPNG();
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(jpegFile)).digest('hex');
  const source = chunk('tEXt', Buffer.from(`Source\0${path.basename(jpegFile)} sha256:${sha256}`, 'latin1'));
  const end = png.length - 12; // IEND, the last chunk, has no data
  return Buffer.concat([png.subarray(0, end), source, png.subarray(end)]);
}

app.whenReady().then(() => {
  const cases = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'cases.json'), 'utf8'));
  const copies = new Set();
  for (const { file } of cases.filter((c) => c.file.endsWith('.jpg'))) {
    const copy = file.replace(/\.jpg$/, '.decoded.png');
    fs.writeFileSync(path.join(FIXTURES, copy), decodedPng(path.join(FIXTURES, file)));
    copies.add(copy);
    console.log(`Wrote ${path.relative(process.cwd(), path.join(FIXTURES, copy))}`);
  }
  // A copy whose JPEG is no longer a fixture would only be dead weight.
  for (const name of fs.readdirSync(FIXTURES).filter((n) => n.endsWith('.decoded.png') && !copies.has(n))) {
    fs.rmSync(path.join(FIXTURES, name));
    console.log(`Removed ${name}`);
  }
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
