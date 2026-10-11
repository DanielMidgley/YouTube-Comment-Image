// How wide Chromium lays out a line of Roboto text: advance widths, kerning and the ink extents of the first
// and last glyphs, from roboto-metrics.js. Lets OCR results be checked against the width of the text in the
// screenshot.
import { ROBOTO_GLYPHS, ROBOTO_KERNING } from './roboto-metrics.js';

const FALLBACK = [560, 40, 520]; // a typical letter, for characters the table lacks

function load(weight) {
  const glyphs = new Map(ROBOTO_GLYPHS[weight].split(' ').map((entry) => {
    const [code, values] = entry.split(':');
    return [parseInt(code, 16), values.split(',').map(Number)];
  }));
  const kerning = new Map(ROBOTO_KERNING[weight].split(' ').filter(Boolean).map((entry) => {
    const [pair, value] = entry.split(':');
    const [a, b] = pair.split(',').map((hex) => parseInt(hex, 16));
    return [`${a},${b}`, Number(value)];
  }));
  return { glyphs, kerning };
}

const FONTS = { 400: load(400), 500: load(500) };

/**
 * The empty space Chromium leaves between the ink of `a` and of `b` set side by side (CSS px), kerning
 * included: their side bearings, which a 1 or a colon makes as wide as a space between tight letters.
 */
export function inkGap(a, b, weight = 400, size = 14) {
  const { glyphs, kerning } = FONTS[weight];
  const [codeA, codeB] = [a.codePointAt(0), b.codePointAt(0)];
  const [widthA, , rightA] = glyphs.get(codeA) ?? FALLBACK;
  const [, leftB] = glyphs.get(codeB) ?? FALLBACK;
  return ((widthA - rightA + (kerning.get(`${codeA},${codeB}`) ?? 0) + leftB) * size) / 1000;
}

/**
 * Where each of `chars` puts its ink when they are set on one line, as [{ left, right }] in CSS px from the
 * first character's ink, kerning included (a space's left and right are equal).
 */
export function inkPositions(chars, weight = 400, size = 14) {
  const { glyphs, kerning } = FONTS[weight];
  const codes = chars.map((c) => c.codePointAt(0));
  let pen = 0;
  const positions = codes.map((code, i) => {
    const [width, inkLeft, inkRight] = glyphs.get(code) ?? FALLBACK;
    const at = code === 0x20 ? { left: pen, right: pen } : { left: pen + inkLeft, right: pen + inkRight };
    pen += width + (i + 1 < codes.length ? kerning.get(`${code},${codes[i + 1]}`) ?? 0 : 0);
    return at;
  });
  const origin = positions[0]?.left ?? 0;
  return positions.map(({ left, right }) => ({ left: ((left - origin) * size) / 1000, right: ((right - origin) * size) / 1000 }));
}

/**
 * The empty space Roboto leaves on either side of `char`'s ink, { left, right } in CSS px (a 1 stands well
 * clear of what follows it, an o barely).
 */
export function bearings(char, weight = 400, size = 14) {
  const [width, inkLeft, inkRight] = FONTS[weight].glyphs.get(char.codePointAt(0)) ?? FALLBACK;
  return { left: (inkLeft * size) / 1000, right: ((width - inkRight) * size) / 1000 };
}

/** Whether every character of `text` is in the table (otherwise widths are guesses). */
export function knows(text, weight = 400) {
  const { glyphs } = FONTS[weight];
  return [...text].every((c) => glyphs.has(c.codePointAt(0)));
}

/** Advance width of one character in em (Roboto `weight`). */
export function advance(char, weight = 400) {
  return ((FONTS[weight].glyphs.get(char.codePointAt(0)) ?? FALLBACK)[0]) / 1000;
}

/**
 * The width of the ink of `text` set on one line in Roboto `weight` at `size` px: from the left edge of the
 * first visible glyph to the right edge of the last, kerning included.
 */
export function inkWidth(text, weight = 400, size = 14) {
  const { glyphs, kerning } = FONTS[weight];
  const codes = [...text].map((c) => c.codePointAt(0));
  let pen = 0;
  let left = Infinity;
  let right = -Infinity;
  codes.forEach((code, i) => {
    const [width, inkLeft, inkRight] = glyphs.get(code) ?? FALLBACK;
    if (code !== 0x20 && inkRight > inkLeft) {
      left = Math.min(left, pen + inkLeft);
      right = Math.max(right, pen + inkRight);
    }
    pen += width + (i + 1 < codes.length ? kerning.get(`${code},${codes[i + 1]}`) ?? 0 : 0);
  });
  return right > left ? ((right - left) * size) / 1000 : 0;
}
