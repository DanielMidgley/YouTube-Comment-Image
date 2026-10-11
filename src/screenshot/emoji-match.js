// Recognises which emoji of YouTube's live-chat set an emoji in a screenshot is, offline. Every emoji has a
// signature (emoji-signatures.js): its 72 px image averaged over a grid of cells. Area averages survive any
// downscaling, so the screenshot averaged over the same grid of the emoji's 24×24 CSS px cell gives the same
// numbers at every scale, once the signature is composited over the chat background the way Chromium does it
// (premultiplied colour + (1 − alpha) × background). The cell itself is invisible (an emoji's margins are
// transparent, and dark artwork vanishes on the dark theme), so it is searched for around the ink the layout
// analysis found. Pure computation on RGBA pixels: runs in the renderer and in Node alike.
import { EMOJI_SIGNATURES, EMOJI_SIGNATURE_BITS, EMOJI_SIGNATURE_GRID } from './emoji-signatures.js';

const EMOJI_CSS_PX = 24;
const GRID = EMOJI_SIGNATURE_GRID;
const VALUES = GRID * GRID * 3; // colour values compared per cell position (red, green, blue per grid cell)

// The scale the caller measured can be a few percent off (1.3 for a 125 % screenshot): sizes this far either
// side of 24 × scale are tried. The ink box can be off by this many device px on each side.
const SCALE_TOLERANCE = 0.08;
const BOX_TOLERANCE = 2;
// After the search, emoji within RIVAL times the winner's score are fitted again: in whole pixels up to
// NEIGHBOURHOOD px around its cell (look-alikes can sit a few pixels apart in their images), then in
// quarter pixels (a resampled screenshot puts the cell between pixels).
const RIVAL = 2;
const NEIGHBOURHOOD = 2;
const SUBPIXEL_STEPS = [-0.5, -0.25, 0.25, 0.5];
const SHORTLIST = 8;
const CANDIDATES = 5; // distinct images reported

// Scores are the RMS difference (0–255 levels) between the screenshot and the composited signature. How far
// a right answer can be off depends on the screenshot: JPEG, resampling and Chromium's own filtering all
// disturb pixels where the colour changes, and a grid cell averages that out over (3 × scale)² pixels. So an
// answer is accepted up to sqrt(NOISE_FLOOR² + (NOISE_PER_EDGE × edge / scale)²), where edge is the RMS
// difference between neighbouring cells of the emoji's composited signature (the background around it
// included), and scale the size of the cell found. Calibrated on Chromium renders of the whole set at seven
// scales in both themes, plain, JPEG-compressed (quality 80) and resampled by 1.1, against avatars, badges,
// text and custom emoji (test/smoke/emoji-match.js prints both sides of the limit).
const NOISE_FLOOR = 5;
const NOISE_PER_EDGE = 0.23;
// The whole-pixel search scores a right answer at most 1.14 times its limit at the smallest size tried
// (measured over 40 000 right answers, resampled screenshots the worst: their cell lies between pixels until
// fitted in quarter pixels), so emoji beyond twice that limit are ruled out there.
const CAP_MARGIN = 2;

// That limit lets a near-uniform patch (a channel's custom emoji, a plain avatar) pass for an emoji with
// little detail of its own: a skin-tone swatch, a coloured square or circle, a coin. JPEG, resampling and
// filtering add noise, but they barely shift a flat colour or flatten a pattern, so an answer must also get
// right two things such a patch gets wrong. Where the emoji is flat (FLAT_CELLS or more opaque cells whose
// four neighbours are opaque and within FLAT_STEP levels of them), the screenshot's mean colour there must
// be within FLAT_BIAS levels of the emoji's. Where its opaque cells (PATTERN_CELLS or more) vary, by an RMS
// spread about their mean of MIN_SPREAD levels or more, the screenshot must keep PATTERN or more of that
// variation: the slope of its colours regressed on the emoji's, 1 for a faithful copy and 0 for a flat patch
// (a fine pattern, like a keyboard's keys, can fade to 0.15 at 1×). On Chromium renders of the whole set at
// seven scales in both themes, plain, JPEG-compressed and resampled (263 000 right answers), the flat parts
// were at most 3.5 levels off and at least 0.145 of the pattern was kept; flat and near-flat tiles in skin
// tones and other emoji colours that came within 1.2 times the limit were 7.3 levels off or more, or kept at
// most 0.08.
const FLAT_STEP = 6;
const FLAT_CELLS = 8;
const FLAT_BIAS = 5;
const PATTERN_CELLS = 4;
const MIN_SPREAD = 6;
const PATTERN = 0.1;

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

let table = null; // decoded signatures, see signatures()
const referenceCache = new Map(); // background → composited signatures, see referencesFor()

/** Noto code ('1f44d_1f3fd') → emoji text. Codes never contain U+FE0F, as src/comment/emoji.js normalises. */
const fromCode = (code) => String.fromCodePoint(...code.split('_').map((hex) => parseInt(hex, 16)));

/**
 * The signatures, decoded on first use: { count, emoji, cells } where emoji[i] lists the emoji drawn by
 * image i (more than one when several share an image; the first is the one to report) and cells holds
 * count × GRID² × [premultiplied red, green, blue (0–255), alpha (0–1)].
 */
function signatures() {
  if (table) return table;
  const lines = EMOJI_SIGNATURES.trim().split('\n');
  const perImage = GRID * GRID * 4;
  const emoji = [];
  const cells = new Float32Array(lines.length * perImage);
  const sextet = new Int8Array(128).fill(-1);
  for (let i = 0; i < BASE64.length; i++) sextet[BASE64.charCodeAt(i)] = i;
  lines.forEach((line, index) => {
    const [codes, data] = line.split(' ');
    emoji.push(codes.split('=').map(fromCode));
    let bits = 0;
    let buffered = 0;
    let char = 0;
    for (let v = 0; v < perImage; v++) {
      const width = EMOJI_SIGNATURE_BITS[v % 4];
      while (buffered < width) {
        bits = ((bits << 6) | sextet[data.charCodeAt(char++)]) & 0xffffff;
        buffered += 6;
      }
      buffered -= width;
      const level = (bits >> buffered) & ((1 << width) - 1);
      cells[index * perImage + v] = (level / ((1 << width) - 1)) * (v % 4 === 3 ? 1 : 255);
    }
  });
  table = { count: lines.length, emoji, cells };
  return table;
}

/** Composites premultiplied cells ([r, g, b, a] per cell) over `background`: [r, g, b] per cell. */
export function compositeOver(cells, background) {
  const out = new Float32Array((cells.length / 4) * 3);
  for (let i = 0, o = 0; i < cells.length; i += 4, o += 3) {
    const clear = 1 - cells[i + 3];
    out[o] = cells[i] + clear * background[0];
    out[o + 1] = cells[i + 1] + clear * background[1];
    out[o + 2] = cells[i + 2] + clear * background[2];
  }
  return out;
}

/** An emoji's signature as { grid, cells } (see signatures()), or null if it is not in YouTube's set. */
export function emojiSignature(emoji) {
  const { emoji: names, cells } = signatures();
  const text = String(emoji).replaceAll(String.fromCharCode(0xfe0f), '');
  const index = names.findIndex((list) => list.includes(text));
  if (index < 0) return null;
  const perImage = GRID * GRID * 4;
  return { grid: GRID, cells: cells.slice(index * perImage, (index + 1) * perImage) };
}

// Grid cells are compared centre first: that is where emoji differ most, so a wrong emoji usually exceeds
// the best distance so far within a cell or two and is abandoned.
const ORDER = (() => {
  const centre = (GRID - 1) / 2;
  const distance = (cell) => Math.hypot((cell % GRID) - centre, Math.floor(cell / GRID) - centre);
  const cells = Array.from({ length: GRID * GRID }, (_, cell) => cell).sort((a, b) => distance(a) - distance(b));
  return Int32Array.from(cells.flatMap((cell) => [cell * 3, cell * 3 + 1, cell * 3 + 2]));
})();

/** The score an answer may reach, for an emoji whose signature has `edge` (see NOISE_FLOOR), at `scale`. */
const limitFor = (edge, scale) => Math.sqrt(NOISE_FLOOR ** 2 + ((NOISE_PER_EDGE * edge) / scale) ** 2);

/** RMS difference between neighbouring cells of a composited signature, the background around it included. */
function edgeOf(composited, at, background) {
  const value = (i, j, c) => (i < 0 || j < 0 || i >= GRID || j >= GRID ? background[c] : composited[at + (j * GRID + i) * 3 + c]);
  let sum = 0;
  for (let line = 0; line < GRID; line++) {
    for (let step = -1; step < GRID; step++) {
      for (let c = 0; c < 3; c++) {
        sum += (value(step + 1, line, c) - value(step, line, c)) ** 2 + (value(line, step + 1, c) - value(line, step, c)) ** 2;
      }
    }
  }
  return Math.sqrt(sum / (2 * GRID * (GRID + 1) * 3));
}

/**
 * Every signature composited over `background`, sorted by mean value: { count, values (count × VALUES, each
 * in ORDER), means, edges (see edgeOf), image (sorted position → signature index) }. Two vectors whose means
 * differ by δ are at least VALUES × δ² apart, so a search only compares the references whose mean is close
 * to the screenshot's.
 */
function referencesFor(background) {
  const key = background.join();
  let references = referenceCache.get(key);
  if (references) return references;
  const { count, cells } = signatures();
  const composited = compositeOver(cells, background);
  const meanOf = (e) => composited.subarray(e * VALUES, (e + 1) * VALUES).reduce((sum, v) => sum + v, 0) / VALUES;
  const allMeans = Array.from({ length: count }, (_, e) => meanOf(e));
  const image = Int32Array.from({ length: count }, (_, e) => e).sort((a, b) => allMeans[a] - allMeans[b]);
  const values = new Float32Array(count * VALUES);
  image.forEach((e, s) => {
    for (let k = 0; k < VALUES; k++) values[s * VALUES + k] = composited[e * VALUES + ORDER[k]];
  });
  const means = Float32Array.from(image, (e) => allMeans[e]);
  const edges = Float32Array.from(image, (e) => edgeOf(composited, e * VALUES, background));
  references = { count, values, means, edges, image };
  if (referenceCache.size >= 4) referenceCache.delete(referenceCache.keys().next().value);
  referenceCache.set(key, references);
  return references;
}

/**
 * Summed-area table of the RGB of `image` over [x0, x1) × [y0, y1) (clamped to the image), so any
 * rectangle's sum, at fractional coordinates too, costs four lookups.
 */
function integralImage({ width, height, data }, x0, y0, x1, y1) {
  const left = Math.max(0, Math.floor(x0));
  const top = Math.max(0, Math.floor(y0));
  const w = Math.max(0, Math.min(width, Math.ceil(x1)) - left);
  const h = Math.max(0, Math.min(height, Math.ceil(y1)) - top);
  const stride = (w + 1) * 3;
  const sums = new Float64Array((h + 1) * stride);
  for (let y = 0; y < h; y++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let p = ((top + y) * width + left) * 4;
    let o = (y + 1) * stride + 3;
    for (let x = 0; x < w; x++, p += 4, o += 3) {
      r += data[p];
      g += data[p + 1];
      b += data[p + 2];
      sums[o] = sums[o - stride] + r;
      sums[o + 1] = sums[o - stride + 1] + g;
      sums[o + 2] = sums[o - stride + 2] + b;
    }
  }
  return { left, top, width: w, height: h, stride, sums };
}

/**
 * The sum of each channel over [left, x) × [top, y) into out[at..at+2]. Within a pixel the table is
 * bilinear in x and y (pixels are constant), so interpolating it is exact at fractional coordinates.
 */
function sumTo(integral, x, y, out, at) {
  const { width, height, stride, sums } = integral;
  const cx = Math.min(width, Math.max(0, x - integral.left));
  const cy = Math.min(height, Math.max(0, y - integral.top));
  const ix = Math.min(width - 1, Math.floor(cx));
  const iy = Math.min(height - 1, Math.floor(cy));
  const fx = cx - ix;
  const fy = cy - iy;
  const a = iy * stride + ix * 3;
  const b = a + stride;
  for (let c = 0; c < 3; c++) {
    const upper = sums[a + c] + fx * (sums[a + 3 + c] - sums[a + c]);
    const lower = sums[b + c] + fx * (sums[b + 3 + c] - sums[b + c]);
    out[at + c] = upper + fy * (lower - upper);
  }
}

/**
 * The screenshot averaged over the GRID×GRID cells of the square at (x, y) of side `size`, in ORDER, into
 * `out`; returns its mean. Parts outside the screenshot count as background (a tight crop can cut off an
 * emoji's transparent margin). A pixel that a grid line cuts counts in both cells by area. (Undoing the mix
 * of the two cells it holds, as if each cell were flat, fits real renders worse: artwork is smooth across
 * grid lines, so such a pixel mostly holds what lies on its own side anyway.)
 */
function observe(integral, { x, y, size }, background, lattice, out) {
  const step = size / GRID;
  for (let j = 0; j <= GRID; j++) {
    for (let i = 0; i <= GRID; i++) sumTo(integral, x + i * step, y + j * step, lattice, (j * (GRID + 1) + i) * 3);
  }
  const area = step * step;
  const right = integral.left + integral.width;
  const bottom = integral.top + integral.height;
  const within = x >= integral.left && y >= integral.top && x + size <= right && y + size <= bottom;
  let total = 0;
  for (let k = 0; k < VALUES; k += 3) {
    const cell = ORDER[k] / 3;
    const i = cell % GRID;
    const j = (cell - i) / GRID;
    const x0 = x + i * step;
    const y0 = y + j * step;
    const inside = within ? area : Math.max(0, Math.min(right, x0 + step) - Math.max(integral.left, x0))
      * Math.max(0, Math.min(bottom, y0 + step) - Math.max(integral.top, y0));
    const p00 = (j * (GRID + 1) + i) * 3;
    const p10 = p00 + (GRID + 1) * 3;
    for (let c = 0; c < 3; c++) {
      const sum = lattice[p10 + 3 + c] - lattice[p00 + 3 + c] - lattice[p10 + c] + lattice[p00 + c];
      out[k + c] = (sum + (area - inside) * background[c]) / area;
      total += out[k + c];
    }
  }
  return total / VALUES;
}

/** Squared distance from `observed` to reference `s`, or `bound` as soon as it reaches `bound`. */
function distanceTo(observed, values, s, bound) {
  let sum = 0;
  for (let k = 0, o = s * VALUES; k < VALUES; k += 3, o += 3) {
    const r = observed[k] - values[o];
    const g = observed[k + 1] - values[o + 1];
    const b = observed[k + 2] - values[o + 2];
    sum += r * r + g * g + b * b;
    if (sum >= bound) return bound;
  }
  return sum;
}

/**
 * `list` holds the best `limit` distinct references found so far as { s, distance, cell }, best first.
 * Offers one; returns the distance a reference must now beat to get in.
 */
function offer(list, limit, s, distance, cell) {
  const existing = list.findIndex((entry) => entry.s === s);
  if (existing >= 0) {
    if (list[existing].distance <= distance) return entryBound(list, limit);
    list.splice(existing, 1);
  }
  let at = list.length;
  while (at > 0 && list[at - 1].distance > distance) at--;
  list.splice(at, 0, { s, distance, cell });
  if (list.length > limit) list.pop();
  return entryBound(list, limit);
}

const entryBound = (list, limit) => (list.length < limit ? Infinity : list[list.length - 1].distance);

/**
 * Offers to `list` every reference that could make its best `limit` for the observation `observed` (whose
 * mean is `mean`) of `cell`, and is closer than `cap` (one number, or one per reference: see `hopeless`).
 * Only references whose mean is close enough can be, so they are compared from the nearest mean outwards
 * until none is left within reach.
 */
function search(references, observed, mean, cell, list, limit, cap = Infinity) {
  const { count, values, means } = references;
  const caps = typeof cap === 'number' ? null : cap;
  const widest = caps ? caps.largest : cap;
  let bound = Math.min(widest, entryBound(list, limit));
  let reach = Math.sqrt(bound / VALUES);
  let lo = 0;
  for (let hi = count; lo < hi;) {
    const mid = (lo + hi) >> 1;
    if (means[mid] < mean) lo = mid + 1;
    else hi = mid;
  }
  let hi = lo;
  lo--;
  while (lo >= 0 || hi < count) {
    const below = lo >= 0 ? mean - means[lo] : Infinity;
    const above = hi < count ? means[hi] - mean : Infinity;
    if (Math.min(below, above) > reach) break;
    const s = below <= above ? lo-- : hi++;
    // A reference with a cap of its own has a reach of its own, too.
    if (caps && Math.min(below, above) > caps.reach[s]) continue;
    const own = caps ? Math.min(bound, caps[s]) : bound;
    const distance = distanceTo(observed, values, s, own);
    if (distance < own) {
      bound = Math.min(widest, offer(list, limit, s, distance, cell));
      reach = Math.sqrt(bound / VALUES);
    }
  }
}

/** Whole numbers from `from` to `to`, the one nearest `centre` first (so the early exit tightens quickly). */
function positions(from, to, centre) {
  const out = [];
  for (let p = Math.floor(from); p <= Math.ceil(to); p++) out.push(p);
  return out.sort((a, b) => Math.abs(a - centre) - Math.abs(b - centre));
}

/**
 * Where the cell of side `size` can lie along one axis so that it contains the ink [start, start + length]:
 * give or take BOX_TOLERANCE, or inside the ink if that came out larger than the cell.
 */
function cellRange(start, length, size) {
  const a = start + length - size;
  return [Math.min(a, start) - BOX_TOLERANCE, Math.max(a, start) + BOX_TOLERANCE];
}

/**
 * How far an answer falls short of the checks a near-uniform patch fails (see FLAT_BIAS), as a multiple of
 * what they allow, like score / limit: the larger of the flat colour's offset / FLAT_BIAS and PATTERN / the
 * share of the pattern kept; 0 where neither applies. `s` is the answer's reference, `seen` the screenshot
 * averaged over its `cell` (both in ORDER). Only opaque cells count, whose colour does not depend on the
 * background, and only those inside the image: beyond its edge nothing is known.
 */
function shortfall(image, cell, s, seen, references) {
  const { cells } = signatures();
  const base = references.image[s] * GRID * GRID * 4;
  const emoji = new Float32Array(VALUES);
  const shot = new Float32Array(VALUES);
  for (let k = 0; k < VALUES; k++) {
    emoji[ORDER[k]] = references.values[s * VALUES + k];
    shot[ORDER[k]] = seen[k];
  }
  const step = cell.size / GRID;
  const opaque = (i, j) => i >= 0 && j >= 0 && i < GRID && j < GRID && cells[base + (j * GRID + i) * 4 + 3] === 1;
  const inside = (i, j) => cell.x + i * step >= 0 && cell.y + j * step >= 0
    && cell.x + (i + 1) * step <= image.width && cell.y + (j + 1) * step <= image.height;
  const flat = (i, j) => [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([di, dj]) => opaque(i + di, j + dj)
    && [0, 1, 2].every((c) => Math.abs(emoji[((j + dj) * GRID + i + di) * 3 + c] - emoji[(j * GRID + i) * 3 + c]) <= FLAT_STEP));

  const used = [];
  const flats = [];
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      if (!opaque(i, j) || !inside(i, j)) continue;
      used.push(j * GRID + i);
      if (flat(i, j)) flats.push(j * GRID + i);
    }
  }
  let ratio = 0;
  if (flats.length >= FLAT_CELLS) {
    const offset = [0, 1, 2].map((c) => flats.reduce((sum, n) => sum + shot[n * 3 + c] - emoji[n * 3 + c], 0) / flats.length);
    ratio = Math.hypot(...offset) / Math.sqrt(3) / FLAT_BIAS;
  }
  if (used.length >= PATTERN_CELLS) {
    let spread = 0;
    let shared = 0;
    for (let c = 0; c < 3; c++) {
      const mean = (values) => used.reduce((sum, n) => sum + values[n * 3 + c], 0) / used.length;
      const emojiMean = mean(emoji);
      const shotMean = mean(shot);
      for (const n of used) {
        spread += (emoji[n * 3 + c] - emojiMean) ** 2;
        shared += (emoji[n * 3 + c] - emojiMean) * (shot[n * 3 + c] - shotMean);
      }
    }
    if (Math.sqrt(spread / (3 * used.length)) >= MIN_SPREAD) ratio = Math.max(ratio, shared > 0 ? (PATTERN * spread) / shared : Infinity);
  }
  return ratio;
}

function checkArguments(image, box, scale, background, tolerance) {
  if (!image || !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1
    || !image.data || image.data.length < image.width * image.height * 4) {
    throw new TypeError('matchEmoji: image must be { width, height, data } with RGBA data.');
  }
  if (!box || !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(box[key])) || box.width <= 0 || box.height <= 0) {
    throw new TypeError('matchEmoji: box must be { x, y, width, height } with a positive size.');
  }
  if (!Number.isFinite(scale) || scale <= 0) throw new TypeError('matchEmoji: scale must be a positive number.');
  if (!background || background.length !== 3 || ![0, 1, 2].every((c) => Number.isFinite(background[c]))) {
    throw new TypeError('matchEmoji: background must be [r, g, b].');
  }
  if (!(tolerance > 0)) throw new TypeError('matchEmoji: tolerance must be a positive number.');
}

/**
 * Recognises the emoji whose ink lies in `box` (device px, approximate: the bounding box of the pixels
 * that differ from the chat background) in `image` ({ width, height, data: RGBA }, e.g. ImageData or a pngjs
 * PNG), drawn at about `scale` device px per CSS px over `background` ([r, g, b]). Returns
 * { emoji, score, limit, ratio, box, candidates }, or null when no emoji of YouTube's set matches well enough
 * (an avatar, a badge, a channel's custom emoji, text):
 *   emoji       the emoji's text, without U+FE0F (as src/comment/emoji.js normalises it);
 *   score       the RMS difference from its signature in 0–255 levels; lower is better;
 *   limit       the score this answer had to stay within (it allows for more noise on detailed emoji and at
 *               small scales, see NOISE_FLOOR);
 *   ratio       how near the answer came to being rejected (1 is the line): score / limit, or more where the
 *               emoji is flat and the screenshot's colour there is off, or its pattern is missing (see
 *               FLAT_BIAS);
 *   box         the emoji's whole 24 CSS px cell as found, in device px;
 *   candidates  the best distinct images, best first, as [{ emoji, score }]; emoji that share an image are
 *               all listed, with the same score.
 * `tolerance` is the ratio allowed (2 accepts answers twice as far off; Infinity returns the best whatever
 * its score).
 */
export function matchEmoji(image, { box, scale, background, tolerance = 1 } = {}) {
  checkArguments(image, box, scale, background, tolerance);
  const bg = [background[0], background[1], background[2]];
  const { emoji } = signatures();
  const references = referencesFor(bg);
  const nominal = EMOJI_CSS_PX * scale;
  // An emoji's ink lies within its cell, and the box is at most a pixel or two off: ink much bigger than
  // the biggest cell tried is not one emoji (a word, two emoji together, a scale far off).
  const biggest = nominal * (1 + SCALE_TOLERANCE) + 2 * BOX_TOLERANCE;
  if (box.width > biggest || box.height > biggest) return null;
  // Every cell tried (refinement included) lies within this window, so only it needs a summed-area table.
  const largest = Math.ceil(nominal * (1 + SCALE_TOLERANCE)) + NEIGHBOURHOOD + 2;
  const margin = BOX_TOLERANCE + NEIGHBOURHOOD + 2;
  const integral = integralImage(image,
    Math.min(box.x, box.x + box.width - largest) - margin, Math.min(box.y, box.y + box.height - largest) - margin,
    Math.max(box.x + largest, box.x + box.width) + margin, Math.max(box.y + largest, box.y + box.height) + margin);
  if (!integral.width || !integral.height) return null;
  const lattice = new Float64Array((GRID + 1) * (GRID + 1) * 3);
  const observed = new Float32Array(VALUES);
  const fit = (cell, list, limit, cap) => search(references, observed, observe(integral, cell, bg, lattice, observed), cell, list, limit, cap);
  // An emoji that scores more than CAP_MARGIN times its limit (at the smallest size tried) in every
  // whole-pixel cell cannot be accepted after finer fitting either, so it need not be compared in full: that
  // makes rejecting what is not an emoji several times faster.
  const smallest = (nominal * (1 - SCALE_TOLERANCE)) / EMOJI_CSS_PX;
  const hopeless = Float64Array.from(references.edges, (edge) => (CAP_MARGIN * tolerance * limitFor(edge, smallest)) ** 2 * VALUES);
  hopeless.largest = Math.max(...hopeless);
  hopeless.reach = Float64Array.from(hopeless, (cap) => Math.sqrt(cap / VALUES));

  // 1. The best emoji over every whole-pixel cell size and position the box allows. Exhaustive on purpose:
  //    a coarser search settles on look-alikes drawn a few pixels apart in their images (🚶 and 🧑‍🦯, whose
  //    white cane vanishes on the light theme).
  const winner = [];
  for (const size of positions(nominal * (1 - SCALE_TOLERANCE), nominal * (1 + SCALE_TOLERANCE), nominal)) {
    const [x0, x1] = cellRange(box.x, box.width, size);
    const [y0, y1] = cellRange(box.y, box.height, size);
    const xs = positions(x0, x1, box.x + box.width / 2 - size / 2);
    for (const y of positions(y0, y1, box.y + box.height / 2 - size / 2)) {
      for (const x of xs) fit({ x, y, size }, winner, 1, hopeless);
    }
  }
  if (!winner.length) return null;

  // 2. The best few emoji in the winning cell, and any rival (an emoji close enough to the winner to beat it
  //    once fitted more finely) in its own best cell nearby.
  const shortlist = [];
  const { x, y, size } = winner[0].cell;
  fit(winner[0].cell, shortlist, SHORTLIST);
  const rivals = RIVAL ** 2 * winner[0].distance;
  for (const dSize of positions(-1, 1, 0)) {
    for (const dy of positions(-NEIGHBOURHOOD, NEIGHBOURHOOD, 0)) {
      for (const dx of positions(-NEIGHBOURHOOD, NEIGHBOURHOOD, 0)) {
        if (dx || dy || dSize) fit({ x: x + dx, y: y + dy, size: size + dSize }, shortlist, SHORTLIST, rivals);
      }
    }
  }

  // 3. Quarter-pixel fitting of the rivals. Position and size trade off against each other, so all their
  //    combinations are tried, not one coordinate at a time.
  const views = new Map(); // cell → observation, shared by emoji fitted around the same cell
  const view = (cell) => {
    const key = `${cell.x} ${cell.y} ${cell.size}`;
    if (!views.has(key)) {
      observe(integral, cell, bg, lattice, observed);
      views.set(key, observed.slice());
    }
    return views.get(key);
  };
  const quarters = [0, ...SUBPIXEL_STEPS];
  for (const entry of shortlist.filter((e) => e.distance <= RIVAL ** 2 * shortlist[0].distance)) {
    const { x: ex, y: ey, size: es } = entry.cell;
    for (const dSize of quarters) {
      for (const dy of quarters) {
        for (const dx of quarters) {
          const cell = { x: ex + dx, y: ey + dy, size: es + dSize };
          const distance = distanceTo(view(cell), references.values, entry.s, entry.distance);
          if (distance < entry.distance) Object.assign(entry, { distance, cell });
        }
      }
    }
  }
  shortlist.sort((a, b) => a.distance - b.distance);

  const score = (entry) => Math.sqrt(entry.distance / VALUES);
  const names = (entry) => emoji[references.image[entry.s]];
  const [top] = shortlist;
  const limit = limitFor(references.edges[top.s], top.cell.size / EMOJI_CSS_PX);
  // 4. What the score cannot tell from a near-uniform patch: a flat colour that is off, a missing pattern.
  const ratio = Math.max(score(top) / limit, shortfall(image, top.cell, top.s, view(top.cell), references));
  if (!(ratio <= tolerance)) return null;
  return {
    emoji: names(top)[0],
    score: score(top),
    limit,
    ratio,
    box: { x: top.cell.x, y: top.cell.y, width: top.cell.size, height: top.cell.size },
    candidates: shortlist.slice(0, CANDIDATES).flatMap((entry) => names(entry).map((text) => ({ emoji: text, score: score(entry) }))),
  };
}
