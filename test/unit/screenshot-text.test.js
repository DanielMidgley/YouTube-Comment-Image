import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inkWidth, knows } from '../../src/screenshot/metrics.js';
import { cleanMessage, cleanName } from '../../src/screenshot/text.js';
import { fitToWidth } from '../../src/screenshot/widths.js';

test('names: handles lose spaces and stray marks, display names keep their spaces', () => {
  assert.equal(cleanName('©mia_watches'), '@mia_watches'); // Tesseract's usual misreading of the @
  assert.equal(cleanName('(@night.owl'), '@night.owl');
  assert.equal(cleanName('@lofi girl 24'), '@lofigirl24'); // handles have no spaces
  assert.equal(cleanName('@a|ex'), '@alex'); // nor pipes: that was an l
  assert.equal(cleanName('@sam-k,'), '@sam-k');
  assert.equal(cleanName('  Ines   Marlow  '), 'Ines Marlow');
});

test('messages: single spaces; quotes stay as read (glyphs.js tells straight from curly)', () => {
  const curly = (code) => String.fromCharCode(code);
  assert.equal(cleanMessage('  a   b\tc  '), 'a b c');
  assert.equal(cleanMessage(`can${curly(0x2019)}t`), `can${curly(0x2019)}t`);
});

test('widths match how Chromium lays out Roboto (measured on the app\'s renders, which match YouTube\'s)', () => {
  // The names' ink at 1x: 220, 115, 72 and 149 px (antialiasing adds about 1 px).
  assert.ok(Math.abs(inkWidth('@MarloweFinchTheNightShiftCrew', 500) + 1 - 220) <= 1.5);
  assert.ok(Math.abs(inkWidth('@quietharbor4471', 500) + 1 - 115) <= 1.5);
  assert.ok(Math.abs(inkWidth('@NovaVVV', 500) + 1 - 72) <= 1.5);
  assert.ok(Math.abs(inkWidth('Ines Marlow Vandertuin', 500) + 1 - 149) <= 1.5);
  assert.ok(inkWidth('WAV', 400) < inkWidth('W', 400) + inkWidth('A', 400) + inkWidth('V', 400), 'kerning tightens AV');
  assert.equal(knows('plain text', 400), true);
  assert.equal(knows('日本', 400), false);
});

test('a reading of the wrong width is respelt where OCR is known to stumble', () => {
  const at = (text, scale, weight = 500) => inkWidth(text, weight) * scale + 1; // measured width of `text` at `scale`
  assert.deepEqual(fitToWidth('@NovaVWV', at('@NovaVVV', 1), { scale: 1, weight: 500 }), { text: '@NovaVVV', fits: true, guessed: false });
  assert.deepEqual(fitToWidth('@NovaVVVV', at('@NovaVVV', 2), { scale: 2, weight: 500 }), { text: '@NovaVVV', fits: true, guessed: false });
  assert.deepEqual(fitToWidth('LETS GOOOO', inkWidth('LETS GOOOOO') * 1.5 + 1, { scale: 1.5 }), { text: 'LETS GOOOOO', fits: true, guessed: true });
  assert.deepEqual(fitToWidth('cloes', inkWidth('does') + 1, { scale: 1 }), { text: 'does', fits: true, guessed: true });
  assert.deepEqual(fitToWidth('fine', inkWidth('fine') + 1, { scale: 1 }), { text: 'fine', fits: true, guessed: false });
  assert.deepEqual(fitToWidth('fine', 200, { scale: 1 }), { text: 'fine', fits: false, guessed: false }, 'nothing explains the width');
  assert.deepEqual(fitToWidth('日本', 40, { scale: 1 }), { text: '日本', fits: null, guessed: false }, 'no metrics: no verdict');
});

test('generic respellings are marked as guesses, worth checking', () => {
  // A word whose trailing mark Tesseract dropped measures wider than it reads; whatever respelling explains that
  // is a guess.
  const fitted = fitToWidth('good', inkWidth('good!') * 1.25 + 1, { scale: 1.25 });
  assert.ok(fitted.text === 'good' ? fitted.fits === false : fitted.guessed, JSON.stringify(fitted));
});

test('emoticons whose eyes the OCR lost get them back, a colon before a semicolon', () => {
  const at = (text, scale) => inkWidth(text, 400) * scale + 1;
  assert.deepEqual(fitToWidth(')', at(':)', 2), { scale: 2 }), { text: ':)', fits: true, guessed: false });
  assert.deepEqual(fitToWidth(')...', at(':)...', 1), { scale: 1 }), { text: ':)...', fits: true, guessed: true });
  assert.deepEqual(fitToWidth('>', at('>:(', 1), { scale: 1 }), { text: '>:(', fits: true, guessed: true });
  // A lone bracket of its own width stays one, and a word is not taken for a face.
  assert.deepEqual(fitToWidth(')', at(')', 1), { scale: 1 }), { text: ')', fits: true, guessed: false });
  for (const word of ['please', 'Pizza', 'Dang', 'party', '3am', 'Done']) {
    assert.ok(!fitToWidth(word, at(`${word}!`, 1.25), { scale: 1.25 }).text.startsWith(':'), word);
  }
});

test('alternatives: the one Tesseract rated higher wins, and none that the width cannot tell apart', () => {
  const at = (text, scale) => inkWidth(text, 400) * scale + 1;
  // "3)" for ":)", with : then ; among the alternatives for the 3 (as wide as each other).
  assert.deepEqual(fitToWidth('3)', at(':)', 1), { scale: 1, alternatives: [[':', '2', ';'], []] }), { text: ':)', fits: true, guessed: false });
  // A $ and a 3 are about as wide: a reading a little too wide keeps its $ though "963" would just fit (it
  // would be under half a pixel closer).
  const measured = at('96$', 2) - 1.4;
  assert.ok(Math.abs(at('963', 2) - measured) <= 1 + 0.005 * measured, '963 fits');
  assert.equal(fitToWidth('96$', measured, { scale: 2, alternatives: [[], [], ['S', '3']] }).text, '96$');
});
