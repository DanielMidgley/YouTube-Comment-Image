import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emojiCode, emojiUrl, isEmoji, splitEmoji } from '../../src/comment/emoji.js';

const codes = (text) => splitEmoji(text).map((run) => (run.type === 'emoji' ? `[${emojiCode(run.emoji)}]` : run.text));

test('splits text and emoji, merging adjacent text', () => {
  assert.deepEqual(codes('Hello 😆 world'), ['Hello ', '[1f606]', ' world']);
  assert.deepEqual(codes('a😆😆b'), ['a', '[1f606]', '[1f606]', 'b']);
  assert.deepEqual(codes('no emoji here'), ['no emoji here']);
  assert.deepEqual(splitEmoji(''), []);
});

test('keeps multi-code-point emoji whole', () => {
  assert.deepEqual(codes('👨‍👩‍👧'), ['[1f468_200d_1f469_200d_1f467]']); // ZWJ family
  assert.deepEqual(codes('👍🏽'), ['[1f44d_1f3fd]']); // skin tone
  assert.deepEqual(codes('🇺🇸'), ['[1f1fa_1f1f8]']); // flag
  assert.deepEqual(codes('🏳️‍🌈'), ['[1f3f3_200d_1f308]']); // FE0F inside a ZWJ sequence
});

test('names emoji like Noto: lowercase hex, at least 4 digits, no FE0F', () => {
  assert.equal(emojiCode('#️⃣'), '0023_20e3');
  assert.equal(emojiCode('❤️'), '2764');
  assert.equal(emojiCode('☺️'), '263a');
});

test("follows YouTube's own emoji set: symbols it lists are images even without U+FE0F", () => {
  assert.deepEqual(codes('© ™ ❤ ☺ ♥'), ['[00a9]', ' ', '[2122]', ' ', '[2764]', ' ', '[263a]', ' ', '[2665]']);
  assert.deepEqual(codes('love ❤️ it'), ['love ', '[2764]', ' it']); // U+FE0F is dropped, as YouTube does
  assert.deepEqual(codes('1 # * plain'), ['1 # * plain']);
  assert.equal(isEmoji('☺'), true);
});

test("emoji newer than YouTube's set stay text, as they do on YouTube", () => {
  assert.deepEqual(codes('so tired 🫩'), ['so tired 🫩']);
  assert.equal(isEmoji('🫩'), false);
});

test('builds the URL YouTube uses (notoemoji 15.1, 72px)', () => {
  assert.equal(emojiUrl('🔥'), 'https://fonts.gstatic.com/s/e/notoemoji/15.1/1f525/72.png');
});
