// Reads the author name and the message of a YouTube live-chat comment from a screenshot. layout.js finds
// where everything is; each text region is cut out, turned into black-on-white grey and enlarged to the size
// OCR reads best, then read by `recognize` (Tesseract: ocr.js in the app, test/support/node-recognizer.js in
// tests). Emoji are images, named by emoji-match.js first, and their cells kept out of the text. Spaces come
// from the screenshot rather than from the OCR (respace below), and every word is checked against its width
// there (widths.js).
import { analyzeScreenshot } from './layout.js';
import { matchEmoji } from './emoji-match.js';
import { correctWords } from './glyphs.js';
import { bearings, inkGap, inkPositions, inkWidth, knows } from './metrics.js';
import { cleanMessage, cleanName } from './text.js';
import { fitToWidth } from './widths.js';

const X_HEIGHT = 7.4; // CSS px, Roboto 14px
const TARGET_X_HEIGHT = 24; // device px of x-height in the images given to the OCR
const PADDING = 12; // white margin around them (device px)
const EMOJI_MARGIN = 2; // CSS px each side of an emoji
const SPACE = 3.5; // CSS px, a space in Roboto 14px
const SCALE_DOUBT = 0.025; // how far the words' widths may put the scale from the layout's before a second read
const MAX_PLACEMENT_ERROR = 2.5; // CSS px: how far a gap inside a word may be from where Roboto puts one
const HANDLE_CHAR = /^[\p{L}\p{M}\p{N}_.\-·|]$/u; // | is an l (see cleanName)
const INK = 40; // as in layout.js
const FAINT = 8; // a pixel this far from the background is ink of some sort
const NOISY = 0.02; // stray faint pixels per pixel of ink that make a region a JPEG's (a PNG has none)
const JPEG_INK = 0.28; // of the ink's strength: what counts as ink in a JPEG

/**
 * Reads the comment in `image` ({ width, height, data } RGBA). `recognize(grey, { mode })` reads one line of
 * text from a { width, height, data } image with one byte per pixel (0 ink, 255 paper) and resolves to
 * { text, confidence (0-100), words } (see src/screenshot/ocr.js). Resolves to
 *   { name, message, doubtful, theme, role, verified, scale, confidence, warnings }
 * where doubtful lists the words whose width on the screenshot no reading explained (worth checking),
 * confidence is the lowest OCR confidence (0-100) and warnings are sentences for the user (emoji that could
 * not be named, other comments in the image). Rejects with a readable Error when the image does not look
 * like a chat comment.
 */
export async function readComment(image, { recognize, signal } = {}) {
  const first = await readLayout(image, analyzeScreenshot(image), { recognize, signal });
  // The scale comes from the layout's measures, which browser zoom (110%, 90%...) or a resized screenshot
  // can throw off by a few percent, enough to make right words look the wrong width. The words read say what it
  // is: when their widths agree on another scale, read again at that one, and keep the reading that leaves
  // fewer words in doubt.
  const measured = first.measuredScale;
  if (!(measured && Math.abs(measured / first.scale - 1) > SCALE_DOUBT)) return finish(first);
  let second;
  try {
    second = await readLayout(image, analyzeScreenshot(image, { scale: measured }), { recognize, signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    return finish(first);
  }
  // The second reading is kept only if it leaves fewer words in doubt, finds a name and a message wherever the
  // first did, and its own words agree with the scale it was read at.
  const sound = second.doubtful.length < first.doubtful.length && (second.name || !first.name) && (second.message || !first.message)
    && second.measuredScale && Math.abs(second.measuredScale / second.scale - 1) <= SCALE_DOUBT / 2;
  return finish(sound ? second : first);
}

const finish = ({ measuredScale, ...result }) => ({ ...result, scale: Math.round(result.scale * 100) / 100 });

/** Reads the target comment of `layout` (see readComment); also gives the scale the words' widths show. */
async function readLayout(image, layout, { recognize, signal }) {
  const comment = layout.comments[layout.target];
  const { scale } = layout;
  const warnings = [];
  const confidences = [];
  const doubtful = [];
  const heights = { capitals: [], ascenders: [] }; // of letters measured so far (see glyphs.js)
  const ratios = []; // device px of ink per CSS px Roboto gives the words read, word by word

  // Emoji first: their 24px cells (as the matcher finds them) hold bits the layout may have taken for text.
  // An owner's chip can reach into the cell of an emoji on the next line: the matcher sees it as background.
  let unknownEmoji = 0;
  const cells = [];
  const matched = new Map();
  let withoutChip = null;
  for (const line of comment.lines) {
    for (const item of line.items) {
      if (item.type !== 'emoji') continue;
      const nearChip = comment.chip && overlapArea(grow(item.box, 4 * scale), comment.chip) > 0;
      if (nearChip) withoutChip ??= paintOver(image, comment.chip, layout.background);
      const match = matchEmoji(nearChip ? withoutChip : image, { box: item.box, scale, background: layout.background });
      matched.set(item, match);
      if (match) cells.push(match.box);
      else unknownEmoji++;
    }
  }

  // Reads one text region: its text, and the columns its words' ink spans (null when the OCR gave no words).
  const read = async (region, crop, kind) => {
    signal?.throwIfAborted();
    const masks = cells.filter((c) => overlapArea(c, crop) > 0);
    const result = await recognize(ocrImage(image, region, crop, scale, masks), { mode: 'line' });
    confidences.push(result.confidence);
    if (!result.words?.length) return { text: result.text.trim(), ink: null };
    const weight = kind === 'name' ? 500 : 400;
    if (kind === 'message') result.words = withMissedBars(result.words, { image, region, crop, masks, scale });
    let ocrWords = correctWords(result, { image, region, crop, factor: ocrFactor(scale), padding: PADDING, scale, heights }, kind);
    // A handle holds only letters, digits and _ - . · after its @: anything else Tesseract read in one is a
    // misreading, and would only throw out the width check (cleanName drops it in the end anyway).
    const at = ocrWords[0]?.chars.findIndex((c) => /^[@©®]$/u.test(c.text)) ?? -1;
    if (kind === 'name' && at >= 0 && ocrWords[0].chars.slice(0, at).every((c) => /^[\s([{|'"`]$/u.test(c.text))) {
      // (A stray bracket or quote before the @ goes too.)
      ocrWords = ocrWords.map((word, k) => ({ ...word, chars: word.chars.filter((c, i) => (k === 0 ? i >= at && (i === at || HANDLE_CHAR.test(c.text)) : HANDLE_CHAR.test(c.text))) }));
    }
    const words = respace(ocrWords, { image, region, crop, masks, scale, weight });
    // A word of one l in a message is the pronoun I (Tesseract can read "so do I" as "sodol").
    if (kind === 'message') for (const word of words) if (word.chars.length === 1 && word.chars[0].text === 'l') word.chars = [{ text: 'I', alternatives: [] }];
    const text = words.map((word) => {
      const spelt = word.chars.map((c) => c.text).join('');
      if ([...spelt].length >= 3 && knows(spelt, weight)) ratios.push((word.right - word.left - 1) / inkWidth(spelt, weight));
      const fitted = fitToWidth(spelt, word.right - word.left, { scale, weight, alternatives: word.chars.map((c) => c.alternatives) });
      if (fitted.fits === false || fitted.guessed) doubtful.push(fitted.text);
      return fitted.text;
    }).join(' ');
    return { text, ink: words.length ? { left: Math.min(...words.map((w) => w.left)), right: Math.max(...words.map((w) => w.right)) } : null };
  };

  const header = [comment.timestamp?.box, comment.chip, comment.name?.box, ...comment.badges].filter(Boolean);
  const firstItem = comment.lines[0]?.items[0]?.box;
  const name = comment.name
    ? cleanName((await read(comment.name, cropBox(image, comment.name.box, scale, neighbours(comment.name.box, [...header, firstItem])), 'name')).text)
    : '';

  const lines = [];
  for (const line of comment.lines) {
    const pieces = [];
    for (const [index, item] of line.items.entries()) {
      if (item.type === 'emoji') {
        const match = matched.get(item);
        if (match) pieces.push({ type: 'emoji', text: match.emoji, box: match.box });
        continue;
      }
      // Text that lies in an emoji's cell is a piece of the emoji.
      if (cells.reduce((sum, c) => sum + overlapArea(c, item.box), 0) >= 0.6 * item.box.width * item.box.height) continue;
      const others = [...line.items.filter((_, i) => i !== index).map((i) => i.box), ...cells];
      if (line === comment.lines[0]) others.push(...header);
      const { text, ink } = await read(item, cropBox(image, item.box, scale, neighbours(item.box, others)), 'message');
      // (The item's box can take in the faint edge of a white emoji beside it; the words' ink cannot.)
      if (text) pieces.push({ type: 'text', text, box: ink ? { ...item.box, x: ink.left, width: ink.right - ink.left } : item.box });
    }
    if (pieces.length) lines.push({ pieces, box: line.box });
  }
  if (unknownEmoji) warnings.push(unknownEmoji === 1 ? "One emoji couldn't be recognised." : `${unknownEmoji} emoji couldn't be recognised.`);
  if (comment.cut) warnings.push('The comment looks cut off by the edge of the screenshot, so the name or message may be incomplete.');
  if (layout.comments.length > 1) warnings.push(`The screenshot shows ${layout.comments.length} comments; this is the ${ordinal(layout.target + 1)}.`);

  return {
    name,
    message: cleanMessage(joinLines(lines, scale, Math.min(...header.map((b) => b.x), ...comment.lines.map((l) => l.box.x)))),
    doubtful,
    theme: layout.theme,
    role: comment.style.role,
    verified: comment.style.verified,
    scale,
    confidence: confidences.length ? Math.min(...confidences) : 0,
    warnings,
    // Trusted from enough words only (four or more), as their median, and only if most agree with it.
    measuredScale: trusted(ratios),
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The scale the words' widths show: their median, when at least four words, most within 3% of it, say so. */
function trusted(ratios) {
  if (ratios.length < 4) return null;
  const m = median(ratios);
  const close = ratios.filter((r) => Math.abs(r / m - 1) <= 0.03).length;
  return close >= 0.6 * ratios.length ? m : null;
}

const ordinal = (n) => (n === 1 ? 'first' : n === 2 ? 'second' : n === 3 ? 'third' : `${n}th`);

const overlapArea = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

const grow = (b, d) => ({ x: b.x - d, y: b.y - d, width: b.width + 2 * d, height: b.height + 2 * d });

/** A copy of `image` with the grey pixels in `box` (a chip, not the coloured edge of an emoji) as `background`. */
function paintOver(image, box, background) {
  const data = new Uint8ClampedArray(image.data);
  for (let y = Math.max(0, box.y); y < Math.min(image.height, box.y + box.height); y++) {
    for (let x = Math.max(0, box.x); x < Math.min(image.width, box.x + box.width); x++) {
      const i = (y * image.width + x) * 4;
      if (Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) < 60) data.set(background.slice(0, 3), i);
    }
  }
  return { width: image.width, height: image.height, data };
}

// ---- Spacing ---------------------------------------------------------------------------------------------

/**
 * The OCR's words with their spaces settled on the screenshot, as [{ chars, left, right }] (left and right:
 * the word's ink, device px). Between two of Tesseract's words, the empty run where they part is the one where
 * Roboto's widths say the first one's ink ends (counted from where it starts) and Tesseract says the second's
 * starts; a space is there when that run is wider, by half a space or more, than Roboto leaves between those
 * two characters (side bearings make a 1 or a colon stand as far from its neighbours as tight letters with a
 * space between). So "fora" splits and "@ Turnip" and "$1 1" join. Inside one of Tesseract's words, each empty
 * run goes to the character boundary, with or without a space there, that best explains where it starts and
 * ends.
 */
function respace(ocrWords, { image, region, crop, masks, scale, weight }) {
  const empty = emptyColumns(image, region, crop, masks);
  const isEmpty = (x) => x < crop.x || x >= crop.x + crop.width || empty[x - crop.x];
  const firstInk = (from, to) => {
    for (let x = Math.max(crop.x, from); x < Math.min(crop.x + crop.width, to); x++) if (!isEmpty(x)) return x;
    return -1;
  };
  const lastInk = (from, to) => {
    for (let x = Math.min(crop.x + crop.width, to) - 1; x >= Math.max(crop.x, from); x--) if (!isEmpty(x)) return x;
    return -1;
  };
  const emptyRuns = (from, to) => {
    const found = [];
    for (let x = Math.ceil(from); x < Math.floor(to); x++) {
      if (!isEmpty(x)) continue;
      let end = x;
      while (end < Math.floor(to) && isEmpty(end)) end++;
      found.push({ start: x, end });
      x = end;
    }
    return found;
  };
  const spaceFits = (gap, a, b) => gap + 1 >= (inkGap(a, b, weight) + SPACE / 2) * scale; // antialiasing eats ~1px

  const ocr = ocrWords.filter((w) => w.chars.length);
  const words = [];
  let left = ocr.length ? firstInk(Math.floor(ocr[0].left) - 2, Math.ceil(ocr[0].right) + 2) : -1;
  let before = null;
  ocr.forEach((word, k) => {
    const texts = word.chars.map((c) => c.text);
    const next = ocr[k + 1];
    let after = null;
    if (next) {
      // The ink measures about a pixel wider than Roboto's outlines (antialiasing). When Tesseract's boxes
      // overlap (one can span the whole line), the next box's left edge says nothing and the run is looked for
      // around where this word's ink should end.
      const predicted = left >= 0 ? left + inkWidth(texts.join(''), weight) * scale + 1 : word.right;
      const overlapping = word.right > next.left + 2 * scale;
      const from = Math.max(left + 1, Math.min((word.left + word.right) / 2, predicted - 2 * scale));
      const to = Math.min(Math.max(next.right, predicted + 1), Math.max((next.left + next.right) / 2, predicted + (SPACE + 3) * scale));
      let best = Infinity;
      for (const run of emptyRuns(from, to)) {
        const cost = Math.abs(run.start - predicted) + (overlapping ? 0 : Math.abs(run.end - next.left)) - (run.end - run.start);
        if (cost < best) {
          best = cost;
          after = run;
        }
      }
    }
    let right = after ? after.start : next ? Math.round((word.right + next.left) / 2) : lastInk(Math.floor(word.left) - 2, Math.ceil(word.right) + 2) + 1;
    if (left < 0 || right <= left) {
      left = Math.round(word.left);
      right = Math.round(word.right);
    }

    // Empty runs inside the word: each at the boundary that puts the ink on either side where Roboto's widths
    // say (with a space there if the run is a space's), counted from the last run placed so that errors don't
    // add up. Runs nothing explains (inside a ", say) are left alone.
    const positions = inkPositions(texts, weight);
    const pieces = [];
    let pieceFrom = 0;
    let pieceLeft = left;
    let from = 0;
    let anchor = left; // where the ink of character `from` starts
    for (const run of emptyRuns(left + 1, right - 1)) {
      let best = null;
      for (let i = from; i + 1 < texts.length; i++) {
        const space = spaceFits(run.end - run.start, texts[i], texts[i + 1]) ? 1 : 0;
        const inkEnds = anchor + (positions[i].right - positions[from].left) * scale + 1;
        const inkStarts = anchor + (positions[i + 1].left - positions[from].left + space * SPACE) * scale;
        const error = (Math.abs(run.start - inkEnds) + Math.abs(run.end - inkStarts)) / scale;
        if (!best || error < best.error) best = { i, space, error };
      }
      // (Along a long run of letters with no gaps between them, such as HAHAHAHA, where letters fall can drift
      // further from Roboto's widths than a gap's place is allowed to be: a gap clearly as wide as a space is
      // a space all the same.)
      const clearSpace = best?.space && run.end - run.start + 1 >= (SPACE + 0.5) * scale && best.error <= 3 * MAX_PLACEMENT_ERROR;
      if (!best || (best.error > MAX_PLACEMENT_ERROR && !clearSpace)) continue;
      if (best.space) {
        pieces.push({ chars: word.chars.slice(pieceFrom, best.i + 1), left: pieceLeft, right: run.start });
        pieceFrom = best.i + 1;
        pieceLeft = run.end;
      }
      from = best.i + 1;
      anchor = run.end;
    }
    pieces.push({ chars: word.chars.slice(pieceFrom), left: pieceLeft, right });

    // Tesseract's break before this word: a space only if the gap is a space's.
    pieces.forEach((piece, i) => {
      const last = words.at(-1);
      if (i === 0 && last && !spaceFits(before ? before.end - before.start : 0, last.chars.at(-1).text, piece.chars[0].text)) {
        last.chars.push(...piece.chars);
        last.right = piece.right;
      } else if (piece.chars.length) words.push({ chars: [...piece.chars], left: piece.left, right: piece.right });
    });
    left = after ? after.end : right;
    before = after;
  });
  return words;
}

/**
 * Tesseract's words with any lone vertical bar it left out put back: a capital I on its own ("can I join")
 * is a single stroke that the OCR sometimes skips. Between two words it read, a run of ink no wider than an I
 * that stands on the baseline, reaches the cap height and has a space's gap on either side becomes a word
 * of one '|', which glyphs.js then measures (I, l or a pipe). Boxes are in the OCR image's pixels.
 */
function withMissedBars(words, { image, region, crop, masks, scale }) {
  const factor = ocrFactor(scale);
  const toImage = (x) => crop.x + (x - PADDING) / factor;
  const toOcr = (x) => (x - crop.x) * factor + PADDING;
  const empty = emptyColumns(image, region, crop, masks);
  const isEmpty = (x) => x < crop.x || x >= crop.x + crop.width || empty[x - crop.x];
  const sorted = [...words].sort((a, b) => a.box.x - b.box.x);
  const added = [];
  for (let k = 0; k + 1 < sorted.length; k++) {
    const from = Math.ceil(toImage(sorted[k].box.x + sorted[k].box.width));
    const to = Math.floor(toImage(sorted[k + 1].box.x));
    for (let x = from; x < to; x++) {
      if (isEmpty(x)) continue;
      let end = x;
      while (end < to && !isEmpty(end)) end++;
      let gapBefore = 0;
      while (isEmpty(x - 1 - gapBefore) && gapBefore < 20 * scale) gapBefore++;
      let gapAfter = 0;
      while (isEmpty(end + gapAfter) && gapAfter < 20 * scale) gapAfter++;
      // (Tesseract's box for a word it did read can sit a few pixels off its ink: nothing near one is missed.)
      const near = sorted.some((w) => toImage(w.box.x) - 3 * scale < end && toImage(w.box.x + w.box.width) + 3 * scale > x);
      const bar = !near && end - x <= 1.6 * scale + 2.5 && Math.min(gapBefore, gapAfter) + 1 >= (SPACE - 0.5) * scale
        && standsTall(image, region, x, end, scale);
      if (bar) {
        const box = { x: toOcr(x), y: sorted[k].box.y, width: (end - x) * factor, height: sorted[k].box.height };
        added.push({ text: '|', confidence: 0, box, symbols: [{ text: '|', confidence: 0, box, choices: [] }] });
      }
      x = end;
    }
  }
  return added.length ? [...words, ...added].sort((a, b) => a.box.x - b.box.x) : words;
}

/** Whether the ink in columns [x0, x1) runs from the baseline up to the cap height or more, unbroken. */
function standsTall(image, region, x0, x1, scale) {
  const { data, width } = image;
  const [br, bg, bb] = region.background;
  const inked = (y) => {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      if (Math.max(Math.abs(data[i] - br), Math.abs(data[i + 1] - bg), Math.abs(data[i + 2] - bb)) >= INK) return true;
    }
    return false;
  };
  const base = Math.round(region.baseline);
  if (!inked(base - 1)) return false;
  let top = base - 1;
  while (top > 0 && inked(top - 1)) top--;
  return base - top >= 9 * scale;
}

/**
 * For each column of `crop`: whether it is empty in the region's rows (no channel INK or more from the
 * region's background), with masked boxes (emoji cells) and anything outside an owner chip counting as empty.
 * A JPEG rings around letters, faintly but often more than INK, so where faint ink strays from the letters
 * (NOISY: pixels not next to ink, per pixel of ink; a PNG has none) only JPEG_INK of the ink's strength counts.
 */
function emptyColumns(image, region, crop, masks) {
  const { data, width } = image;
  const [br, bg, bb] = region.background;
  const top = Math.max(crop.y, region.box.y);
  const bottom = Math.min(crop.y + crop.height, region.box.y + region.box.height);
  const w = crop.width;
  const h = Math.max(0, bottom - top);
  const deviation = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = crop.x + x;
      const py = top + y;
      if (masks.some((m) => px >= m.x && px < m.x + m.width && py >= m.y && py < m.y + m.height)) continue;
      if (region.clip && !insideRoundedBox(px + 0.5, py + 0.5, region.clip)) continue;
      const i = (py * width + px) * 4;
      deviation[y * w + x] = Math.max(Math.abs(data[i] - br), Math.abs(data[i + 1] - bg), Math.abs(data[i + 2] - bb));
    }
  }
  let inked = 0;
  let stray = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = deviation[y * w + x];
      if (d >= INK) inked++;
      else if (d >= FAINT && !nextToInk(deviation, w, h, x, y)) stray++;
    }
  }
  const strength = Math.max(...region.ink.map((c, k) => Math.abs(c - region.background[k])));
  const threshold = stray >= NOISY * inked ? Math.max(INK, JPEG_INK * strength) : INK;
  const empty = new Uint8Array(w);
  for (let x = 0; x < w; x++) {
    let blank = 1;
    for (let y = 0; y < h && blank; y++) if (deviation[y * w + x] >= threshold) blank = 0;
    empty[x] = blank;
  }
  return empty;
}

function nextToInk(deviation, w, h, x, y) {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx;
      const yy = y + dy;
      if (xx >= 0 && xx < w && yy >= 0 && yy < h && deviation[yy * w + xx] >= INK) return true;
    }
  }
  return false;
}

/**
 * The message text: pieces of a line joined with a space where the gap between them holds one (emoji are
 * EMOJI_MARGIN from their neighbours, a space adds SPACE). Lines are joined with the space the line broke at,
 * except
 *  - after a word broken mid-way because it was wider than the line (alone on its line, which it fills from
 *    the text column's left edge, `textLeft`),
 *  - after a dash at the end of a word (Chromium breaks after one; not before a number),
 *  - between two emoji, when the emoji side by side elsewhere in the message have no space between them
 *    (a line can break between images without one).
 */
function joinLines(lines, scale, textLeft) {
  const rightmost = Math.max(...lines.map((l) => l.box.x + l.box.width));
  let spacedEmoji = 0;
  let tightEmoji = 0;
  for (const { pieces } of lines) {
    pieces.forEach((piece, i) => {
      if (i === 0 || piece.type !== 'emoji' || pieces[i - 1].type !== 'emoji') return;
      if (spaced(pieces[i - 1], piece, scale)) spacedEmoji++;
      else tightEmoji++;
    });
  }
  let text = '';
  lines.forEach((line, index) => {
    if (index > 0) {
      const previous = lines[index - 1];
      const last = previous.pieces.at(-1);
      const first = line.pieces[0];
      const brokenWord = previous.pieces.length === 1 && last.type === 'text' && !/\s/.test(last.text)
        && previous.box.x <= textLeft + 2 * scale && previous.box.x + previous.box.width >= rightmost - 10 * scale;
      const dash = last.type === 'text' && first.type === 'text' && /[\p{L}\p{N}_][-\u2010\u2013\u2014]$/u.test(last.text) && !/^\p{N}/u.test(first.text);
      const emojiRun = last.type === 'emoji' && first.type === 'emoji' && spacedEmoji <= tightEmoji;
      text += brokenWord || dash || emojiRun ? '' : ' ';
    }
    line.pieces.forEach((piece, i) => {
      if (i > 0 && spaced(line.pieces[i - 1], piece, scale)) text += ' ';
      text += piece.text;
    });
  });
  return text;
}

/**
 * Whether a space separates two pieces of a line. Text runs are split only at emoji, so two text pieces in a
 * row were set apart by the layout's gaps and have one. Around an emoji (its 24px cell, as the matcher
 * finds it), the gap is EMOJI_MARGIN on its side and the letter's side bearing on the other (a 1's is
 * almost 3px), plus SPACE when there is a space.
 */
function spaced(a, b, scale) {
  if (a.type === 'text' && b.type === 'text') return true;
  const gap = (b.box.x - (a.box.x + a.box.width)) / scale;
  const side = (piece, end) => (piece.type === 'emoji' ? EMOJI_MARGIN : bearings(end === 'right' ? [...piece.text].at(-1) : [...piece.text][0])[end]);
  return gap > side(a, 'right') + side(b, 'left') + SPACE / 2;
}

// ---- OCR images ------------------------------------------------------------------------------------------

/** Boxes in `others` that share rows with `b`: what a crop around `b` must not reach into. */
function neighbours(b, others) {
  return others.filter((o) => o && o !== b && o.y < b.y + b.height && o.y + o.height > b.y);
}

/**
 * The region to cut out around a text box: a little margin, never more than halfway to a neighbour on the
 * same row (a badge, an emoji, the timestamp), and within the image.
 */
function cropBox(image, b, scale, others) {
  let left = b.x - Math.round(2 * scale);
  let right = b.x + b.width + Math.round(2 * scale);
  for (const o of others) {
    if (o.x + o.width <= b.x) left = Math.max(left, Math.ceil((o.x + o.width + b.x) / 2));
    else if (o.x >= b.x + b.width) right = Math.min(right, Math.floor((b.x + b.width + o.x) / 2));
  }
  const top = Math.max(0, b.y - Math.round(3 * scale));
  const bottom = Math.min(image.height, b.y + b.height + Math.round(3 * scale));
  left = Math.max(0, left);
  right = Math.min(image.width, right);
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

const luminance = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * The OCR's input for a text region: the `crop` of `image` as grey, black ink on white paper (by luminance
 * between the region's background and ink colours, which also undoes ClearType's colour fringes), enlarged
 * so the x-height is TARGET_X_HEIGHT, with a white margin. Pixels outside an owner chip's rounded corners
 * (region.clip) and inside `masks` (emoji cells) are paper.
 */
export function ocrImage(image, region, crop, scale, masks = []) {
  const { data, width } = image;
  const bg = luminance(...region.background);
  const range = Math.max(24, Math.abs(luminance(...region.ink) - bg));
  const source = new Float32Array(crop.width * crop.height);
  for (let y = 0; y < crop.height; y++) {
    for (let x = 0; x < crop.width; x++) {
      const i = ((crop.y + y) * width + crop.x + x) * 4;
      const ink = Math.min(1, Math.abs(luminance(data[i], data[i + 1], data[i + 2]) - bg) / range);
      const px = crop.x + x;
      const py = crop.y + y;
      const blank = (region.clip && !insideRoundedBox(px + 0.5, py + 0.5, region.clip))
        || masks.some((m) => px >= m.x && px < m.x + m.width && py >= m.y && py < m.y + m.height);
      source[y * crop.width + x] = blank ? 1 : 1 - ink;
    }
  }
  const factor = ocrFactor(scale);
  const w = Math.max(1, Math.round(crop.width * factor));
  const h = Math.max(1, Math.round(crop.height * factor));
  const resized = resize(source, crop.width, crop.height, w, h);
  const out = { width: w + 2 * PADDING, height: h + 2 * PADDING, data: new Uint8Array((w + 2 * PADDING) * (h + 2 * PADDING)).fill(255) };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out.data[(y + PADDING) * out.width + x + PADDING] = Math.max(0, Math.min(255, Math.round(resized[y * w + x] * 255)));
    }
  }
  return out;
}

/** How much a text crop is enlarged for the OCR. */
const ocrFactor = (scale) => Math.min(8, Math.max(0.5, TARGET_X_HEIGHT / (X_HEIGHT * scale)));

function insideRoundedBox(px, py, { box: b, radius }) {
  const cx = Math.min(Math.max(px, b.x + radius), b.x + b.width - radius);
  const cy = Math.min(Math.max(py, b.y + radius), b.y + b.height - radius);
  return (px - cx) ** 2 + (py - cy) ** 2 <= radius ** 2;
}

/** Separable Catmull-Rom (bicubic) resampling of a single-channel float image: rows first, then columns. */
function resize(source, sw, sh, dw, dh) {
  const rows = new Float32Array(dw * sh);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < dw; x++) {
      rows[y * dw + x] = cubicAt((k) => source[y * sw + clampIndex(k, sw)], ((x + 0.5) * sw) / dw - 0.5);
    }
  }
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      out[y * dw + x] = cubicAt((k) => rows[clampIndex(k, sh) * dw + x], ((y + 0.5) * sh) / dh - 0.5);
    }
  }
  return out;
}

const clampIndex = (k, n) => (k < 0 ? 0 : k >= n ? n - 1 : k);

function cubicAt(sample, position) {
  const i = Math.floor(position);
  const t = position - i;
  const p0 = sample(i - 1);
  const p1 = sample(i);
  const p2 = sample(i + 1);
  const p3 = sample(i + 2);
  const value = p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
  return Math.min(1, Math.max(0, value));
}
