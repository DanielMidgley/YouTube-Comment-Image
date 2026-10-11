// Fast checks, without Electron, of the corpus generator's pure parts and of the committed fixtures (their
// PNGs decoded here by pngjs, independently of the Chromium encoder that wrote them). Run:
//   node --test test/screenshots/corpus.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PNG } from 'pngjs';
import { splitEmoji } from '../../src/comment/emoji.js';
import { createBitmap } from './bitmap.js';
import { ROLE_VARIANTS, SCALES, THEMES, planCorpus, planFixtures } from './plan.js';
import { createRng } from './random.js';
import { applyTransforms } from './transforms.js';
import { validateCase } from './validate.js';
import { MAX_MESSAGE, TIMESTAMP_STYLES, makeMessage, makeName, makeTimestamps } from './vocabulary.js';

const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures', 'screenshots');
const NARROW_NBSP = String.fromCharCode(0x202f);
const VARIATION_SELECTOR = String.fromCharCode(0xfe0f);

const variant = ({ role, memberBadge, moderatorBadge }) => (role === 'member' ? (memberBadge ? 'member-badge' : 'member')
  : role === 'moderator' ? `moderator-${moderatorBadge}` : role);

/** pngjs gives RGBA; the corpus code works on BGRA, as nativeImage does. */
function readPng(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  const data = Buffer.from(png.data);
  for (let i = 0; i < data.length; i += 4) [data[i], data[i + 2]] = [data[i + 2], data[i]];
  return { width: png.width, height: png.height, data };
}

/** Width and height from a JPEG's start-of-frame segment. */
function jpegSize(bytes) {
  for (let i = 2; i + 9 < bytes.length;) {
    const marker = bytes[i + 1];
    if (bytes[i] !== 0xff) break;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { width: bytes.readUInt16BE(i + 7), height: bytes.readUInt16BE(i + 5) };
    }
    i += 2 + bytes.readUInt16BE(i + 2);
  }
  throw new Error('no JPEG frame header');
}

test('plans are deterministic, prefix-stable, and cover every theme × role variant × scale first', () => {
  const plans = planCorpus({ count: 120, seed: 'test' });
  assert.deepEqual(planCorpus({ count: 120, seed: 'test' }), plans);
  assert.deepEqual(planCorpus({ count: 30, seed: 'test' }), plans.slice(0, 30));
  assert.notDeepEqual(planCorpus({ count: 30, seed: 'other' }), plans.slice(0, 30));
  const strata = new Set(plans.slice(0, 84).map((p) => `${p.theme}/${variant(p.rows[p.focus])}/${p.scale}`));
  assert.equal(strata.size, THEMES.length * ROLE_VARIANTS.length * SCALES.length);
});

test('plans keep a stack readable and pads where a snip can have them', () => {
  for (const plan of planCorpus({ count: 400, seed: 'test' })) {
    const { stack, pad, avatarCut } = plan.transform;
    if (stack) {
      assert.equal(plan.rows.length, stack.count);
      assert.equal(plan.margin, 0);
      assert.ok(stack.count - (stack.cutTop ? 1 : 0) - (stack.cutBottom ? 1 : 0) >= 1, `${plan.id}: no whole row`);
      assert.equal(plan.focus, stack.cutTop ? 1 : 0);
      if (plan.timestampStyle) assert.ok(plan.rows.every((row) => row.timestamp));
    }
    if (avatarCut != null) assert.ok(!plan.hideAvatar);
    if (pad && (plan.hideAvatar || avatarCut != null)) assert.equal(pad.left, 0);
    if (pad && stack?.cutTop) assert.equal(pad.top, 0);
    if (pad && stack?.cutBottom) assert.equal(pad.bottom, 0);
  }
});

test("names follow YouTube's handle rules, or are display names without an @", () => {
  const rng = createRng('names');
  const lengths = { handle: new Set(), display: new Set() };
  for (let i = 0; i < 3000; i++) {
    const { name, kind } = makeName(rng);
    if (kind === 'handle') assert.match(name, /^@[\p{L}\p{N}_.-]{3,30}$/u);
    else assert.ok(!name.startsWith('@') && name === name.trim() && !name.includes('  '), name);
    lengths[kind].add([...name].length);
  }
  // Long names too: they are what moves the name chip onto a line of its own in a narrow chat.
  assert.ok([...lengths.handle].some((n) => n > 25) && Math.max(...lengths.handle) <= 31, [...lengths.handle].join());
  assert.ok(Math.max(...lengths.display) >= 30, [...lengths.display].join());
});

test('messages are 1–200 characters of single-spaced text', () => {
  const rng = createRng('messages');
  let withEmoji = 0;
  for (let i = 0; i < 3000; i++) {
    const { text } = makeMessage(rng);
    const length = [...text].length;
    assert.ok(length >= 1 && length <= MAX_MESSAGE, `${length}: ${text}`);
    assert.ok(text === text.trim() && !/\s{2}|[\n\r\t]/.test(text), JSON.stringify(text));
    if (splitEmoji(text).some((run) => run.type === 'emoji')) withEmoji++;
  }
  assert.ok(withEmoji > 3000 * 0.25 && withEmoji < 3000 * 0.38, `${withEmoji} of 3000 messages have emoji`);
});

test("timestamps are formatted as YouTube's chat shows them", () => {
  const rng = createRng('timestamps');
  const clock = new RegExp(`^(?:[1-9]|1[0-2]):[0-5][0-9]${NARROW_NBSP}[AP]M$`);
  const patterns = { clock, 'clock-12': clock, elapsed: /^[0-5]?[0-9]:[0-5][0-9]$/, 'elapsed-hours': /^[1-9]:[0-5][0-9]:[0-5][0-9]$/ };
  for (const style of TIMESTAMP_STYLES) {
    for (let i = 0; i < 200; i++) for (const time of makeTimestamps(rng, style, 4)) assert.match(time, patterns[style]);
  }
  assert.ok(makeTimestamps(rng, 'clock-12', 1)[0].startsWith('12:'));
});

test('transforms move the geometry exactly as they move the pixels', () => {
  const box = (x, y, width, height) => ({ x, y, width, height });
  const geometry = {
    row: box(0, 0, 100, 40), avatar: box(24, 4, 24, 24), timestamp: null, nameChip: box(60, 8, 30, 16), nameText: box(60, 8, 30, 16),
    badges: [], message: box(92, 8, 8, 16), lines: [{ box: box(92, 8, 8, 16), text: 'hi' }], emoji: [],
  };
  const resize = (bitmap, width, height) => createBitmap(width, height);
  const plan = (transform) => ({ id: 't', transform: { jpegQuality: null, pad: null, resample: null, stack: null, avatarCut: null, ...transform } });

  const padded = applyTransforms(createBitmap(100, 40), [geometry], plan({ pad: { left: 3, top: 5, right: 7, bottom: 2 } }), { background: [0, 0, 0], resize });
  assert.deepEqual([padded.bitmap.width, padded.bitmap.height], [110, 47]);
  assert.deepEqual(padded.geometries[0].lines[0].box, box(95, 13, 8, 16));

  const cut = applyTransforms(createBitmap(100, 40), [geometry], plan({ avatarCut: 0.5 }), { background: [0, 0, 0], resize });
  assert.equal(cut.transform.avatarCut, 36);
  assert.deepEqual(cut.geometries[0].avatar, box(-12, 4, 24, 24));
  assert.equal(cut.bitmap.width, 64);

  const scaled = applyTransforms(createBitmap(100, 40), [geometry], plan({ resample: 1.2 }), { background: [0, 0, 0], resize });
  assert.deepEqual([scaled.bitmap.width, scaled.bitmap.height, scaled.resampleX], [120, 48, 1.2]);
  assert.ok(Math.abs(scaled.geometries[0].nameChip.x - 72) < 1e-9 && Math.abs(scaled.geometries[0].nameChip.height - 19.2) < 1e-9);

  const stacked = applyTransforms(createBitmap(100, 80), [geometry, { ...geometry, row: box(0, 40, 100, 40) }],
    plan({ stack: { count: 2, cutTop: 0.5, cutBottom: 0 } }), { background: [0, 0, 0], resize });
  assert.deepEqual(stacked.transform.stack, { count: 2, cutTop: 20, cutBottom: 0 });
  assert.deepEqual(stacked.geometries[1].row, box(0, 20, 100, 40));
});

// ---- The committed fixtures ----------------------------------------------------------------------------------

const fixtures = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'cases.json'), 'utf8'));

test('the fixtures are the planned set, and every image matches its manifest entry', () => {
  assert.deepEqual(fixtures.map((e) => e.id), planFixtures().map((p) => p.id));
  for (const entry of fixtures) {
    const file = path.join(FIXTURES, entry.file);
    if (entry.file.endsWith('.png')) {
      assert.deepEqual(validateCase(entry, readPng(file)), [], entry.id);
    } else {
      assert.deepEqual(jpegSize(fs.readFileSync(file)), { width: entry.width, height: entry.height }, entry.id);
      assert.deepEqual(validateCase(entry), [], entry.id);
    }
    for (const { truth, props } of entry.comments) {
      assert.ok(!truth.message.includes(VARIATION_SELECTOR));
      assert.equal(truth.message, props.message.replaceAll(VARIATION_SELECTOR, ''));
      assert.equal(truth.name, props.name);
    }
  }
});

test("the fixtures cover what the reader's unit tests need", () => {
  const tags = new Set(fixtures.flatMap((e) => e.tags));
  const wanted = ['theme:dark', 'theme:light', 'role:viewer', 'role:member', 'role:member-badge', 'role:moderator-shield',
    'role:moderator-wrench', 'role:owner', 'verified:yes', 'timestamp:clock', 'timestamp:clock-12', 'timestamp:elapsed',
    'timestamp:elapsed-hours', 'avatar:letter', 'avatar:image', 'avatar:none', 'scale:1', 'scale:1.25', 'scale:1.5', 'scale:2',
    'emoji:start', 'emoji:middle', 'emoji:end', 'emoji:only', 'name:display', 'name:accented', 'transform:jpeg', 'transform:pad',
    'transform:stack-cut', 'transform:avatar-cut'];
  for (const tag of wanted) assert.ok(tags.has(tag), tag);
  assert.ok(fixtures.some((e) => e.comments[e.target].geometry.lines.length >= 3), 'a multi-line message');
  const stack = fixtures.find((e) => e.transform.stack);
  assert.deepEqual([stack.comments.length, stack.comments[0].complete, stack.target], [3, false, 1]);
  const bytes = fixtures.reduce((sum, e) => sum + fs.statSync(path.join(FIXTURES, e.file)).size, 0);
  assert.ok(bytes < 300 * 1024, `${bytes} bytes of fixture images`);
});
