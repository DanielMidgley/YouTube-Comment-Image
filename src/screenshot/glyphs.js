// Settles OCR confusions that a character's size and position give away. Tesseract sees one cropped line at a
// time and cannot always tell a capital V from a lowercase v where Roboto draws them alike; on the screenshot,
// their height above the baseline (cap height 10px, x-height 7.4px at 14px) can. Likewise a capital I is a
// pixel shorter than a lowercase l, a pipe or a bracket reaches below the baseline where either does not, as
// does a semicolon where a colon does not, and a dollar sign above and below where an 8 does not. Quotes are
// read by their slant: Roboto's straight ' and " stand upright, curly ones lean like a /, and Tesseract mixes
// the two up; chat typed on a computer has straight ones, phones often add curly ones.
//
// Tesseract's own character boxes are too loose to measure with, so each character's columns are found by
// sharing out its word's width in proportion to Roboto's advance widths. A correction is only made when
// Tesseract itself considered the alternative (its per-character choices), so letters it read with certainty
// stay as read.
import { accentLetter } from './accents.js';
import { advance } from './metrics.js';

const X_HEIGHT = 7.4; // CSS px, Roboto 14px
const CAP_HEIGHT = 10;
const FONT_SIZE = 14;
// Letters Roboto draws with the same outline in both cases (only the size differs).
const SAME_SHAPE = new Set([...'cosuvwxzCOSUVWXZ']);
// Capitals whose small letter reaches no higher than the x-height (its tail may hang below the baseline).
const LOWERABLE = new Set([...'ACEGMNOPQRSUVWXYZ']);
const MIN_CHOICE = 10; // confidence (0-100) an alternative needs to be considered
// Quote marks by their slant (how far right the top half of a mark sits of its bottom half, in CSS px). From
// 1.5x up, straight ones measure at most 0.22px and curly ones at least 0.26px in Chromium's renders; below
// that the marks are 2-4 px of ink and the two overlap, so they count as straight (most chat's quotes are:
// four in five apostrophes in a real chat log, every double quote).
const SINGLE_QUOTES = new Set(["'", '\u2018', '\u2019', '`', '\u00b4']);
const DOUBLE_QUOTES = new Set(['"', '\u201c', '\u201d']);
const CURLY_SLANT = 0.24;
const MIN_QUOTE_SCALE = 1.5;
// Chromium draws the tops of every capital and digit on the same row (at half strength), and those of b, d, h,
// k and l a row or two higher: Tesseract's confident readings of those, measured, tell an I from an l.
const CAPITALS = /^[A-HJ-Z0-9]$/;
const ASCENDERS = new Set([...'bdhk']);
const MIN_REFERENCE_CONFIDENCE = 60;

const luminance = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function insideRoundedBox(px, py, { box: b, radius }) {
  const cx = Math.min(Math.max(px, b.x + radius), b.x + b.width - radius);
  const cy = Math.min(Math.max(py, b.y + radius), b.y + b.height - radius);
  return (px - cx) ** 2 + (py - cy) ** 2 <= radius ** 2;
}

/**
 * The words of an OCR `result` ({ words: [{ box, symbols: [{ text, confidence, choices }] }] }, boxes in the
 * OCR image) with those confusions fixed, as [{ chars, left, right }]: chars [{ text, alternatives }]
 * (alternatives: the other characters Tesseract considered there), left and right the word's extent on the
 * screenshot (device px). `place` maps the OCR image back to the screenshot: { image, region (with ink,
 * background, baseline), crop, factor, padding, scale, heights }; heights ({ capitals: [], ascenders: [] }),
 * shared by the regions of one comment, collects the measured heights of capitals and ascenders. `kind` is
 * 'name' (Roboto 500) or 'message' (Roboto 400).
 */
export function correctWords(result, place, kind) {
  const weight = kind === 'name' ? 500 : 400;
  const spans = result.words.map((word) => characterSpans(word.symbols.map((s) => s.text), word.box, place, weight));
  const heights = place.heights ?? { capitals: [], ascenders: [] };
  result.words.forEach((word, w) => word.symbols.forEach((symbol, i) => {
    const capital = CAPITALS.test(symbol.text);
    if (!(capital || ASCENDERS.has(symbol.text)) || !(symbol.confidence >= MIN_REFERENCE_CONFIDENCE)) return;
    const ink = measure(spans[w][i], place);
    if (ink) heights[capital ? 'capitals' : 'ascenders'].push(ink.baseline - ink.top);
  }));
  const reference = { capital: median(heights.capitals), ascender: median(heights.ascenders) };
  const at = { ...place, reference };
  return result.words.map((word, w) => {
    // A vertical bar measured is settled: no alternative for it is tried. (An i Tesseract was unsure of may be
    // a bar too: see barLetter.)
    const settled = word.symbols.map((symbol) => {
      const considered = consideredBy(symbol);
      if (symbol.text === 'i') return place.scale >= 1.25 && (considered('I') || considered('l'));
      return BARS.has(symbol.text);
    });
    const texts = word.symbols.map((symbol, i) => {
      // (A bar Tesseract thought might be a ! is one if its dot stands apart; otherwise a bar like any other.)
      if (settled[i] && BARS.has(symbol.text) && consideredBy(symbol)('!') && measure(spans[w][i], at)?.gap) {
        settled[i] = false;
        return '!';
      }
      const bar = settled[i] ? barLetter(symbol.text, spans[w][i], at, kind, consideredBy(symbol), word.symbols.length === 1) : null;
      if (bar === null) settled[i] = false;
      const text = bar ?? correct(symbol, spans[w][i], { ...at, word: { left: spans[w][0].left, right: spans[w].at(-1).right } }, kind, i === 0);
      return accentLetter(text, spans[w][i], at) ?? text;
    });
    const corrected = caseOfRuns(texts, spans[w], place, kind);
    return {
      chars: corrected.map((text, i) => ({
        text,
        alternatives: settled[i] ? [] : (word.symbols[i].choices ?? []).filter((c) => c.confidence >= MIN_CHOICE).map((c) => c.text)
          .filter((alt) => sameCase(alt, text) && !(isQuote(alt) && (isQuote(text) || place.scale < MIN_QUOTE_SCALE))
            && !((text === 'I' || text === 'l') && BARS.has(alt))),
      })),
      left: spans[w][0].left,
      right: spans[w].at(-1).right,
    };
  });
}

const isQuote = (c) => SINGLE_QUOTES.has(c) || DOUBLE_QUOTES.has(c);
const consideredBy = (symbol) => (alternative) => (symbol.choices ?? []).some((c) => c.text === alternative && c.confidence >= MIN_CHOICE);
// Vertical bars: which one an I or l is was settled by its height (barLetter).
const BARS = new Set([...'Il|[]']);

function median(values) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Whether `alternative` may replace `char` as far as case goes: the case of letters Roboto draws alike in both
 * cases is settled by their height (above), so their alternatives keep it.
 */
function sameCase(alternative, char) {
  if (!SAME_SHAPE.has(char) || !/^\p{L}$/u.test(alternative)) return true;
  return (alternative === alternative.toUpperCase()) === (char === char.toUpperCase());
}

/**
 * Runs of look-alike letters are where the OCR stumbles most: it splits and merges the zigzags of V and W
 * (see widths.js), and reads a drawn-out GOOOOOO or sooooo or yessssss as a mixture of cases, and of O, o
 * and zero. Each such run gets the case its height on the screenshot shows (measured over the whole run,
 * which Tesseract's miscounting can't misplace the way it does one letter's share of the word), so that only
 * its length is left to settle (widths.js). The runs: V and W mixed; and in messages, a letter Roboto draws
 * alike in both cases repeated three times or more in mixed cases, and O, o and 0 in a word of letters with a
 * zero among them (in a number, or a name made to confuse, a 0 stays a 0).
 */
function caseOfRuns(chars, spans, place, kind) {
  const out = [...chars];
  // (An @mention in a message is a handle: its cases and zeros are as meant.)
  if (out[0] === '@') kind = 'name';
  const letters = out.filter((c) => /^\p{L}$/u.test(c)).length;
  const runOf = (c, previous) => {
    if (/^[VWvw]$/.test(c)) return 'zigzag';
    // (A Q among O's is one whose round Tesseract took for a Q's.)
    if (kind === 'message' && (/^[0Oo]$/.test(c) || (c === 'Q' && /^[0Oo]$/.test(previous ?? '')))) return 'round';
    return SAME_SHAPE.has(c) ? c.toLowerCase() : null;
  };
  for (let i = 0; i < out.length;) {
    const run = runOf(out[i], out[i - 1]);
    if (!run) { i++; continue; }
    let j = i + 1;
    while (j < out.length && runOf(out[j], out[j - 1]) === run) j++;
    // A capital that starts the word is measured on its own: phones capitalise a drawn-out word (Ooooh, Sssh).
    // (Tesseract can have read that O as a zero.)
    const startsWord = !/^\p{L}$/u.test(out[i - 1] ?? '');
    if (run !== 'zigzag' && j - i >= 3 && startsWord && letters >= 1 && (/^\p{Lu}$/u.test(out[i]) || out[i] === '0')) {
      const ink = measure(spans[i], place);
      if (ink && ink.baseline - ink.top >= ((X_HEIGHT + CAP_HEIGHT) / 2) * place.scale + 0.5) {
        if (run === 'round') out[i] = 'O';
        i++;
        continue;
      }
    }
    const part = out.slice(i, j);
    const mixed = part.some((c) => /\p{Lu}/u.test(c)) && part.some((c) => /\p{Ll}/u.test(c));
    const digitBeside = /^\p{N}$/u.test(out[i - 1] ?? '') || /^\p{N}$/u.test(out[j] ?? '');
    // Only where Tesseract shows it was unsure: a zigzag, or in a message a zero among letters or a drawn-out
    // letter in mixed cases (two in a row can be camelCase: MusicCity; names mix cases on purpose).
    const drawnOut = kind === 'message' && j - i >= 3 && mixed;
    const unsure = run === 'zigzag' ? j - i >= 2
      : run === 'round' ? ((part.includes('0') || part.includes('Q')) && !digitBeside && letters >= 1) || drawnOut
        : drawnOut;
    if (unsure) {
      const ink = measure({ left: spans[i].left, right: spans[j - 1].right }, place);
      if (ink) {
        const tall = ink.baseline - ink.top >= ((X_HEIGHT + CAP_HEIGHT) / 2) * place.scale + 0.5;
        for (let k = i; k < j; k++) {
          if (run === 'round') out[k] = tall ? 'O' : 'o';
          else out[k] = tall ? out[k].toUpperCase() : out[k].toLowerCase();
        }
      }
    }
    i = j;
  }
  return out;
}

/** Screenshot columns of each character: the word's span shared out by advance width. */
function characterSpans(chars, wordBox, { crop, factor, padding }, weight) {
  const left = crop.x + (wordBox.x - padding) / factor;
  const right = crop.x + (wordBox.x + wordBox.width - padding) / factor;
  const advances = chars.map((c) => [...c].reduce((sum, ch) => sum + advance(ch, weight), 0));
  const total = advances.reduce((a, b) => a + b, 0) || 1;
  let at = 0;
  return advances.map((a) => {
    const span = { left: left + ((right - left) * at) / total, right: left + ((right - left) * (at + a)) / total };
    at += a;
    return span;
  });
}

function correct(symbol, span, place, kind, startsWord) {
  const { text } = symbol;
  if (SINGLE_QUOTES.has(text) || DOUBLE_QUOTES.has(text)) return quote(text, span, place, startsWord);
  const considered = consideredBy(symbol);
  const pipe = text === '|';
  const exclamation = 'lI|1i'.includes(text) && considered('!');
  const caseFlip = SAME_SHAPE.has(text) && considered(text === text.toUpperCase() ? text.toLowerCase() : text.toUpperCase());
  const dollar = text === '8' && considered('$');
  const eyes = text === ';' || (text === ':' && considered(';'));
  const zero = '0Oo'.includes(text) && [...'0Oo'].some((c) => c !== text && considered(c));
  // A capital read where the glyph only reaches the x-height is its small letter (YES for yes, an N for n):
  // tested by height alone, since a short reading can't come from a neighbour's ink (a tall one could).
  const lowerable = LOWERABLE.has(text) && !caseFlip;
  if (!(pipe || exclamation || caseFlip || dollar || zero || eyes || lowerable)) return text;

  if (eyes) {
    // A semicolon's tail reaches 2px or more below the baseline; a colon's dot sits on it.
    const below = belowDots(span, place);
    if (below === null) return text;
    return below <= 0 ? ':' : below >= Math.max(1, 0.8 * place.scale) ? ';' : text;
  }
  const ink = measure(span, place);
  if (!ink) return text;
  // An exclamation mark's dot stands apart from its stroke; a letter's stroke is unbroken.
  if (exclamation && ink.gap) return '!';
  const { scale } = place;
  const above = ink.baseline - ink.top; // rows of ink above the baseline
  const below = ink.bottom - ink.baseline; // rows below it (0 when the glyph sits on it)
  const tall = above >= ((X_HEIGHT + CAP_HEIGHT) / 2) * scale + 0.5;
  if (lowerable && !(pipe || dollar || zero)) {
    return ink.bottom >= ink.baseline - 1 && above <= (X_HEIGHT + 0.35 * (CAP_HEIGHT - X_HEIGHT)) * scale ? text.toLowerCase() : text;
  }
  if (!(pipe || caseFlip || dollar || zero)) return text;

  if (pipe) return below <= 0.6 * scale ? (kind === 'name' ? 'l' : 'I') : text;
  if (dollar) return below >= 0.8 * scale && above >= (CAP_HEIGHT + 0.6) * scale ? '$' : text;
  if (zero) {
    if (!tall) return considered('o') || text === 'o' ? 'o' : text;
    // A zero is narrower than an O: about 0.47 em of ink against 0.6.
    const round = (ink.right - ink.left) / (FONT_SIZE * scale) >= 0.54 ? 'O' : '0';
    return round === text || considered(round) ? round : text;
  }
  return tall ? text.toUpperCase() : text.toLowerCase();
}

/**
 * A capital I or a lowercase l for a vertical bar Tesseract read (I, l, |, [ or ]), or null to leave it to the
 * other rules. A pipe or a bracket that reaches below the baseline stays. Otherwise its height decides, against
 * the capitals and ascenders measured in the comment (place.reference): taller than the capitals, an l; as
 * tall as them, an I (shorter, the measurement missed it: Tesseract's reading stands). With nothing measured,
 * the cap height Chromium hints Roboto to (CAP_HEIGHT x scale, rounded) stands in, when Tesseract considered
 * the other letter. An l becomes an I only if Tesseract considered one or, in a name (where handles mix them
 * on purpose), when the comment's capitals were measured: blur (a resized screenshot) can take the top row
 * off a thin l, and l is everywhere in messages. A bar whose height says nothing is an l in a name and an I
 * in a message. An i Tesseract doubted, read without the gap under its dot, is a bar like the others.
 */
function barLetter(text, span, place, kind, considered, alone = false) {
  let ink = measure(span, place);
  // Tesseract's box for a word of one letter can sit a pixel or three beside the stroke: look there too.
  if (alone && (!ink || ink.bottom < ink.baseline - 1)) {
    const reach = 2.5 * place.scale;
    ink = measure({ left: span.left - reach, right: span.right + reach }, place);
  }
  if (!ink) return null;
  // A bar stands on the baseline or reaches below it: ink above it is not the letter (its share of the word's
  // columns missed it).
  if (ink.bottom < ink.baseline - 1) return null;
  // An i's dot stands apart from its stem (from 1.25x, where a row between them stays empty).
  if (text === 'i') {
    if (ink.gap) return null;
    text = 'I';
  }
  const bar = !'Il'.includes(text);
  if (bar && ink.bottom - ink.baseline > 0.6 * place.scale) return text;
  const above = ink.baseline - ink.top;
  const { capital, ascender } = place.reference ?? {};
  const measured = Number.isFinite(capital) || Number.isFinite(ascender);
  let tall = null;
  let capHeight = Math.round(CAP_HEIGHT * place.scale);
  if (Number.isFinite(capital) && Number.isFinite(ascender)) {
    // (At a scale Chromium doesn't hint for, capitals and ascenders can measure alike: then height can't tell.)
    if (ascender <= capital) return bar ? (kind === 'name' ? 'l' : 'I') : null;
    tall = above >= (capital + ascender) / 2;
    capHeight = capital;
  } else if (Number.isFinite(capital)) {
    tall = above > capital;
    capHeight = capital;
  } else if (Number.isFinite(ascender)) {
    tall = above >= ascender;
    capHeight = ascender - 1;
  } else if (bar || considered(text === 'I' ? 'l' : 'I')) tall = above > capHeight;
  if (tall === null) return bar ? (kind === 'name' ? 'l' : 'I') : null;
  // (A word of one bar in a message is the pronoun: a lone l is all but unheard of, and blur in a resized
  // screenshot can make an I measure a row taller.)
  if (alone && kind === 'message') return 'I';
  if (tall) return 'l';
  if (above < capHeight) return bar ? (kind === 'name' ? 'l' : 'I') : null;
  return text === 'l' && !(measured && kind === 'name') && !considered('I') ? null : 'I';
}

/**
 * A quote mark as the screenshot shows it: straight unless its marks clearly lean like curly ones; a curly one
 * opens at the start of a word and closes anywhere else (as phones' smart quotes do).
 */
function quote(text, span, place, startsWord) {
  const double = DOUBLE_QUOTES.has(text);
  const { scale } = place;
  if (scale < MIN_QUOTE_SCALE) return double ? '"' : "'";
  const marks = quoteMarks(span, place, double ? 2 : 1);
  const slants = marks.map((mark) => slantOf(mark) / place.scale);
  const curly = slants.length > 0 && slants.every((slant) => slant > CURLY_SLANT);
  if (!curly) return double ? '"' : "'";
  if (double) return startsWord ? '\u201c' : '\u201d';
  return startsWord ? '\u2018' : '\u2019';
}

/**
 * The marks of a quote on the screenshot: pieces of ink that float between the cap height and the x-height
 * (letters reach down to the baseline) with nothing under them (the dot of an i, an accent), found in the
 * word's columns (place.word; a character's share of them can miss a mark that kerning moved); the `count`
 * nearest the character's place, leaving out specks. Each is a list of [x, y, ink] with ink 0-1.
 */
function quoteMarks(span, { image, region, crop, scale, word }, count) {
  const { data, width } = image;
  const bg = luminance(...region.background);
  const range = Math.max(24, Math.abs(luminance(...region.ink) - bg));
  const y0 = Math.max(crop.y, Math.floor(region.baseline - 11.5 * scale));
  const y1 = Math.min(crop.y + crop.height, Math.ceil(region.baseline - 2.5 * scale));
  const yBase = Math.min(crop.y + crop.height, Math.round(region.baseline));
  const x0 = Math.max(crop.x, Math.floor(Math.min(span.left, word?.left ?? Infinity)) - 1);
  const x1 = Math.min(crop.x + crop.width, Math.ceil(Math.max(span.right, word?.right ?? -Infinity)) + 1);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return [];
  const inkAt = (x, y) => {
    const i = (y * width + x) * 4;
    return Math.min(1, Math.abs(luminance(data[i], data[i + 1], data[i + 2]) - bg) / range);
  };
  const ink = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((y0 + y) * width + x0 + x) * 4;
      ink[y * w + x] = Math.min(1, Math.abs(luminance(data[i], data[i + 1], data[i + 2]) - bg) / range);
    }
  }
  // Pieces of solid ink (antialiased edges below 0.3 don't join neighbours), then their fainter edges.
  const seen = new Uint8Array(w * h);
  const pieces = [];
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || ink[start] < 0.3) continue;
    const pixels = [];
    const stack = [start];
    seen[start] = 1;
    let bottom = 0;
    let touchesSide = false;
    while (stack.length) {
      const p = stack.pop();
      const x = p % w;
      const y = (p - x) / w;
      pixels.push([x0 + x, y0 + y, ink[p]]);
      bottom = Math.max(bottom, y);
      if (x === 0 || x === w - 1) touchesSide = true;
      for (const q of [p - 1, p + 1, p - w, p + w]) {
        if (q < 0 || q >= w * h || seen[q] || ink[q] < 0.3) continue;
        if ((q === p - 1 && x === 0) || (q === p + 1 && x === w - 1)) continue;
        seen[q] = 1;
        stack.push(q);
      }
    }
    // A mark ends well above the baseline and lies within the columns searched, with nothing under it.
    if (y0 + bottom >= region.baseline - 4 * scale || touchesSide) continue;
    const columns = [...new Set(pixels.map(([px]) => px))];
    const under = columns.filter((px) => {
      for (let py = y0 + bottom + 2; py < yBase; py++) if (inkAt(px, py) >= 0.3) return true;
      return false;
    });
    if (under.length > 0.5 * columns.length) continue;
    pieces.push(pixels);
  }
  const heaviest = Math.max(0, ...pieces.map(mass));
  const centre = (span.left + span.right) / 2;
  const middle = (pixels) => pixels.reduce((sum, [x, , i]) => sum + (x + 0.5) * i, 0) / mass(pixels);
  return pieces.filter((pixels) => mass(pixels) >= 0.3 * heaviest)
    .sort((a, b) => Math.abs(middle(a) - centre) - Math.abs(middle(b) - centre)).slice(0, count);
}

const mass = (pixels) => pixels.reduce((sum, [, , ink]) => sum + ink, 0);

/** How far right the top half of a mark sits of its bottom half (device px): 0 upright, more for a lean. */
function slantOf(pixels) {
  const top = Math.min(...pixels.map(([, y]) => y));
  const bottom = Math.max(...pixels.map(([, y]) => y));
  const middle = (top + bottom + 1) / 2;
  const sum = [0, 0];
  const weight = [0, 0];
  for (const [x, y, ink] of pixels) {
    const half = y + 0.5 < middle ? 0 : 1;
    sum[half] += x * ink;
    weight[half] += ink;
  }
  return weight[0] && weight[1] ? sum[0] / weight[0] - sum[1] / weight[1] : 0;
}

/**
 * How many rows of ink reach below the baseline under the upper dot of a colon or semicolon: in the columns
 * near the character's that hold ink at the x-height, none halfway down it (a p's stem beside it is
 * unbroken) and none above it (a bracket beside it is taller); null when there is no such dot.
 */
function belowDots(span, { image, region, crop, scale }) {
  const { data, width } = image;
  const bg = luminance(...region.background);
  const range = Math.max(24, Math.abs(luminance(...region.ink) - bg));
  const inked = (x, y) => {
    const i = (y * width + x) * 4;
    return Math.abs(luminance(data[i], data[i + 1], data[i + 2]) - bg) >= 0.5 * range;
  };
  const xTop = Math.round(region.baseline - X_HEIGHT * scale) - 1;
  const dotBottom = Math.round(region.baseline - (X_HEIGHT / 2) * scale);
  const gapTop = Math.round(region.baseline - 0.55 * X_HEIGHT * scale);
  const gapBottom = Math.round(region.baseline - 0.35 * X_HEIGHT * scale);
  const capTop = Math.max(crop.y, Math.round(region.baseline - CAP_HEIGHT * scale) - 1);
  const rowsBelow = Math.min(crop.y + crop.height, Math.ceil(region.baseline + 4 * scale));
  let found = false;
  let below = 0;
  for (let x = Math.max(crop.x, Math.floor(span.left) - 1); x < Math.min(crop.x + crop.width, Math.ceil(span.right) + 1); x++) {
    let dot = false;
    for (let y = Math.max(crop.y, xTop); y < dotBottom && !dot; y++) dot = inked(x, y);
    let tall = false;
    for (let y = capTop; y < xTop && !tall; y++) tall = inked(x, y);
    for (let y = gapTop; y < Math.max(gapTop + 1, gapBottom) && !tall; y++) tall = inked(x, y);
    if (!dot || tall) continue;
    found = true;
    for (let y = region.baseline; y < rowsBelow; y++) if (inked(x, y)) below = Math.max(below, y + 1 - region.baseline);
  }
  return found ? below : null;
}

/**
 * The ink of one character on the screenshot: the rows (and columns) where ink is at least half its full
 * strength within the character's columns, less a pixel each side where ClearType and kerning let neighbours
 * reach in. Returns { top, bottom, left, right, gap, baseline } (bottom and right exclusive; gap: whether an
 * empty row splits the ink; baseline: the first row below the line's text) or null.
 */
function measure(span, { image, region, crop, scale }) {
  if (!Number.isFinite(region.baseline)) return null; // heights are measured from it
  const trim = Math.min(Math.max(0.5, 0.7 * scale), 0.25 * (span.right - span.left));
  let x0 = Math.max(crop.x, Math.round(span.left + trim));
  let x1 = Math.min(crop.x + crop.width, Math.round(span.right - trim));
  if (x1 <= x0) {
    // Narrower than the trim (an I at 1x): its middle column.
    x0 = Math.max(crop.x, Math.floor((span.left + span.right) / 2));
    x1 = Math.min(crop.x + crop.width, x0 + 1);
    if (x1 <= x0) return null;
  }
  const { data, width } = image;
  const bg = luminance(...region.background);
  const range = Math.max(24, Math.abs(luminance(...region.ink) - bg));
  // (Outside an owner's chip, the page's background is the colour of the chip's letters: not theirs.)
  const inside = (x, y) => !region.clip || insideRoundedBox(x + 0.5, y + 0.5, region.clip);
  let top = Infinity;
  let bottom = -1;
  let left = Infinity;
  let right = -1;
  const inkRows = [];
  for (let y = crop.y; y < crop.y + crop.height; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      if (Math.abs(luminance(data[i], data[i + 1], data[i + 2]) - bg) < 0.5 * range || !inside(x, y)) continue;
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
      left = Math.min(left, x);
      right = Math.max(right, x);
      inkRows[y - crop.y] = true;
    }
  }
  if (bottom < 0) return null;
  let gap = false;
  for (let y = top + 1; y < bottom; y++) if (!inkRows[y - crop.y]) gap = true;
  return { top, bottom: bottom + 1, left, right: right + 1, gap, baseline: region.baseline };
}
