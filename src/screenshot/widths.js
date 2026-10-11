// Checks OCR text against the width it takes up in the screenshot. Chromium lays Roboto out predictably
// (metrics.js gets within a pixel of what YouTube draws), so text of the wrong width was misread. Candidate
// spellings come from Tesseract's own alternatives for each character (it often ranks the right one second:
// ":" behind "3" in ":)", "t" behind "1") and from the misreadings OCR is known for: zigzags of V and W split
// or merged differently (VVV read as VWV, w as vv), a run of one repeated letter miscounted (GOOOO), cl read as
// d and back, an ellipsis (phones type one for three dots) read as three full stops and back, 0 and O swapped,
// a stray mark at a word's edge, a doubled ! or ? read once, the eyes of an emoticon (a colon is two dots of a
// pixel or two at 1x) lost. Those generic ones are tried only on readings that are clearly the wrong width.
import { inkWidth, knows } from './metrics.js';

const MAX_RUN = 8; // longer V/W runs are left alone (the candidates would multiply)
const MIN_GAIN = 0.5; // device px
const EDGE_JUNK = /^[([{|'"`,.]$/u;

/**
 * Checks `text` against `measured` (device px of ink): resolves to { text, fits, guessed }, with the candidate
 * spelling closest to `text` whose width matches when `text` itself does not, and fits false when nothing
 * explains the width (null when it can't be predicted: characters the metrics lack). guessed is true when the
 * spelling is one of the generic misreadings rather than Tesseract's own alternatives: the width matches, but
 * a dropped mark or a neighbour's ink can make a wrong respelling match too, so it is worth checking.
 * `scale` is device px per CSS px; `weight` and `size` the Roboto used; `alternatives`, if given, lists for
 * each character of `text` the other characters Tesseract considered there.
 */
export function fitToWidth(text, measured, { scale, weight = 400, size = 14, alternatives = [] }) {
  if (!text || !knows(text, weight)) return { text, fits: null, guessed: false };
  // Antialiasing adds about a device pixel of faint ink to the text's extent. Words measure within a pixel
  // of the prediction; a respelling must match that closely, and be MIN_GAIN closer than the reading (a $ and
  // a 3, a colon and a semicolon are about as wide: the width can't choose between them). Only a reading off
  // by twice as much is reported as doubtful.
  const error = (t) => Math.abs(inkWidth(t, weight, size) * scale + 1 - measured);
  const tolerance = 1 + 0.005 * measured;
  if (error(text) <= tolerance) return { text, fits: true, guessed: false };
  // Tesseract's own alternatives may settle a reading that is a little off; the generic misreadings only one
  // that is clearly wrong (a word can measure a pixel or so off when its edge falls between pixels).
  const clearlyWrong = error(text) > 2 * tolerance;
  let best = null;
  for (const { text: candidate, cost, generic } of candidates(text, alternatives, scale)) {
    if (generic && !clearlyWrong) continue;
    if (candidate === text || !knows(candidate, weight) || error(candidate) > tolerance || error(text) - error(candidate) < MIN_GAIN) continue;
    if (!best || cost < best.cost || (cost === best.cost && error(candidate) < best.error)) {
      best = { text: candidate, cost, error: error(candidate), generic: Boolean(generic) };
    }
  }
  return best ? { text: best.text, fits: true, guessed: best.generic } : { text, fits: error(text) <= 2 * tolerance, guessed: false };
}

/**
 * Candidate spellings with a cost: one per changed character, Tesseract's own alternatives costing less
 * than the generic misreadings (and the ones it rated higher, listed first, less than the others).
 */
function* candidates(text, alternatives, scale) {
  const chars = [...text];
  // One or two characters replaced by Tesseract's alternatives for them.
  const options = chars.map((_, i) => (alternatives[i] ?? []).filter((alt) => alt && alt !== chars[i]));
  for (let i = 0; i < chars.length; i++) {
    for (const [ra, a] of options[i].entries()) {
      yield { text: replaced(chars, [[i, a]]), cost: 1 + rank(ra) };
      for (let j = i + 1; j < chars.length; j++) {
        for (const [rb, b] of options[j].entries()) yield { text: replaced(chars, [[i, a], [j, b]]), cost: 2 + rank(ra) + rank(rb) };
      }
    }
  }
  const generic = (spelled, edits) => ({ text: spelled, cost: edits + 0.5, generic: true });
  // (Zigzag runs are respelt whenever the width is off: Tesseract stumbles on them constantly.)
  for (const { index, 0: run } of text.matchAll(/[VWvw]{2,}/g)) {
    if (run.length > MAX_RUN) continue;
    // The run's case is settled already (glyphs.js measures its height); only its spelling is in doubt.
    const [v, w] = run === run.toUpperCase() ? ['V', 'W'] : ['v', 'w'];
    for (let length = Math.max(1, run.length - 2); length <= run.length + 1; length++) {
      for (let bits = 0; bits < 2 ** length; bits++) {
        let spelled = '';
        for (let i = 0; i < length; i++) spelled += bits & (1 << i) ? w : v;
        yield { text: text.slice(0, index) + spelled + text.slice(index + run.length), cost: Math.abs(length - run.length) + 1.5 };
      }
    }
  }
  // Runs of one letter (or a ! or ?) miscounted, one or two of them in the word (zigzags have their own
  // candidates, above).
  const runs = [...text.matchAll(/(.)\1+|[!?]/gu)].filter(({ 0: run }) => !/[VWvw]/.test(run))
    .map(({ index, 0: run }) => ({ index, run, char: [...run][0], count: [...run].length }));
  const counts = ({ count }) => [-2, -1, 1, 2].map((d) => count + d).filter((n) => n >= 1);
  const respelt = (edits) => {
    let spelled = text;
    for (const { index, run, char, n } of [...edits].sort((a, b) => b.index - a.index)) spelled = spelled.slice(0, index) + char.repeat(n) + spelled.slice(index + run.length);
    return spelled;
  };
  for (const [i, a] of runs.entries()) {
    for (const n of counts(a)) {
      yield generic(respelt([{ ...a, n }]), Math.abs(n - a.count));
      for (const b of runs.slice(i + 1)) {
        for (const m of counts(b)) yield generic(respelt([{ ...a, n }, { ...b, n: m }]), Math.abs(n - a.count) + Math.abs(m - b.count));
      }
    }
  }
  // An ellipsis is 1.5px narrower than three full stops: telling them apart needs 1.5x or more.
  const dots = (spelled) => (scale >= 1.5 ? { text: spelled, cost: 1.5 } : generic(spelled, 1));
  for (const { index } of text.matchAll(/\.\.\./g)) yield dots(`${text.slice(0, index)}\u2026${text.slice(index + 3)}`);
  for (const { index } of text.matchAll(/\u2026/g)) yield dots(`${text.slice(0, index)}...${text.slice(index + 1)}`);
  for (const { index } of text.matchAll(/d/g)) yield generic(`${text.slice(0, index)}cl${text.slice(index + 1)}`, 1);
  for (const { index } of text.matchAll(/cl/g)) yield generic(`${text.slice(0, index)}d${text.slice(index + 2)}`, 1);
  // (An o differs from both in height, which glyphs.js measures.)
  for (const { index, 0: c } of text.matchAll(/[0O]/g)) yield generic(`${text.slice(0, index)}${c === '0' ? 'O' : '0'}${text.slice(index + 1)}`, 1);
  // :) ;) :( :D :P :/ :| :3 >:( read without their eyes (a colon rather than a semicolon: they are as wide), or
  // >:( as > alone. A lone ) or D too wide for itself is most likely a face, before anything Tesseract offers.
  const face = text.match(/^(>?)[)(DPp/|3][.!?\u2026]*$/u);
  if (face) {
    for (const [eyes, more] of [[':', 0], [';', 0.25]]) {
      const spelled = `${face[1]}${eyes}${text.slice(face[1].length)}`;
      yield chars.length === 1 ? { text: spelled, cost: 0.9 + more } : generic(spelled, 1 + more);
    }
  }
  if (text === '>') for (const [rest, more] of [[':(', 0], [':)', 0.1]]) yield generic(`>${rest}`, 2 + more);
  if (chars.length > 1 && EDGE_JUNK.test(chars[0])) yield generic(chars.slice(1).join(''), 1);
  if (chars.length > 1 && EDGE_JUNK.test(chars.at(-1))) yield generic(chars.slice(0, -1).join(''), 1);
}

/** What an alternative costs for being further down Tesseract's list: always less than a generic edit. */
const rank = (index) => 0.1 * Math.min(index, 4);

function replaced(chars, edits) {
  const out = [...chars];
  for (const [i, c] of edits) out[i] = c;
  return out.join('');
}
