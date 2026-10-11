// Regenerates src/screenshot/emoji-signatures.js, the compact picture of every emoji in YouTube's live-chat
// set that src/screenshot/emoji-match.js compares screenshots with. Downloads each 72 px Noto image once into
// node_modules/.cache/notoemoji-<version>/ (later runs are offline).
//   node scripts/update-emoji-signatures.js [--grid=8] [--bits=6,6,6,5] [--out=file]
// (--grid, --bits and --out are for experiments; the matcher reads whatever grid and bits the file declares.)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { YOUTUBE_EMOJI_CODES, YOUTUBE_EMOJI_VERSION } from '../src/comment/youtube-emoji.js';

const ROOT = path.join(import.meta.dirname, '..');
const CACHE_DIR = path.join(ROOT, 'node_modules', '.cache', `notoemoji-${YOUTUBE_EMOJI_VERSION}`);
const BASE_URL = `https://fonts.gstatic.com/s/e/notoemoji/${YOUTUBE_EMOJI_VERSION}`;
const SOURCE_SIZE = 72;
const CONCURRENCY = 12;
const ATTEMPTS = 4;
const TIMEOUT_MS = 20_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// Only --name=value: anything else is refused (`--out file`, ignored, would overwrite the committed signatures).
const OPTIONS = ['grid', 'bits', 'out'];
for (const arg of process.argv.slice(2)) {
  const [, name] = /^--([^=]*)=./s.exec(arg) ?? [];
  if (OPTIONS.includes(name) && process.argv.filter((a) => a.startsWith(`--${name}=`)).length === 1) continue;
  console.error(`Unexpected argument ${arg}. Run: node scripts/update-emoji-signatures.js [--grid=8] [--bits=6,6,6,5] [--out=file]`);
  process.exit(2);
}
const option = (name, fallback) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
// Cells per side, and bits per stored value: premultiplied red, green, blue, then alpha. 8×8 cells of 6-bit
// colour and 5-bit alpha make a 965 KB file. On Chromium renders of every third emoji of the set at seven
// scales in both themes (17 654), it got 10 wrong in plain screenshots, as 8 bits (1.3 MB) did with 9, while
// 5 bits for everything (848 KB) got 20 wrong and 4 bits of alpha (925 KB; alpha weighs heavily on the light
// theme) 37. JPEG-compressed: 57 wrong, 8 bits 37. A grid of 4×4 already tells 99.7 % of the set apart in a
// clean 1× screenshot; 8×8 leaves the margin that JPEG and resampling need.
const GRID = Number(option('grid', '8'));
const BITS = option('bits', '6,6,6,5').split(',').map(Number);
const TARGET = path.resolve(option('out', path.join(ROOT, 'src', 'screenshot', 'emoji-signatures.js')));

// Some emoji share one image: Noto draws a few territories with their country's flag, every skin tone of 🏂
// alike, and some families the same. A screenshot cannot tell them apart, so the matcher names the first of
// each group: the one listed here if any (the flag people mean), otherwise the one with the fewest code
// points, then the earliest in YouTube's list.
const PREFERRED_TWINS = new Set([
  '1f1e6_1f1fa', // 🇦🇺, not 🇭🇲
  '1f1f3_1f1f4', // 🇳🇴, not 🇧🇻 🇸🇯
  '1f1eb_1f1f7', // 🇫🇷, not 🇨🇵 🇲🇫
  '1f1ee_1f1f4', // 🇮🇴, not 🇩🇬
  '1f1ea_1f1f8', // 🇪🇸, not 🇪🇦
  '1f1fa_1f1f8', // 🇺🇸, not 🇺🇲
]);

const codes = YOUTUBE_EMOJI_CODES.trim().split(/\s+/);

/** The cached 72 px PNG of `code`, downloaded first if needed. */
async function emojiPng(code) {
  const file = path.join(CACHE_DIR, `${code}.png`);
  if (fs.existsSync(file)) return fs.readFileSync(file);
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(`${BASE_URL}/${code}/72.png`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const png = Buffer.from(await response.arrayBuffer());
      if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG');
      // Write then rename, so an interrupted run never leaves a truncated image in the cache.
      fs.writeFileSync(`${file}.part`, png);
      fs.renameSync(`${file}.part`, file);
      return png;
    } catch (error) {
      if (attempt >= ATTEMPTS) throw new Error(`Could not download emoji ${code}: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
}

/** Runs `task` over `items` with at most `limit` at a time; results keep the order of `items`. */
async function mapLimited(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** RGBA with the colour premultiplied by alpha, which is what Chromium resamples and composites. */
function premultiply({ data }) {
  const out = new Float64Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] / 255;
    out[i] = data[i] * alpha;
    out[i + 1] = data[i + 1] * alpha;
    out[i + 2] = data[i + 2] * alpha;
    out[i + 3] = alpha;
  }
  return out;
}

/**
 * The signature: the premultiplied image averaged over each cell of a GRID×GRID grid of the whole canvas,
 * as [red, green, blue (0–255), alpha (0–1)] per cell. Area averages are what any downscaling filter
 * preserves, so a screenshot's averages over the same cells match them at every size (the matcher composites
 * them over the chat background: colour + (1 − alpha) × background).
 */
function signature(pixels) {
  const cell = SOURCE_SIZE / GRID;
  const out = new Float64Array(GRID * GRID * 4);
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      const sums = [0, 0, 0, 0];
      const [x0, y0] = [gx * cell, gy * cell];
      for (let y = Math.floor(y0); y < Math.ceil(y0 + cell); y++) {
        const wy = Math.min(y + 1, y0 + cell) - Math.max(y, y0);
        for (let x = Math.floor(x0); x < Math.ceil(x0 + cell); x++) {
          const weight = wy * (Math.min(x + 1, x0 + cell) - Math.max(x, x0));
          for (let c = 0; c < 4; c++) sums[c] += weight * pixels[(y * SOURCE_SIZE + x) * 4 + c];
        }
      }
      for (let c = 0; c < 4; c++) out[(gy * GRID + gx) * 4 + c] = sums[c] / (cell * cell);
    }
  }
  return out;
}

/** Quantises a signature to BITS per value and packs it into base64, most significant bit first. */
function encode(values) {
  let bits = '';
  for (let i = 0; i < values.length; i++) {
    const width = BITS[i % 4];
    const unit = i % 4 === 3 ? 1 : 255;
    const level = Math.round((values[i] / unit) * (2 ** width - 1));
    bits += Math.min(2 ** width - 1, Math.max(0, level)).toString(2).padStart(width, '0');
  }
  bits = bits.padEnd(Math.ceil(bits.length / 6) * 6, '0');
  let text = '';
  for (let i = 0; i < bits.length; i += 6) text += BASE64[parseInt(bits.slice(i, i + 6), 2)];
  return text;
}

/** Groups identical images (compared premultiplied, so invisible colour under zero alpha is ignored). */
function groupTwins(images) {
  const groups = new Map();
  images.forEach((pixels, index) => {
    const bytes = Uint8Array.from(pixels, (value, i) => Math.round(i % 4 === 3 ? value * 255 : value));
    const key = crypto.createHash('sha256').update(bytes).digest('hex');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(index);
  });
  const rank = (index) => [PREFERRED_TWINS.has(codes[index]) ? 0 : 1, codes[index].split('_').length, index];
  const byRank = (a, b) => rank(a).reduce((order, value, i) => order || value - rank(b)[i], 0);
  return [...groups.values()].map((group) => group.sort(byRank)).sort((a, b) => a[0] - b[0]);
}

async function main() {
  if (!(GRID >= 2 && GRID <= 24) || BITS.length !== 4 || BITS.some((b) => !(b >= 1 && b <= 8))) {
    throw new Error('--grid must be 2–24 and --bits four widths of 1–8.');
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cached = codes.filter((code) => fs.existsSync(path.join(CACHE_DIR, `${code}.png`))).length;
  if (cached < codes.length) console.log(`Downloading ${codes.length - cached} of ${codes.length} emoji images...`);
  const images = await mapLimited(codes, CONCURRENCY, async (code) => {
    const png = PNG.sync.read(await emojiPng(code));
    if (png.width !== SOURCE_SIZE || png.height !== SOURCE_SIZE) {
      throw new Error(`Emoji ${code} is ${png.width}×${png.height} px, expected ${SOURCE_SIZE}×${SOURCE_SIZE}.`);
    }
    return premultiply(png);
  });

  const groups = groupTwins(images);
  const lines = groups.map((group) => `${group.map((index) => codes[index]).join('=')} ${encode(signature(images[group[0]]))}`);
  const twins = groups.filter((group) => group.length > 1);
  const source = `// Signatures of YouTube's live-chat emoji (Noto ${YOUTUBE_EMOJI_VERSION}, the ${codes.length} emoji of src/comment/youtube-emoji.js) for
// src/screenshot/emoji-match.js. Generated by scripts/update-emoji-signatures.js; don't edit.
//
// Each line is one image: its emoji as Noto codes (several joined by '=' when they share one image, the one
// to report first), then the 72 px image averaged over each cell of a grid of ${GRID}×${GRID}, row by row, as
// premultiplied red, green, blue and alpha, quantised to ${BITS.join(', ')} bits (full scale 255 for colour, 1 for
// alpha) and packed into base64, most significant bit first.
export const EMOJI_SIGNATURE_VERSION = '${YOUTUBE_EMOJI_VERSION}';
export const EMOJI_SIGNATURE_GRID = ${GRID};
export const EMOJI_SIGNATURE_BITS = [${BITS.join(', ')}];

export const EMOJI_SIGNATURES = \`
${lines.join('\n')}
\`;
`;
  fs.mkdirSync(path.dirname(TARGET), { recursive: true });
  fs.writeFileSync(TARGET, source);
  console.log(`Wrote ${groups.length} signatures for ${codes.length} emoji (${twins.length} groups of identical images) `
    + `to ${path.relative(process.cwd(), TARGET)}: ${(Buffer.byteLength(source) / 1024).toFixed(0)} KB`);
}

await main();
