import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compositeOver, emojiSignature, matchEmoji } from '../../src/screenshot/emoji-match.js';
import { EMOJI_SIGNATURES, EMOJI_SIGNATURE_VERSION } from '../../src/screenshot/emoji-signatures.js';
import { YOUTUBE_EMOJI_CODES, YOUTUBE_EMOJI_VERSION } from '../../src/comment/youtube-emoji.js';

const DARK = [15, 15, 15];
const LIGHT = [255, 255, 255];

/** A width×height RGBA image filled with `background`. */
function canvas(width, height, background) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([...background, 255], i);
  return { width, height, data };
}

const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/**
 * Draws `emoji` from its own signature into the size×size cell at (x, y): every grid cell is a flat square
 * of the signature's colour composited over `background`, and pixels average what covers them (a box
 * filter, the model the matcher assumes). Returns the ink box (pixels 40+ levels off the background).
 */
function drawFromSignature(image, emoji, { x, y, size, background }) {
  const { grid, cells } = emojiSignature(emoji);
  const colours = compositeOver(cells, background);
  const step = size / grid;
  let ink = null;
  for (let py = Math.max(0, Math.floor(y)); py < Math.min(image.height, Math.ceil(y + size)); py++) {
    for (let px = Math.max(0, Math.floor(x)); px < Math.min(image.width, Math.ceil(x + size)); px++) {
      const rgb = [...background];
      for (let j = 0; j < grid; j++) {
        const wy = overlap(py, py + 1, y + j * step, y + (j + 1) * step);
        for (let i = 0; wy && i < grid; i++) {
          const w = wy * overlap(px, px + 1, x + i * step, x + (i + 1) * step);
          for (let c = 0; c < 3; c++) rgb[c] += w * (colours[(j * grid + i) * 3 + c] - background[c]);
        }
      }
      image.data.set(rgb.map(Math.round), (py * image.width + px) * 4);
      if (rgb.some((v, c) => Math.abs(v - background[c]) >= 40)) {
        ink = ink ? { left: Math.min(ink.left, px), top: Math.min(ink.top, py), right: Math.max(ink.right, px + 1), bottom: Math.max(ink.bottom, py + 1) }
          : { left: px, top: py, right: px + 1, bottom: py + 1 };
      }
    }
  }
  return { x: ink.left, y: ink.top, width: ink.right - ink.left, height: ink.bottom - ink.top };
}

test('composites premultiplied cells over the background', () => {
  const cells = Float32Array.of(
    100, 50, 0, 0.5, // half-covered: colour + half the background
    0, 0, 0, 0, // transparent: the background
    30, 60, 90, 1, // opaque: the colour itself
  );
  assert.deepEqual([...compositeOver(cells, [200, 100, 20])], [200, 100, 10, 200, 100, 20, 30, 60, 90]);
});

test("the signatures cover exactly YouTube's emoji set (else run scripts/update-emoji-signatures.js)", () => {
  assert.equal(EMOJI_SIGNATURE_VERSION, YOUTUBE_EMOJI_VERSION);
  const signed = EMOJI_SIGNATURES.trim().split('\n').flatMap((line) => line.split(' ')[0].split('='));
  assert.equal(new Set(signed).size, signed.length);
  assert.deepEqual(new Set(signed), new Set(YOUTUBE_EMOJI_CODES.trim().split(/\s+/)));
});

// Whole-pixel grid cells (3, 6 or 9 px at 1×, 2×, 3×): the drawing then averages back to the signature
// exactly. (At other scales its flat cells, unlike real artwork, mix where grid lines cut pixels.)
test('recognises an emoji drawn from its own signature, and finds its cell', () => {
  const cases = [
    { emoji: '😀', background: DARK, scale: 1 },
    { emoji: '👍🏽', background: LIGHT, scale: 1 },
    { emoji: '🇯🇵', background: DARK, scale: 2 },
    { emoji: '#⃣', background: LIGHT, scale: 3 },
  ];
  for (const { emoji, background, scale } of cases) {
    const size = 24 * scale;
    const image = canvas(140, 110, background);
    const cell = { x: 41, y: 17, size };
    const box = drawFromSignature(image, emoji, { ...cell, background });
    const result = matchEmoji(image, { box, scale, background });
    assert.equal(result?.emoji, emoji, `${emoji} at ${scale}x`);
    assert.ok(result.score < 1 && result.limit > result.score, `${emoji}: score ${result.score}, limit ${result.limit}`);
    assert.deepEqual(result.box, { x: 41, y: 17, width: size, height: size });
    assert.equal(result.candidates[0].emoji, emoji);
    assert.ok(result.candidates.length >= 5 && result.candidates.every((c, i, all) => i === 0 || c.score >= all[i - 1].score));
  }
});

test('copes with an approximate scale and an ink box a couple of pixels off', () => {
  const image = canvas(80, 60, DARK);
  const box = drawFromSignature(image, '🔥', { x: 20, y: 11, size: 30, background: DARK });
  const shifted = { x: box.x + 2, y: box.y - 1, width: box.width - 3, height: box.height + 2 };
  const result = matchEmoji(image, { box: shifted, scale: 1.3, background: DARK });
  assert.equal(result?.emoji, '🔥');
  assert.deepEqual(result.box, { x: 20, y: 11, width: 30, height: 30 });
});

test('finds an emoji in a resampled screenshot (between pixels) and one cut by the edge of the image', () => {
  const resampled = canvas(80, 60, LIGHT);
  const box = drawFromSignature(resampled, '🎉', { x: 20.4, y: 11.7, size: 26.4, background: LIGHT });
  const result = matchEmoji(resampled, { box, scale: 1.1, background: LIGHT });
  assert.equal(result?.emoji, '🎉');
  assert.ok(Math.abs(result.box.x - 20.4) <= 0.25 && Math.abs(result.box.y - 11.7) <= 0.25 && Math.abs(result.box.width - 26.4) <= 0.25,
    JSON.stringify(result.box));

  const cropped = canvas(40, 40, DARK);
  const cut = drawFromSignature(cropped, '😀', { x: -1, y: 8, size: 24, background: DARK });
  assert.equal(matchEmoji(cropped, { box: cut, scale: 1, background: DARK })?.emoji, '😀');
});

test('names the preferred emoji of a shared image, and lists the others as equal candidates', () => {
  const image = canvas(48, 48, LIGHT);
  const box = drawFromSignature(image, '🇸🇯', { x: 12, y: 12, size: 24, background: LIGHT });
  const result = matchEmoji(image, { box, scale: 1, background: LIGHT });
  assert.equal(result?.emoji, '🇳🇴');
  const twins = result.candidates.filter((c) => c.score === result.score).map((c) => c.emoji);
  assert.deepEqual(twins.sort(), ['🇧🇻', '🇳🇴', '🇸🇯'].sort());
});

test('rejects what is not an emoji: a flat box, noise, an empty background', () => {
  for (const [colour, background] of [[[128, 128, 128], DARK], [[200, 30, 30], LIGHT], [[255, 255, 255], DARK]]) {
    const image = canvas(64, 64, background);
    for (let y = 20; y < 44; y++) for (let x = 20; x < 44; x++) image.data.set(colour, (y * 64 + x) * 4);
    assert.equal(matchEmoji(image, { box: { x: 20, y: 20, width: 24, height: 24 }, scale: 1, background }), null, `flat ${colour}`);
  }
  const noise = canvas(64, 64, DARK);
  let seed = 1;
  for (let i = 0; i < noise.data.length; i++) if (i % 4 !== 3) noise.data[i] = (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24;
  assert.equal(matchEmoji(noise, { box: { x: 20, y: 20, width: 24, height: 24 }, scale: 1, background: DARK }), null, 'noise');
  assert.equal(matchEmoji(canvas(64, 64, DARK), { box: { x: 20, y: 20, width: 24, height: 24 }, scale: 1, background: DARK }), null, 'empty');
});

test('allows more noise where an emoji has more edges and at small scales, and a tolerance on top', () => {
  const limit = (emoji, scale) => {
    const image = canvas(100, 100, LIGHT);
    const box = drawFromSignature(image, emoji, { x: 10, y: 10, size: 24 * scale, background: LIGHT });
    return matchEmoji(image, { box, scale, background: LIGHT }).limit;
  };
  assert.ok(limit('🌸', 1) < limit('🇦🇪', 1), 'a pale blossom on the light theme is held to less noise than a striped flag');
  assert.ok(limit('🇦🇪', 3) < limit('🇦🇪', 1), 'and so is a bigger emoji');

  const image = canvas(64, 64, DARK);
  for (let y = 20; y < 44; y++) for (let x = 20; x < 44; x++) image.data.set([128, 128, 128], (y * 64 + x) * 4);
  const best = matchEmoji(image, { box: { x: 20, y: 20, width: 24, height: 24 }, scale: 1, background: DARK, tolerance: Infinity });
  assert.ok(best && best.score > best.limit, 'tolerance: Infinity names the best match even when it is rejected');
});

test('rejects bad arguments', () => {
  const image = canvas(8, 8, DARK);
  const box = { x: 0, y: 0, width: 4, height: 4 };
  assert.throws(() => matchEmoji(image, { box, scale: 1 }), TypeError);
  assert.throws(() => matchEmoji(image, { box, background: DARK }), TypeError);
  assert.throws(() => matchEmoji(image, { box: { ...box, width: 0 }, scale: 1, background: DARK }), TypeError);
  assert.throws(() => matchEmoji({ width: 8, height: 8, data: new Uint8Array(10) }, { box, scale: 1, background: DARK }), TypeError);
  assert.throws(() => matchEmoji(image, { box, scale: 1, background: DARK, tolerance: 0 }), TypeError);
});
