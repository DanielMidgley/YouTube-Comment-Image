import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appearTime, splitGraphemes, typingFrames } from '../../src/comment/typing.js';

const settings = { cps: 10, fps: 30, leadIn: 0.5, hold: 1 };

test('characters are graphemes: emoji and accents are one keystroke each', () => {
  assert.deepEqual(splitGraphemes('Hi 👨‍👩‍👧!'), ['H', 'i', ' ', '👨‍👩‍👧', '!']);
  assert.deepEqual(splitGraphemes('e\u0301'), ['e\u0301']);
  assert.deepEqual(splitGraphemes(''), []);
});

test('nothing during the lead-in, then one character every 1/cps seconds', () => {
  const frames = typingFrames(5, settings);
  assert.equal(frames[0], 0);
  assert.equal(frames[14], 0); // 0.467 s
  assert.equal(frames[15], 1); // 0.5 s: the first character
  assert.equal(frames[17], 1); // 0.567 s
  assert.equal(frames[18], 2); // 0.6 s: the second
  assert.equal(frames[27], 5); // 0.9 s: the last one appears at leadIn + 4/cps
});

test('the finished comment is held, and the video ends on it', () => {
  const frames = typingFrames(5, settings);
  assert.equal(frames.length, Math.ceil((0.5 + 0.4 + 1) * 30)); // 57 frames = 1.9 s
  assert.ok(frames.slice(27).every((n) => n === 5));
  const noHold = typingFrames(5, { ...settings, hold: 0 });
  assert.equal(noHold.at(-1), 5);
});

test('frames never go backwards, and fast typing can skip states', () => {
  const frames = typingFrames(40, { cps: 60, fps: 30, leadIn: 0, hold: 0.5 });
  assert.ok(frames.every((n, i) => i === 0 || n >= frames[i - 1]));
  assert.ok(new Set(frames).size < 41, '60 characters per second at 30 fps shows two per frame');
});

test('an empty message still makes a (short) video', () => {
  assert.deepEqual([...new Set(typingFrames(0, settings))], [0]);
  assert.equal(appearTime(0, settings), 0.5);
});
