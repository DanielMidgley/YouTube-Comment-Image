// Accents. Tesseract's English model knows few accented letters: it reads ö as o, ë as é, Å as A. On the
// screenshot the mark is there to see, centred above the letter's body (or, for a cedilla, under a c), and its
// shape tells which it is: two dots side by side, a ring, a stroke leaning right or left, a wave, a bar, a
// roof or a cup. The letter Tesseract read gives the base, and Unicode the accented letter.
import { knows } from './metrics.js';

const X_HEIGHT = 7.4; // CSS px, Roboto 14px
const CAP_HEIGHT = 10;
const FONT_SIZE = 14;
const INK = 0.35; // of the region's ink strength
const MARKS = {
  acute: '́', grave: '̀', circumflex: '̂', tilde: '̃', macron: '̄', breve: '̆',
  dot: '̇', diaeresis: '̈', ring: '̊', caron: '̌', cedilla: '̧',
};
// Lowercase letters that reach above the x-height carry no accent here (ď and ľ put theirs beside them).
const TALL = new Set([...'bdfhklt']);
const CEDILLA = 2.5; // CSS px below the baseline: a cedilla hangs 3.5px, round letters overshoot by a row
// Below this scale an accent is a pixel or two, too few to tell from an i's dot or a neighbour's edge. (Not
// quite 1: a 1x screenshot whose text measures a little narrow, a JPEG say, is read at 0.97 or so.)
const MIN_SCALE = 0.95;

const luminance = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * The letter `text` (Tesseract's reading of the character in `span`, the screenshot columns Roboto's advance
 * widths give it) with the accent the screenshot shows, or null to keep the reading (not a letter, nothing
 * clear above or below it, or an accent Unicode has no letter for). `place` as for correctWords.
 */
export function accentLetter(text, span, place) {
  if (place.scale < MIN_SCALE || !/^\p{L}$/u.test(text)) return null;
  let base = text.normalize('NFD')[0];
  if (!/^[a-zA-Z]$/.test(base)) return null;
  const grid = new Grid(span, place);
  const body = grid.bodyTop();
  if (body === null) return null;
  const { scale } = place;
  let mark = TALL.has(base) ? null : classify(grid.marksAbove(body), scale);
  // Two dots over an i are an ï only with its stem between them (the dots of two i's each have their own).
  if (mark === 'diaeresis' && base === 'i' && !grid.stemBetweenDots(body)) mark = null;
  if (!mark && (base === 'c' || base === 'C') && grid.reachesBelow() >= CEDILLA * scale) mark = 'cedilla';
  // A dot is an i's or j's own, or ż, ė, ċ, ġ; an i takes only the common marks (í, ì, î, ï), since a blurred
  // dot can pass for a short bar or a wave. At 1x a mark is two or three pixels: only two dots, a ring or a
  // clear lean are told apart there.
  if (!mark || (mark === 'dot' && !'zecgZECG'.includes(base))) return null;
  if (scale < 1.25 && !['diaeresis', 'ring', 'acute', 'grave'].includes(mark)) return null;
  if ((base === 'i' || base === 'j') && !['acute', 'grave', 'circumflex', 'diaeresis'].includes(mark)) return null;
  // An accented i whose stem reaches the cap height is an I (Í read as i).
  if (base === 'i' && grid.baseline - body >= ((X_HEIGHT + CAP_HEIGHT) / 2) * scale) base = 'I';
  const letter = (base + MARKS[mark]).normalize('NFC');
  if ([...letter].length !== 1 || !knows(letter)) return null;
  return letter === text ? null : letter;
}

/** The ink around one character: 0-1 per pixel, read from the screenshot as needed. */
class Grid {
  constructor(span, { image, region, scale }) {
    this.image = image;
    this.scale = scale;
    this.baseline = region.baseline;
    this.bg = luminance(...region.background);
    this.range = Math.max(24, Math.abs(luminance(...region.ink) - this.bg));
    // The body is looked for in the middle half of the character's columns (clear of its neighbours); marks
    // a little wider than its columns, since they lean.
    const width = span.right - span.left;
    this.span = span;
    this.bodyLeft = Math.floor(span.left + 0.25 * width);
    this.bodyRight = Math.max(this.bodyLeft + 1, Math.ceil(span.right - 0.25 * width));
    this.left = Math.floor(span.left - 0.1 * FONT_SIZE * scale);
    this.right = Math.ceil(span.right + 0.1 * FONT_SIZE * scale);
  }

  ink(x, y) {
    const { data, width, height } = this.image;
    if (x < 0 || y < 0 || x >= width || y >= height) return 0;
    const i = (y * width + x) * 4;
    return Math.min(1, Math.abs(luminance(data[i], data[i + 1], data[i + 2]) - this.bg) / this.range);
  }

  rowInked(y, x0, x1) {
    for (let x = x0; x < x1; x++) if (this.ink(x, y) >= INK) return true;
    return false;
  }

  /** The top row of the letter's body: ink up from the baseline to the first empty row, or null. */
  bodyTop() {
    let y = this.baseline - 1;
    if (!this.rowInked(y, this.bodyLeft, this.bodyRight) && !this.rowInked(y - 1, this.bodyLeft, this.bodyRight)) return null;
    const limit = this.baseline - Math.ceil(16 * this.scale);
    while (y > limit && this.rowInked(y - 1, this.bodyLeft, this.bodyRight)) y--;
    return y;
  }

  /** Whether the column midway between the two dots above the body has ink down most of the body. */
  stemBetweenDots(body) {
    const dots = this.marksAbove(body).map((pixels) => pixels.reduce((sum, [x, , v]) => sum + (x + 0.5) * v, 0) / pixels.reduce((sum, [, , v]) => sum + v, 0));
    if (dots.length < 2) return false;
    const x = Math.floor((dots[0] + dots[1]) / 2);
    let inked = 0;
    for (let y = body; y < this.baseline; y++) if (this.ink(x, y) >= INK) inked++;
    return inked >= 0.7 * (this.baseline - body);
  }

  /** How many rows of ink the body has below the baseline. */
  reachesBelow() {
    let rows = 0;
    while (rows < 6 * this.scale && this.rowInked(this.baseline + rows, this.bodyLeft, this.bodyRight)) rows++;
    return rows;
  }

  /**
   * The pieces of ink in the rows just above the body (up to 5px): each a list of [x, y, ink]. Pieces that
   * reach the window's sides or are centred outside the character's columns (a neighbour's: the dot of an i
   * beside it) or run down into the body (a taller letter beside it) are not marks.
   */
  marksAbove(body) {
    const top = body - Math.ceil(5 * this.scale);
    const w = this.right - this.left;
    const h = body - top;
    if (w <= 0 || h <= 0) return [];
    const seen = new Uint8Array(w * h);
    const pieces = [];
    for (let start = 0; start < w * h; start++) {
      if (seen[start] || this.ink(this.left + (start % w), top + Math.floor(start / w)) < INK) continue;
      const pixels = [];
      const stack = [start];
      seen[start] = 1;
      let outside = false;
      while (stack.length) {
        const p = stack.pop();
        const x = p % w;
        const y = (p - x) / w;
        const value = this.ink(this.left + x, top + y);
        pixels.push([this.left + x, top + y, value]);
        if (x === 0 || x === w - 1 || y === 0) outside = true;
        if (y === h - 1 && this.ink(this.left + x, body) >= INK) outside = true;
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const q = ny * w + nx;
          if (seen[q] || this.ink(this.left + nx, top + ny) < INK) continue;
          seen[q] = 1;
          stack.push(q);
        }
      }
      const centre = pixels.reduce((sum, [x, , v]) => sum + (x + 0.5) * v, 0) / pixels.reduce((sum, [, , v]) => sum + v, 0);
      if (!outside && centre >= this.span.left && centre <= this.span.right) pieces.push(pixels);
    }
    const mass = (pixels) => pixels.reduce((sum, [, , v]) => sum + v, 0);
    const heaviest = Math.max(0, ...pieces.map(mass));
    return pieces.filter((pixels) => mass(pixels) >= 0.25 * heaviest);
  }
}

/** The name of the mark that `pieces` make (sizes in CSS px), or null when it is none of them. */
function classify(pieces, scale) {
  if (!pieces.length) return null;
  const shapes = pieces.map((pixels) => shapeOf(pixels, scale)).sort((a, b) => b.mass - a.mass);
  if (shapes.length >= 2) {
    const [a, b] = shapes;
    const apart = Math.abs(a.cx - b.cx);
    return b.mass >= 0.5 * a.mass && apart >= 1.2 && apart <= 5 && Math.abs(a.cy - b.cy) <= 1.5 ? 'diaeresis' : null;
  }
  const [s] = shapes;
  if (s.hole && s.width >= 2) return 'ring';
  if (s.width <= 2.3 && s.height <= 2.3) return 'dot';
  if (s.width >= 1.8 * s.height) {
    if (s.width >= 3 && s.cupped > 0.35) return 'breve';
    return s.wave >= 0.5 ? 'tilde' : 'macron';
  }
  if (s.width >= 3.2 && Math.abs(s.slant) < 0.6) {
    // A roof is narrow at the top and spread at the bottom; a cup the other way round.
    if (s.spreadTop < 0.75 * s.spreadBottom) return 'circumflex';
    if (s.spreadBottom < 0.75 * s.spreadTop) return 'caron';
    return null;
  }
  if (s.slant > 0.35) return 'acute';
  if (s.slant < -0.35) return 'grave';
  return null;
}

/**
 * Measures of a piece of ink in CSS px: its box, centre and mass; how far right its top half sits of its
 * bottom half (slant); how spread out the top and bottom halves are; how much the middle of each column rises
 * and falls along it (wave); how much lower its middle columns' tops are than its ends' (cupped, 0-1 of its
 * height); whether it encloses background (hole).
 */
function shapeOf(pixels, scale) {
  const xs = pixels.map(([x]) => x);
  const ys = pixels.map(([, y]) => y);
  const left = Math.min(...xs);
  const right = Math.max(...xs) + 1;
  const top = Math.min(...ys);
  const bottom = Math.max(...ys) + 1;
  const mass = pixels.reduce((sum, [, , v]) => sum + v, 0);
  const cx = pixels.reduce((sum, [x, , v]) => sum + (x + 0.5) * v, 0) / mass;
  const cy = pixels.reduce((sum, [, y, v]) => sum + (y + 0.5) * v, 0) / mass;
  const middle = (top + bottom) / 2;
  const half = (inTop) => pixels.filter(([, y]) => (y + 0.5 < middle) === inTop);
  const centreX = (list) => list.reduce((sum, [x, , v]) => sum + (x + 0.5) * v, 0) / (list.reduce((sum, [, , v]) => sum + v, 0) || 1);
  const spread = (list) => {
    const c = centreX(list);
    return list.reduce((sum, [x, , v]) => sum + Math.abs(x + 0.5 - c) * v, 0) / (list.reduce((sum, [, , v]) => sum + v, 0) || 1);
  };
  const upper = half(true);
  const lower = half(false);
  // Per column: the ink's vertical middle and its top.
  const columns = new Map();
  for (const [x, y, v] of pixels) {
    const c = columns.get(x) ?? { sum: 0, weight: 0, top: Infinity };
    c.sum += (y + 0.5) * v;
    c.weight += v;
    c.top = Math.min(c.top, y);
    columns.set(x, c);
  }
  const middles = [...columns.values()].map((c) => c.sum / c.weight);
  const tops = [...columns.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c.top);
  const ends = Math.min(tops[0], tops.at(-1));
  const inner = tops.slice(1, -1);
  return {
    width: (right - left) / scale,
    height: (bottom - top) / scale,
    mass,
    cx: cx / scale,
    cy: cy / scale,
    slant: upper.length && lower.length ? (centreX(upper) - centreX(lower)) / scale : 0,
    spreadTop: spread(upper),
    spreadBottom: spread(lower),
    wave: (Math.max(...middles) - Math.min(...middles)) / scale,
    cupped: inner.length ? (Math.min(...inner) - ends) / (bottom - top) : 0,
    hole: enclosesBackground(pixels, left, top, right, bottom),
  };
}

/** Whether background pixels inside the piece's box can't reach the box's edge without crossing the piece. */
function enclosesBackground(pixels, left, top, right, bottom) {
  const w = right - left;
  const h = bottom - top;
  const solid = new Uint8Array(w * h);
  for (const [x, y] of pixels) solid[(y - top) * w + (x - left)] = 1;
  const reached = new Uint8Array(w * h);
  const stack = [];
  for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
  while (stack.length) {
    const p = stack.pop();
    if (reached[p] || solid[p]) continue;
    reached[p] = 1;
    const x = p % w;
    if (x > 0) stack.push(p - 1);
    if (x < w - 1) stack.push(p + 1);
    if (p >= w) stack.push(p - w);
    if (p + w < w * h) stack.push(p + w);
  }
  for (let p = 0; p < w * h; p++) if (!solid[p] && !reached[p]) return true;
  return false;
}
