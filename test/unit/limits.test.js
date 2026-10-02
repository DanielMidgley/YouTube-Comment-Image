import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIMITS, capText } from '../../src/comment/limits.js';

const FAMILY = '👨‍👩‍👧'; // 5 code points, one grapheme
const THUMB = '👍🏽'; // 2 code points, one grapheme

test('text within the limit is returned unchanged', () => {
  assert.equal(capText('hello', 5), 'hello');
  assert.equal(capText('', 5), '');
  assert.equal(capText(FAMILY, 5), FAMILY);
});

test('long text is cut to the limit in code points', () => {
  assert.equal(capText('abcdefgh', 5), 'abcde');
  assert.equal(capText('x'.repeat(LIMITS.message + 500), LIMITS.message).length, LIMITS.message);
});

test('never splits a grapheme: emoji sequences and accents stay whole or go entirely', () => {
  assert.equal(capText(`abc${FAMILY}`, 6), 'abc'); // the family would need 5 more code points
  assert.equal(capText(`a${FAMILY}b`, 6), `a${FAMILY}`);
  assert.equal(capText(`${THUMB}${THUMB}`, 3), THUMB); // not 👍🏽 + a bare 👍
  assert.equal(capText('e\u0301e\u0301e\u0301', 5), 'e\u0301e\u0301'); // é as e + combining accent
  assert.equal(capText(`${'a'.repeat(998)}${FAMILY}`, 1000), 'a'.repeat(998));
});

test('stays fast on huge input', () => {
  const huge = 'a'.repeat(50_000_000);
  const started = performance.now();
  assert.equal(capText(huge, LIMITS.message).length, LIMITS.message);
  assert.ok(performance.now() - started < 200, 'only the start of the text is examined');
});
