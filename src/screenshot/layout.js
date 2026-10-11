// Finds the parts of a YouTube live-chat comment in a screenshot: the avatar, timestamp, author name, badges,
// emoji and the lines of the message. Pure pixel analysis (no DOM), so the editor and the Node tests run the
// same code; read.js then OCRs the text regions it returns and matches the emoji.
//
// It leans on how YouTube lays out a chat row (src/styles/youtube-chat.css), in CSS px times the screenshot's
// scale s: Roboto 14px text on 20px lines; a 24px round avatar 16px left of the text; an 11px timestamp 8px
// before the name; the name, then 16px badges, then 8px before the message; 24px emoji. The name stands apart
// from the message by colour (grey, blue or green), by a badge (verified authors) or by a filled chip
// (owners), and always by that 8px gap. Rows abut: a comment's lines are 20px apart, the next comment's first
// line about 30px below its last.
//
// At 1x, ClearType joins the letters of a word (often several words) into one blob of ink, and photo avatars
// on a dark chat break into dim fragments. So text is cut into lines and words by projecting ink onto rows
// and columns; connected components only set aside the big things first (emoji, letter avatars, owner chips).

const INK = 40; // a pixel is ink when a channel differs from the background by this much (of 255)

// Row geometry in CSS px.
const LINE_PITCH = 20;
const X_HEIGHT = 7.4; // Roboto's x-height (1082/2048 em) at 14px
const CAP_HEIGHT = 10; // Roboto's cap height (1456/2048 em) at 14px
const AVATAR = 24;
const AVATAR_GAP = 16;
const EMOJI = 24;
const NAME_GAP = 8; // after the timestamp, and between the name (with its badges) and the message
const BLOB = 16.5; // taller than any letter (13.5px at most) and than badges: emoji, avatars, owner chips
const CHIP = 21; // an owner's name chip: 14px text (Roboto's line is 16.4px) with 2px padding above and below
const NEW_COMMENT_PITCH = 25.5; // line to line: 20 within a comment (a little more beside emoji), ~30 between
// Device px per CSS px a chat screenshot can have: from 50% zoom on a 1x screen to a 2x screen at 250%, with
// room for the rough estimate's error (anything else measures 12 or more: text far too big to be chat).
const MIN_SCALE = 0.3;
const MAX_SCALE = 6;

const COMMON_SCALES = [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3, 3.5, 4];

/**
 * Analyses `image` ({ width, height, data } RGBA, e.g. ImageData or a pngjs PNG), at `scale` device px per CSS
 * px if that is known (read.js measures it from the text's widths), else as estimated. Returns
 * { theme, background, scale, comments, target }: target is the index of the comment to read (the first
 * complete one that has a name, one whose name is not doubtful if there is one) and each comment is
 *   { complete, cut, box, avatar, timestamp, name, doubtfulName, chip, badges, style, lines }
 * with boxes { x, y, width, height } in image pixels:
 *   timestamp, name: text regions { box, words, ink, background, baseline } (words: the boxes of its words,
 *     cut where the ink leaves a space; colours [r, g, b]; baseline: the image row the text sits on), or null;
 *     the name excludes badges (and is the text inside the chip for owners, with clip: { box, radius }, the
 *     chip's rounded outline); doubtfulName: true when the name is in the message's colour with no timestamp
 *     or badge to show it is one (more likely the last line of a comment cut off at the top);
 *   chip: the owner's filled name chip or null; badges: [box];
 *   style: { role, verified }, as far as colours and shapes tell;
 *   lines: the message, [{ box, baseline, items }] with items in reading order, each a text region
 *     { type: 'text', box, ink, background } or { type: 'emoji', box }. The first line holds only the message
 *     part of the comment's first line.
 * Throws an Error with a message meant for the user when nothing in the image looks like a chat comment.
 */
export function analyzeScreenshot(image, { scale: knownScale } = {}) {
  const { width, height } = image;
  if (!(width > 0 && height > 0)) throw new Error('The image is empty.');
  const background = findBackground(image);
  const page = new Page(image, background);
  const components = page.splitChips(page.findComponents());
  // Blobs (anything taller than text) are set aside before text is measured. Until the scale is known, that is
  // what is clearly taller than tall text components (letters with ascenders or descenders, or whole words
  // where ClearType joins letters, ~13px): owner chips and emoji are 20-24px. Then: taller than any letter.
  // Emoji are set aside first: tinted and much taller than the typical component, a letter or a word (text in
  // a message is never tinted, and a moderator's or member's tinted name is letter-sized: at most ~1.5 times
  // the typical letter or word). "Tall text" is measured without them. When emoji outnumber the letters (a few
  // after a short name), the typical size would be theirs: so the tallest tinted, squarish components, if
  // clearly bigger than the rest, are left out of it, as are bits too small to be letters beside them (the
  // motion lines of 👏, the dots of a punctuation mark).
  const sizable = components.filter((c) => c.pixels.length >= 6);
  const heightOf = (c) => c.bottom - c.y;
  const tinted = new Set(sizable.filter((c) => page.describe(box(c.x, c.y, c.right, c.bottom)).tint >= 45));
  const tallestTinted = Math.max(0, ...[...tinted].map(heightOf));
  const big = new Set([...tinted].filter((c) => heightOf(c) >= 0.8 * tallestTinted && Math.abs(c.right - c.x - heightOf(c)) <= 0.35 * heightOf(c)));
  const letterSized = (c) => heightOf(c) >= 0.3 * tallestTinted;
  const rest = sizable.filter((c) => !big.has(c) && letterSized(c)).map(heightOf);
  const typical = (rest.length && tallestTinted >= 1.4 * median(rest) ? median(rest) : median(sizable.map(heightOf))) || 0;
  const emojiLike = new Set(sizable.filter((c) => heightOf(c) > 1.6 * typical && tinted.has(c)));
  const heights = sizable.filter((c) => !emojiLike.has(c) && letterSized(c)).map(heightOf).sort((a, b) => a - b);
  const tall = heights[Math.floor(0.8 * (heights.length - 1))] ?? 0;
  // Badges too, for measuring text: solid squares a little taller than letters would pass for text's dense
  // middle where a line has little other text.
  const badgeLike = (c) => {
    const h = heightOf(c);
    const w = c.right - c.x;
    return h >= 1.05 * typical && h <= 1.6 * typical && Math.abs(w - h) <= 0.3 * h && c.pixels.length >= 0.6 * w * h;
  };
  // (Beside emoji, nothing much shorter than one is a blob: an @ or an l reaches above a line of x-height
  // letters, and the line needs it to be measured. An owner's chip always is.)
  const blobHeight = Math.max(12, 1.45 * tall, big.size && tallestTinted >= 1.4 * typical ? 0.7 * tallestTinted : 0);
  const chipLike = (c) => c.right - c.x >= 1.3 * heightOf(c) && heightOf(c) >= 12 && page.chipScale(box(c.x, c.y, c.right, c.bottom)) !== null;
  const roughBlobs = page.markBlobs(components, blobHeight, (c) => emojiLike.has(c) || badgeLike(c) || chipLike(c));
  // An owner's name is inside a chip, out of the bands (and may be the only real text): the chip's height says,
  // unless the image's edge cuts the chip.
  const chipScales = roughBlobs.filter(({ box: b }) => b.y > 0 && bottom(b) < height).map((blob) => page.chipScale(blob.box)).filter(Boolean);
  const avatarColumn = page.findAvatarColumn(chipScales.length ? median(chipScales) : null, typical);
  const contentLeft = avatarColumn?.textLeft ?? 0;
  const roughBands = page.findBands(contentLeft, roughBlobs);
  if (!roughBands.length) throw new Error('No text found in the image.');
  const scale = knownScale ?? estimateScale(roughBands, avatarColumn, chipScales, height);
  // Screens and browser zoom put chat text between about half and four times its size; text far outside that
  // (a photo, a document) is not a chat comment, and reading it as one could take minutes.
  if (!(scale >= MIN_SCALE && scale <= MAX_SCALE)) throw new Error("Couldn't find a chat comment in the image.");
  const found = page.findBands(contentLeft, page.markBlobs(components, BLOB * scale));
  for (const band of found) page.splitWords(band, scale);
  // A band left with nothing in it held only specks (JPEG noise, dust), as does one a pixel or two thin with
  // no more than a few pixels of ink; a long rule as thin that reaches into the avatars' column or to the
  // image's edge is a border of the page (a line of em dashes stays in the text's column): none is a line.
  const thin = (band) => band.bottom - band.top <= 2 * scale;
  const rule = (band) => thin(band) && band.words.every((w) => w.box.width >= 30 * scale && (w.box.x < contentLeft - 4 * scale || w.box.x <= 0 || right(w.box) >= width));
  const specks = (band) => thin(band) && band.words.reduce((sum, w) => sum + w.box.width, 0) <= 3 * scale;
  const kept = found.filter((band) => band.words.length && !rule(band) && !specks(band));
  // A pale emoji on a line of its own (💀 on the light theme) can come apart into rows of ink with gaps between
  // them, each taken for a line: lines that together are no taller than an emoji are one. (Two lines of text
  // are 20px apart, so never fit.)
  const bands = [];
  for (const band of kept) {
    const last = bands.at(-1);
    if (last && band.top - last.bottom <= 4 * scale && band.bottom - last.top <= (EMOJI + 2) * scale) {
      const joined = {
        ...last, top: last.top, bottom: band.bottom, blobs: [...last.blobs, ...band.blobs],
        textTop: last.textTop ?? band.textTop, textBottom: band.textBottom ?? last.textBottom, ink: (last.ink ?? 0) + (band.ink ?? 0),
      };
      page.splitWords(joined, scale);
      bands[bands.length - 1] = joined;
    } else bands.push(band);
  }
  if (!bands.length) throw new Error('No text found in the image.');

  const avatars = avatarColumn ? page.avatarRuns(avatarColumn, scale) : null;
  const comments = groupComments(bands, scale, height, avatars).map((group) => page.readComment(group, scale, avatarColumn));
  // Text that reaches the image's left or right edge was cut there, as was a line touching the top or bottom.
  for (const comment of comments) {
    const b = comment.box;
    comment.cut = Boolean(b) && (b.x <= 0 || right(b) >= width || b.y <= 0 || bottom(b) >= height);
    if (comment.cut) comment.complete = false;
  }
  const named = [(c) => c.complete && c.name && !c.doubtfulName, (c) => c.complete && c.name, (c) => c.name];
  const target = named.map((test) => comments.findIndex(test)).find((index) => index >= 0) ?? -1;
  if (target < 0) throw new Error("Couldn't find a chat comment in the image.");
  return { theme: luminance(background) < 128 ? 'dark' : 'light', background, scale, comments, target };
}

// ---- Colours ---------------------------------------------------------------------------------------------

const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const colourDistance = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
const chroma = ([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b);

/** The most common colour (to within 8 levels per channel, then averaged), sampling at most ~250k pixels. */
export function findBackground({ width, height, data }) {
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 250_000)));
  const bins = new Uint32Array(32 * 32 * 32);
  const bin = (i) => ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) bins[bin((y * width + x) * 4)]++;
  }
  let best = 0;
  for (let i = 1; i < bins.length; i++) if (bins[i] > bins[best]) best = i;
  const sum = [0, 0, 0];
  let count = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      if (bin(i) !== best) continue;
      sum[0] += data[i]; sum[1] += data[i + 1]; sum[2] += data[i + 2];
      count++;
    }
  }
  return sum.map((v) => Math.round(v / count));
}

// ---- Geometry --------------------------------------------------------------------------------------------

const box = (x, y, right, bottom) => ({ x, y, width: right - x, height: bottom - y }); // right/bottom exclusive
const right = (b) => b.x + b.width;
const bottom = (b) => b.y + b.height;
const union = (a, b) => box(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(right(a), right(b)), Math.max(bottom(a), bottom(b)));
const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

function median(values) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The diameter of a disc the image's left edge cut, from what is left of it (a box `width` wide and `height`
 * tall): its height while the cut is left of the centre, else what the chord the edge makes says
 * (r = (h²/4 + w²) / 2w).
 */
function cutDiameter({ width: w, height: h }) {
  if (w <= 0) return 0;
  return w >= h / 2 ? h : (h * h) / (4 * w) + w;
}

/** A component ({ x, y, right, bottom, pixels }) of `pixels` (indices into an image `width` wide). */
function componentOf(pixels, width) {
  const component = { x: Infinity, y: Infinity, right: 0, bottom: 0, pixels };
  for (const p of pixels) {
    const x = p % width;
    const y = (p - x) / width;
    component.x = Math.min(component.x, x);
    component.y = Math.min(component.y, y);
    component.right = Math.max(component.right, x + 1);
    component.bottom = Math.max(component.bottom, y + 1);
  }
  return component;
}

/** The 8-connected components among `pixels`. */
function connectedParts(pixels, width) {
  const left = new Set(pixels);
  const parts = [];
  for (const start of pixels) {
    if (!left.has(start)) continue;
    left.delete(start);
    const part = [];
    const stack = [start];
    while (stack.length) {
      const p = stack.pop();
      part.push(p);
      const x = p % width;
      for (const q of [p - width - 1, p - width, p - width + 1, p - 1, p + 1, p + width - 1, p + width, p + width + 1]) {
        const qx = q % width;
        if (Math.abs(qx - x) <= 1 && left.has(q)) {
          left.delete(q);
          stack.push(q);
        }
      }
    }
    parts.push(componentOf(part, width));
  }
  return parts;
}

/** Runs of non-zero entries of `profile` from `from`, joined across gaps of at most `joinGap` zeros. */
function runs(profile, from, to, joinGap) {
  const found = [];
  for (let i = from; i < to;) {
    if (!profile[i]) { i++; continue; }
    const start = i;
    let end = i;
    while (i < to) {
      if (profile[i]) end = ++i;
      else if (i - end < joinGap) i++;
      else break;
    }
    found.push({ start, end });
    i = Math.max(i, end);
  }
  return found;
}

// ---- The page --------------------------------------------------------------------------------------------

class Page {
  constructor(image, background) {
    this.image = image;
    this.width = image.width;
    this.height = image.height;
    this.background = background;
    const { data } = image;
    const n = image.width * image.height;
    // Contrast against the background: the largest channel difference (ClearType tints edges per channel).
    this.contrast = new Uint8Array(n);
    // The blob (1-based index) each pixel belongs to, so text projections can leave blobs out.
    this.blobOf = new Int32Array(n);
    const [br, bg, bb] = background;
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      this.contrast[p] = Math.max(Math.abs(data[i] - br), Math.abs(data[i + 1] - bg), Math.abs(data[i + 2] - bb));
    }
    // A border across the whole snip (the edge of the chat panel) is no part of a comment: rows of ink across
    // nine tenths of the width or more, three at most, count as background.
    const { width, height } = image;
    const full = (y) => {
      let inked = 0;
      for (let x = 0, p = y * width; x < width; x++, p++) if (this.contrast[p] >= INK) inked++;
      return inked >= 0.9 * width;
    };
    for (let y = 0; y < height;) {
      if (!full(y)) { y++; continue; }
      let end = y;
      while (end < height && full(end)) end++;
      if (end - y <= 3) this.contrast.fill(0, y * width, end * width);
      y = end;
    }
  }

  isInk(p) {
    return this.contrast[p] >= INK;
  }

  /** All connected components of ink (8-connected), with their pixels. */
  findComponents() {
    const { width, height } = this;
    const label = new Int32Array(width * height);
    const components = [];
    const stack = [];
    for (let start = 0; start < width * height; start++) {
      if (label[start] || !this.isInk(start)) continue;
      const id = components.length + 1;
      const component = { x: width, y: height, right: 0, bottom: 0, pixels: [] };
      label[start] = id;
      stack.push(start);
      while (stack.length) {
        const p = stack.pop();
        const x = p % width;
        const y = (p - x) / width;
        component.pixels.push(p);
        if (x < component.x) component.x = x;
        if (y < component.y) component.y = y;
        if (x >= component.right) component.right = x + 1;
        if (y >= component.bottom) component.bottom = y + 1;
        for (let yy = Math.max(0, y - 1); yy <= Math.min(height - 1, y + 1); yy++) {
          for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx++) {
            const q = yy * width + xx;
            if (!label[q] && this.isInk(q)) {
              label[q] = id;
              stack.push(q);
            }
          }
        }
      }
      components.push(component);
    }
    return components;
  }

  /**
   * An owner's chip that touches an emoji on the line below (or above) is one component with it: its rows,
   * which span about the component's whole width (an emoji's are much narrower), are cut off when they make
   * a chip (see chipScale), all but the emoji's coloured pixels in them.
   */
  splitChips(components) {
    return components.flatMap((c) => (c.bottom - c.y >= 16 && c.right - c.x >= 24 ? this.chipAndRest(c) : null) ?? [c]);
  }

  chipAndRest(c) {
    const { width } = this;
    const h = c.bottom - c.y;
    const { data } = this.image;
    const rows = Array.from({ length: h }, () => ({ count: 0, grey: 0, left: Infinity, right: -1 }));
    for (const p of c.pixels) {
      const x = p % width;
      const row = rows[(p - x) / width - c.y];
      row.count++;
      if (chroma([data[p * 4], data[p * 4 + 1], data[p * 4 + 2]]) < 60) row.grey++;
      row.left = Math.min(row.left, x);
      row.right = Math.max(row.right, x + 1);
    }
    const widest = Math.max(...rows.map((row) => row.right - row.left));
    // A chip's rows: about as wide as the whole, mostly filled, and largely grey (ClearType tints the edges of
    // the name's letters, up to four fifths of a row's pixels below 1x; a run of emoji under the chip can be
    // as wide, but is coloured through and through: 15% grey at most).
    const chipRow = (row) => row.right - row.left >= 0.75 * widest && row.count >= 0.3 * widest && row.grey >= 0.18 * row.count;
    for (const fromTop of [true, false]) {
      let n = 0;
      while (n < h && chipRow(rows[fromTop ? n : h - 1 - n])) n++;
      if (n < 12 || n > h - 2) continue;
      // The chip ends in its padding, a solid row: not in the middle of its letters.
      const edge = rows[fromTop ? n - 1 : h - n];
      if (edge.count < 0.9 * (edge.right - edge.left)) continue;
      const y0 = fromTop ? c.y : c.bottom - n;
      const y1 = y0 + n;
      const chipRows = rows.slice(y0 - c.y, y1 - c.y);
      const chip = box(Math.min(...chipRows.map((row) => row.left)), y0, Math.max(...chipRows.map((row) => row.right)), y1);
      if (chip.width < 1.3 * chip.height || !this.chipScale(chip)) continue;
      // In the rows they share, the chip is grey and an emoji's edge is coloured.
      const inChip = (p) => {
        const y = Math.floor(p / width);
        return y >= y0 && y < y1 && chroma([data[p * 4], data[p * 4 + 1], data[p * 4 + 2]]) < 60;
      };
      return [componentOf(c.pixels.filter(inChip), width), ...connectedParts(c.pixels.filter((p) => !inChip(p)), width)];
    }
    return null;
  }

  /**
   * Marks the components taller than `minHeight` (or that `also` picks) as blobs (emoji, letter avatars, owner
   * chips): text projections leave them out. Replaces any earlier marking. The bits of an emoji that don't
   * touch its main piece (the motion lines of 👏, a sparkle) lie inside its cell, up to about a third bigger
   * than the main piece: small pieces wholly inside that square around a squarish blob are part of it.
   */
  markBlobs(components, minHeight, also = () => false) {
    this.blobOf.fill(0);
    const blobs = [];
    const others = [];
    for (const c of components) {
      if (c.bottom - c.y < minHeight && !also(c)) {
        others.push(c);
        continue;
      }
      const blob = { box: box(c.x, c.y, c.right, c.bottom), index: blobs.length + 1 };
      for (const p of c.pixels) this.blobOf[p] = blob.index;
      blobs.push(blob);
    }
    const cells = blobs.filter(({ box: b }) => Math.abs(b.width - b.height) <= 0.35 * Math.max(b.width, b.height)).map((blob) => {
      const side = 1.35 * Math.max(blob.box.width, blob.box.height);
      const cx = blob.box.x + blob.box.width / 2;
      const cy = blob.box.y + blob.box.height / 2;
      return { blob, x0: cx - side / 2, y0: cy - side / 2, x1: cx + side / 2, y1: cy + side / 2 };
    });
    for (const c of others) {
      const home = cells.find((cell) => c.x >= cell.x0 && c.y >= cell.y0 && c.right <= cell.x1 && c.bottom <= cell.y1
        && c.bottom - c.y < 0.45 * cell.blob.box.height);
      if (home) for (const p of c.pixels) this.blobOf[p] = home.blob.index;
    }
    return blobs;
  }

  /**
   * The scale from a blob that is an owner's chip: a grey, black or white box wider than tall, 21px high
   * (14px text plus 2px padding above and below), with the name's letters as holes. Null when it isn't one.
   */
  chipScale(b) {
    if (b.width < 1.3 * b.height || b.height < 12) return null;
    const { ink, colourful } = this.describe(b);
    if (chroma(ink) > 24 || colourful > 0.3) return null; // flags and other wide emoji are colourful
    // Holes: chip-coloured or not, the box must not be solid (the letters show the background).
    const { data } = this.image;
    let holes = 0;
    for (let y = b.y; y < bottom(b); y++) {
      for (let x = b.x + Math.ceil(b.height / 2), i = (y * this.width + x) * 4; x < right(b) - Math.ceil(b.height / 2); x++, i += 4) {
        if (colourDistance([data[i], data[i + 1], data[i + 2]], ink) >= INK) holes++;
      }
    }
    // A filled box with letters as holes, not a word whose letters touch: mostly the chip's colour.
    let filled = 0;
    for (let y = b.y; y < bottom(b); y++) {
      for (let x = b.x, i = (y * this.width + x) * 4; x < right(b); x++, i += 4) {
        if (colourDistance([data[i], data[i + 1], data[i + 2]], ink) < INK) filled++;
      }
    }
    if (filled < 0.55 * b.width * b.height) return null;
    return holes >= 0.05 * b.width * b.height ? b.height / CHIP : null;
  }

  /** Ink pixels per column (or per row) over a rectangle, optionally without blobs. */
  profile(axis, x0, y0, x1, y1, { skipBlobs = true } = {}) {
    const counts = new Uint32Array(axis === 'x' ? this.width : this.height);
    for (let y = y0; y < y1; y++) {
      for (let x = x0, p = y * this.width + x0; x < x1; x++, p++) {
        if (this.isInk(p) && !(skipBlobs && this.blobOf[p])) counts[axis === 'x' ? x : y]++;
      }
    }
    return counts;
  }

  /**
   * The avatars' column: ink at the left followed by a gap at least ~13px wide (YouTube leaves 16px), no
   * wider than an avatar, with the text right of the gap. Its scale comes from an owner's chip when there is
   * one, else from that text's x-height, since nothing else is known yet. Returns { box, textLeft } or null.
   */
  findAvatarColumn(knownScale = null, typical = 0) {
    const { width, height } = this;
    const columns = this.profile('x', 0, 0, width, height, { skipBlobs: false });
    let first = 0;
    while (first < width && !columns[first]) first++;
    // (A speck to the avatar's left is not where its column starts.)
    for (;;) {
      let end = first;
      let ink = 0;
      while (end < width && columns[end]) ink += columns[end++];
      if (ink > 4 || end >= width) break;
      first = end;
      while (first < width && !columns[first]) first++;
    }
    let x = first;
    while (x < width) {
      while (x < width && columns[x]) x++;
      const gapStart = x;
      while (x < width && !columns[x]) x++;
      if (x >= width) return null;
      const gap = x - gapStart;
      if (gap < 4) continue; // a gap inside a photo avatar's fragments, or inside a word
      // A round disc (a letter avatar, a photo that fills its circle) with the avatar's gap after it, about two
      // thirds of its width, needs no scale. So does one the image's left edge cuts: it keeps its height, 24px
      // (much taller than letters, unlike a name the edge cuts), and the 16px gap after it.
      const disc = this.avatarAt(first, gapStart);
      if (disc && disc.round && gap >= 0.5 * disc.box.width && gap <= 0.9 * disc.box.width) return { box: disc.box, textLeft: x, fill: disc.fill };
      const diameter = disc && disc.box.x === 0 ? cutDiameter(disc.box) : 0;
      if (diameter && disc.box.width <= disc.box.height + 1 && disc.fill >= 0.6 && diameter >= 1.5 * typical
        && Math.abs(gap - (AVATAR_GAP * diameter) / AVATAR) <= (0.25 * AVATAR_GAP * diameter) / AVATAR) {
        return { box: disc.box, textLeft: x, fill: disc.fill, cut: true, diameter };
      }
      const scale = knownScale ?? this.textScale(x);
      if (!scale) continue;
      // (The scale is rough here: allow for it being a little low.)
      if (gapStart - first > (AVATAR + 2) * 1.12 * scale + 2) return null;
      if (gap >= 12.5 * scale && x - first <= (AVATAR + AVATAR_GAP + 2) * 1.12 * scale + 2) {
        const { box: ink, fill } = this.avatarAt(first, gapStart);
        return { box: ink, textLeft: x, fill };
      }
    }
    return null;
  }

  /**
   * The avatars down the avatar column: runs of rows with ink there, about an avatar tall (a run touching the
   * image's top or bottom edge may be shorter: an avatar cut off). [{ top, bottom }].
   */
  avatarRuns({ box: column, textLeft }, scale) {
    const rows = this.profile('y', column.x, 0, textLeft, this.height, { skipBlobs: false });
    return runs(rows, 0, this.height, Math.max(1, Math.round(2 * scale)))
      .map(({ start, end }) => ({ top: start, bottom: end }))
      .filter(({ top, bottom }) => bottom - top >= 12 * scale || top === 0 || bottom === this.height);
  }

  /**
   * The ink in columns [x0, x1): its box, how much of the box it fills, and whether it is a round disc (square
   * and filled about as a circle fills its box, pi/4).
   */
  avatarAt(x0, x1) {
    const ink = this.inkBox(x0, 0, x1, this.height);
    if (!ink) return null;
    let inked = 0;
    for (let y = ink.y; y < bottom(ink); y++) {
      for (let x = ink.x, p = y * this.width + x; x < right(ink); x++, p++) if (this.isInk(p)) inked++;
    }
    const fill = inked / (ink.width * ink.height);
    return { box: ink, fill, round: ink.x > 0 && ink.width >= 12 && Math.abs(ink.width - ink.height) <= 1 && fill >= 0.72 && fill <= 0.86 };
  }

  /**
   * A rough scale from the x-height of the text right of `x0`: its lines' estimates weighted by their ink,
   * leaving out slivers and lines cut by the image's edge (unless that is all there is).
   */
  textScale(x0) {
    const rows = this.profile('y', x0, 0, this.width, this.height);
    const lines = runs(rows, 0, this.height, 1).map(({ start, end }) => ({
      top: start, bottom: end, ink: rows.subarray(start, end).reduce((a, b) => a + b, 0), scale: bandMetrics(rows.subarray(start, end))?.scale,
    })).filter((line) => line.scale);
    const most = Math.max(0, ...lines.map((line) => line.ink));
    const solid = lines.filter((line) => line.ink >= 0.15 * most);
    const whole = solid.filter((line) => line.top > 0 && line.bottom < this.height);
    const scale = weightedMedian((whole.length ? whole : solid).map((line) => [line.scale, line.ink]));
    return Number.isFinite(scale) ? scale : null;
  }

  /** Bounding box of the ink in [x0, x1) × [y0, y1), or null. */
  inkBox(x0, y0, x1, y1, { skipBlobs = false, against = null } = {}) {
    const { data } = this.image;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -1;
    let maxY = -1;
    for (let y = Math.max(0, y0); y < Math.min(this.height, y1); y++) {
      for (let x = Math.max(0, x0), p = y * this.width + x; x < Math.min(this.width, x1); x++, p++) {
        if (against) {
          const i = p * 4;
          if (colourDistance([data[i], data[i + 1], data[i + 2]], against) < INK) continue;
        } else if (!this.isInk(p) || (skipBlobs && this.blobOf[p])) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    return maxX < 0 ? null : box(minX, minY, maxX + 1, maxY + 1);
  }

  /**
   * Text lines right of `contentLeft`: runs of rows holding non-blob ink. Blobs join the line they overlap
   * most, or make a line of their own (only emoji, or an owner chip with nothing beside it).
   */
  findBands(contentLeft, blobs) {
    const rows = this.profile('y', contentLeft, 0, this.width, this.height);
    // A blob sits on one line: runs of text rows that one spans (a small timestamp beside an owner's chip,
    // bits of an emoji above it) are that line.
    const textRuns = runs(rows, 0, this.height, 1);
    // Over a line with nothing taller than an x, the dots of its i's and j's (or accents) are a thin run of
    // rows just above it; an underscore can be one just below the line above. Each belongs to the line it is
    // nearest. (Heights are the runs' own: a run that has taken in dots doesn't grow into taking in more,
    // which would glue the pieces of a pale emoji, run by run, onto the line above.)
    for (const run of textRuns) run.rows = run.end - run.start;
    for (let i = 0; i < textRuns.length; i++) {
      const run = textRuns[i];
      const gapAbove = i > 0 ? run.start - textRuns[i - 1].end : Infinity;
      const gapBelow = i + 1 < textRuns.length ? textRuns[i + 1].start - run.end : Infinity;
      const j = gapBelow <= gapAbove ? i + 1 : i - 1;
      const near = textRuns[j];
      // (Up onto the line above goes only what is as thin as an underscore: a pale emoji's piece below a line
      // is thicker.)
      const thin = j > i ? 0.35 : 0.15;
      if (near && run.rows <= thin * near.rows && Math.min(gapAbove, gapBelow) <= run.rows + 1) {
        textRuns.splice(Math.min(i, j), 2, { start: Math.min(run.start, near.start), end: Math.max(run.end, near.end), rows: near.rows });
        i = Math.min(i, j);
      }
    }
    const spans = blobs.filter(({ box: b }) => right(b) > contentLeft).map(({ box: b }) => b);
    const covers = (b, run) => overlap(run.start, run.end, b.y, bottom(b)) >= 0.6 * (run.end - run.start);
    for (let i = 1; i < textRuns.length; i++) {
      const a = textRuns[i - 1];
      const b = textRuns[i];
      if (spans.some((o) => covers(o, a) && covers(o, b) && Math.max(b.end, bottom(o)) - Math.min(a.start, o.y) <= 1.25 * o.height)) {
        textRuns.splice(--i, 2, { start: a.start, end: b.end });
      }
    }
    const bands = textRuns.map(({ start, end }) => ({
      top: start, bottom: end, textTop: start, textBottom: end, blobs: [], contentLeft,
      ink: rows.subarray(start, end).reduce((a, b) => a + b, 0),
      ...bandMetrics(rows.subarray(start, end), start),
    }));
    for (const blob of blobs) {
      if (right(blob.box) <= contentLeft) continue; // a letter avatar
      let best = null;
      let bestOverlap = 0;
      for (const band of bands) {
        const o = overlap(band.textTop, band.textBottom, blob.box.y, bottom(blob.box));
        if (o > bestOverlap) { best = band; bestOverlap = o; }
      }
      if (best && bestOverlap >= 0.3 * Math.min(best.textBottom - best.textTop, blob.box.height)) best.blobs.push(blob);
      else bands.push({ top: blob.box.y, bottom: bottom(blob.box), textTop: null, textBottom: null, blobs: [blob], contentLeft, baseline: null, scale: null });
    }
    bands.sort((a, b) => a.top - b.top);
    for (const band of bands) {
      for (const blob of band.blobs) {
        band.top = Math.min(band.top, blob.box.y);
        band.bottom = Math.max(band.bottom, bottom(blob.box));
      }
    }
    // Overlapping lines where one has no text (emoji side by side, a chip and an emoji) are one line. (An
    // owner's chip reaches a row or two into the emoji of the line below: that is not sharing a line.)
    for (let i = 1; i < bands.length; i++) {
      const a = bands[i - 1];
      const b = bands[i];
      const shared = overlap(a.top, a.bottom, b.top, b.bottom);
      if (shared > 0 && shared >= 0.5 * Math.min(a.bottom - a.top, b.bottom - b.top) && (a.textTop === null || b.textTop === null)) {
        const text = a.textTop !== null ? a : b;
        bands[i - 1] = { ...text, top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom), blobs: [...a.blobs, ...b.blobs] };
        bands.splice(i--, 1);
      }
    }
    return bands;
  }

  /** Cuts a band's text into words at gaps wider than letters leave (see joinGap). */
  splitWords(band, scale) {
    const words = [];
    if (band.textTop !== null) {
      const columns = this.profile('x', band.contentLeft, band.textTop, this.width, band.textBottom);
      for (const { start, end } of runs(columns, band.contentLeft, this.width, joinGap(scale))) {
        const ink = this.inkBox(start, band.textTop, end, band.textBottom, { skipBlobs: true });
        if (ink) words.push(...this.splitTrailingBadge({ kind: 'text', box: ink }, scale));
      }
    }
    // Ink mostly within a blob's box is part of it: the counters of an owner chip's letters (chip-coloured
    // islands in background-coloured letters), the separate bits of an emoji.
    const inside = (b) => band.blobs.some(({ box: o }) => overlap(b.x, right(b), o.x, right(o)) * overlap(b.y, bottom(b), o.y, bottom(o)) >= 0.5 * b.width * b.height);
    // A pixel on its own is JPEG noise (a full stop is wider), and could join the timestamp to the name.
    const speck = (b) => Math.max(b.width, b.height) <= Math.max(1, 0.6 * scale);
    for (let i = words.length - 1; i >= 0; i--) if (inside(words[i].box) || speck(words[i].box)) words.splice(i, 1);
    // A snip of the comment under the pointer shows YouTube's "more" menu: three dots at the row's right end.
    const last = words.at(-1);
    if (last && words.length > 1 && last.box.x - right(words.at(-2).box) >= 4 * scale && this.isMenuDots(last.box, scale)) words.pop();
    for (const blob of band.blobs) words.push({ kind: 'blob', box: blob.box });
    words.sort((a, b) => a.box.x - b.box.x);
    for (const word of words) Object.assign(word, this.describe(word.box));
    band.words = words;
  }

  /**
   * Whether `b` holds YouTube's vertical-ellipsis menu icon: three dots 4px across, 6px apart, one above the
   * other, and nothing else. (Where a dot falls between pixels changes its size by a pixel or two.)
   */
  isMenuDots(b, scale) {
    if (b.width > 6 * scale || b.height < 9 * scale || b.height > 18 * scale) return false;
    const rows = this.profile('y', b.x, b.y, right(b), bottom(b));
    const dots = runs(rows, b.y, bottom(b), 0);
    if (dots.length !== 3) return false;
    const heights = dots.map((d) => d.end - d.start);
    const pitches = [dots[1].start - dots[0].start, dots[2].start - dots[1].start];
    const slack = Math.max(2, 0.8 * scale);
    return heights.every((h) => h <= 5.5 * scale) && Math.max(...heights) - Math.min(...heights) <= slack
      && pitches.every((p) => Math.abs(p - 6 * scale) <= slack);
  }

  /**
   * A badge only 2px after the name (a member badge image fills its box) is not split off by the gap rule;
   * split it off a word when the word ends in a run of columns as tall as a badge (taller than any letter),
   * or in a piece after an empty column that is badge-sized, about as wide as tall, with a column taller than
   * any letter (a round verified badge, whose edge columns are short; a k and a y side by side are as big,
   * but no column of theirs is that tall).
   */
  splitTrailingBadge(word, scale, against = null) {
    const { x, y, width, height } = word.box;
    if (height < 13.5 * scale || width < 20 * scale) return [word];
    const columnHeight = (column) => this.inkBox(column, y, column + 1, y + height, { skipBlobs: !against, against })?.height ?? 0;
    const split = (start) => {
      const text = this.inkBox(x, y, start, y + height, { skipBlobs: !against, against });
      const badge = this.inkBox(start, y, x + width, y + height, { skipBlobs: !against, against });
      return text && badge ? [{ kind: 'text', box: text }, { kind: 'badge', box: badge }] : null;
    };
    let gap = x + width - 1;
    while (gap > x && columnHeight(gap) > 0) gap--;
    if (gap > x) {
      const piece = this.inkBox(gap + 1, y, x + width, y + height, { skipBlobs: !against, against });
      let tallest = 0;
      for (let column = gap + 1; column < x + width; column++) tallest = Math.max(tallest, columnHeight(column));
      if (piece && tallest >= 13.5 * scale && piece.width >= 9 * scale && piece.width <= 17.5 * scale
        && Math.abs(piece.width - piece.height) <= 0.3 * piece.height) {
        const parts = split(gap + 1);
        if (parts) return parts;
      }
    }
    // From the right: columns at least two thirds of a badge tall (rounded corners are shorter), most of
    // them taller than any letter.
    let start = x + width;
    let tallColumns = 0;
    while (start > x) {
      const h = columnHeight(start - 1);
      if (h < 9.5 * scale) break;
      if (h >= 13.5 * scale) tallColumns++;
      start--;
    }
    const badgeWidth = x + width - start;
    if (badgeWidth < 9 * scale || badgeWidth > 17.5 * scale || tallColumns < 0.5 * badgeWidth) return [word];
    return split(start) ?? [word];
  }

  /**
   * Colour statistics of a region: its ink (the mean colour of the pixels that differ most in luminance from
   * the background), that difference, and how colourful the ink is.
   */
  describe(region, background = this.background) {
    const { data } = this.image;
    const bgLum = luminance(background);
    let maxLum = 0;
    for (let y = region.y; y < bottom(region); y++) {
      for (let x = region.x, i = (y * this.width + x) * 4; x < right(region); x++, i += 4) {
        maxLum = Math.max(maxLum, Math.abs(luminance([data[i], data[i + 1], data[i + 2]]) - bgLum));
      }
    }
    const sum = [0, 0, 0];
    const inkSum = [0, 0, 0];
    let strong = 0;
    let ink = 0;
    let colourful = 0;
    for (let y = region.y; y < bottom(region); y++) {
      for (let x = region.x, i = (y * this.width + x) * 4; x < right(region); x++, i += 4) {
        const rgb = [data[i], data[i + 1], data[i + 2]];
        if (Math.abs(luminance(rgb) - bgLum) >= 0.85 * maxLum) {
          sum[0] += rgb[0]; sum[1] += rgb[1]; sum[2] += rgb[2];
          strong++;
        }
        if (colourDistance(rgb, background) >= INK) {
          ink++;
          inkSum[0] += rgb[0]; inkSum[1] += rgb[1]; inkSum[2] += rgb[2];
          if (chroma(rgb) >= 60) colourful++;
        }
      }
    }
    return {
      ink: strong ? sum.map((v) => Math.round(v / strong)) : [...background],
      inkLum: maxLum,
      colourful: ink ? colourful / ink : 0,
      tint: ink ? chroma(inkSum.map((v) => v / ink)) : 0,
    };
  }

  /** Whether blob `b` is an owner's chip: chip-sized, and a filled grey box with letters for holes (an emoji
   * can be as big). */
  isChipBox(b, scale) {
    return isChip(b, scale) && this.chipScale(b) !== null;
  }

  /**
   * Whether `ink` is the message's colour (#fff on the dark theme, #0f0f0f on the light), not a viewer's name
   * (70% or 60% of the way there) or a moderator's or member's (coloured).
   */
  isMessageColour(ink) {
    const background = luminance(this.background);
    const full = Math.abs((background < 128 ? 255 : 15) - background);
    return chroma(ink) < 40 && Math.abs(luminance(ink) - background) >= 0.86 * full;
  }

  /** A text region over `words`: their combined box and the ink of the most contrasting one. */
  textRegion(words, baseline, background = this.background) {
    const strongest = words.reduce((a, b) => (b.inkLum > a.inkLum ? b : a));
    return { box: words.map((w) => w.box).reduce(union), words: words.map((w) => w.box), ink: strongest.ink, background, baseline };
  }

  /** Builds the comment (see analyzeScreenshot) for a group of bands. */
  readComment(group, scale, avatarColumn) {
    let [first, ...rest] = group.bands;
    const comment = {
      complete: group.complete,
      box: null,
      avatar: avatarColumn ? this.inkBox(avatarColumn.box.x, first.top - 8 * scale, avatarColumn.textLeft, first.top + 24 * scale) : null,
      timestamp: null,
      name: null,
      chip: null,
      badges: [],
      style: { role: 'viewer', verified: false },
      lines: [],
    };
    // A name too long to fit beside the timestamp goes on a line of its own under it.
    if (rest.length && this.isLoneTimestamp(first, rest[0], scale)) {
      comment.timestamp = this.textRegion(first.words, first.baseline);
      [first, ...rest] = rest;
    }
    const messageStart = this.readHeader(comment, first.words, first, scale);
    const lines = [lineOf(this, first, first.words.slice(messageStart), scale), ...rest.map((band) => lineOf(this, band, band.words, scale))];
    comment.lines = lines.filter(Boolean);
    const parts = [comment.timestamp?.box, comment.chip, comment.name?.box, ...comment.badges, ...comment.lines.map((l) => l.box)].filter(Boolean);
    comment.box = parts.length ? parts.reduce(union) : null;
    return comment;
  }

  /**
   * Whether `band` holds nothing but a timestamp, with the name on the next line: one short run of text, 11px
   * (well under a name's height above the baseline), with `next` starting where it does.
   */
  isLoneTimestamp(band, next, scale) {
    const words = band.words;
    if (!words.length || words.some((w) => w.kind !== 'text') || !next.words.length) return false;
    // A timestamp is grey, and what follows it is a name (a chip, or text not in the message's colour), where
    // a short name alone on its line is followed by message text. (How dim it is says little: JPEG brightens
    // a timestamp's thin strokes to a name's.)
    const strongest = words.reduce((a, b) => (b.inkLum > a.inkLum ? b : a));
    if (chroma(strongest.ink) >= 40) return false;
    if (next.words[0].kind === 'text' && this.isMessageColour(next.words[0].ink)) return false;
    for (let i = 1; i < words.length; i++) if (words[i].box.x - right(words[i - 1].box) >= 0.78 * NAME_GAP * scale) return false;
    const extent = words.map((w) => w.box).reduce(union);
    const above = Math.max(...words.map((w) => band.baseline - w.box.y));
    return above <= 9.6 * scale && extent.width <= 70 * scale && Math.abs(next.words[0].box.x - extent.x) <= 3 * scale;
  }

  /**
   * Reads the timestamp, name and badges off the start of a comment's first line into `comment`; returns the
   * index of the first word of the message.
   */
  readHeader(comment, words, band, scale) {
    // Segments: words separated by less than most of NAME_GAP (and never across a blob).
    const bigGap = 0.78 * NAME_GAP * scale;
    const segments = [];
    words.forEach((word, index) => {
      const segment = segments.at(-1);
      const last = segment && words[segment.end - 1];
      if (last && word.kind !== 'blob' && last.kind !== 'blob' && word.box.x - right(last.box) < bigGap) segment.end = index + 1;
      else segments.push({ start: index, end: index + 1 });
    });
    const wordsOf = (segment) => words.slice(segment.start, segment.end);
    let s = 0;

    // Timestamp: 11px text before the name, so clearly shorter above the baseline than the name; the only
    // text that can come before an owner's chip.
    if (segments.length >= 2 && wordsOf(segments[0]).every((w) => w.kind === 'text')) {
      const above = (segment) => Math.max(...wordsOf(segment).map((w) => band.baseline - w.box.y));
      const next = words[segments[1].start];
      const beforeChip = next.kind === 'blob' && this.isChipBox(next.box, scale);
      // (Shorter than a name, that is: not than a pale emoji that came out as text. A name's ink, from an
      // accented capital's accent to a descender, is at most about 17.5px tall; an emoji's 22.)
      const shorter = next.kind === 'text' && next.box.height <= 18 * scale && above(segments[0]) <= 0.86 * above(segments[1]);
      if ((beforeChip || shorter) && above(segments[0]) <= 9.6 * scale) {
        comment.timestamp = this.textRegion(wordsOf(segments[0]), band.baseline);
        s = 1;
      }
    }
    const segment = segments[s];
    if (!segment) return words.length;
    const lead = words[segment.start];

    if (lead.kind === 'blob' && this.isChipBox(lead.box, scale)) {
      // Owner: the name inside a filled chip, in the page's background colour, maybe with a verified badge.
      comment.chip = lead.box;
      comment.style = { role: 'owner', verified: false };
      const chipColour = this.describe(lead.box).ink;
      // (The chip's 2px padding and Roboto's ascent put its text's baseline 15px below its top. The line's is
      // the same when the line has text of its own; with only emoji beside the chip it can be anything.)
      const own = Math.round(lead.box.y + 15 * scale);
      const baseline = Number.isFinite(band.baseline) && Math.abs(band.baseline - own) <= 2 * scale ? band.baseline : own;
      const { name, badge } = this.chipText(lead.box, chipColour, scale, baseline);
      comment.name = name;
      if (badge) {
        comment.badges.push(badge);
        comment.style.verified = true;
      }
      return segment.end;
    }
    if (lead.kind !== 'text') return segment.start; // no name: the line starts with an emoji

    // The name's words, then its badges; a change of colour also ends the name (the message's first word, when
    // the gap was misjudged).
    let i = segment.start;
    const nameWords = [];
    for (; i < segment.end; i++) {
      const word = words[i];
      if (word.kind !== 'text' || isBadge(word.box, scale)) break;
      if (nameWords.length && colourDistance(word.ink, nameWords[0].ink) > 48) break;
      nameWords.push(word);
    }
    if (!nameWords.length) return segment.start;
    comment.name = this.textRegion(nameWords, band.baseline);
    for (; i < words.length && isBadge(words[i].box, scale, words[i].kind) && words[i].box.x - right(words[i - 1].box) < bigGap; i++) {
      comment.badges.push(words[i].box);
    }
    // Only a verified author's name is in the message's colour, and a badge follows it: without a timestamp
    // or a badge, text in that colour is more likely message, the end of a comment cut off at the top of the
    // snip (or the badge was missed).
    comment.doubtfulName = !comment.timestamp && !comment.badges.length && this.isMessageColour(comment.name.ink);
    comment.style = nameStyle(comment.name.ink, this.background, comment.badges.length > 0);
    // The rest of the segment is the message (when the gap before it was misjudged); otherwise the next one.
    return i < segment.end ? i : (segments[segments.findIndex((sg) => sg.end > i)]?.start ?? words.length);
  }

  /**
   * The name inside an owner chip, and the verified badge after it if there is one (3px or more away, unlike
   * a member badge). The name's pixels are those not of the chip's colour that the chip encloses: what is not
   * chip-coloured and reaches the chip's bounding box is outside its rounded corners.
   */
  chipText(chip, chipColour, scale, baseline) {
    const { width: w, height: h } = chip;
    const { data } = this.image;
    const offChip = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = ((chip.y + y) * this.width + chip.x + x) * 4;
        offChip[y * w + x] = colourDistance([data[i], data[i + 1], data[i + 2]], chipColour) >= INK ? 1 : 0;
      }
    }
    const outside = new Uint8Array(w * h);
    const stack = [];
    for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
    for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
    while (stack.length) {
      const p = stack.pop();
      if (outside[p] || !offChip[p]) continue;
      outside[p] = 1;
      const x = p % w;
      if (x > 0) stack.push(p - 1);
      if (x < w - 1) stack.push(p + 1);
      if (p >= w) stack.push(p - w);
      if (p < (h - 1) * w) stack.push(p + w);
    }
    const isText = (x, y) => offChip[y * w + x] && !outside[y * w + x];
    const textBox = (x0, x1) => {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < h; y++) {
        for (let x = x0; x < x1; x++) {
          if (!isText(x, y)) continue;
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }
      }
      return maxX < 0 ? null : box(chip.x + minX, chip.y + minY, chip.x + maxX + 1, chip.y + maxY + 1);
    };
    const columns = new Uint32Array(w);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (isText(x, y)) columns[x]++;
    const pieces = runs(columns, 0, w, joinGap(scale)).map(({ start, end }) => textBox(start, end));
    let badge = null;
    if (pieces.length >= 2 && isBadge(pieces.at(-1), scale)) badge = pieces.pop();
    const clip = { box: chip, radius: Math.min(chip.height / 2, 8 * scale) };
    const name = pieces.length ? pieces.reduce(union) : box(chip.x + 4 * scale, chip.y, right(chip) - 4 * scale, bottom(chip));
    return { name: { box: name, words: pieces.length ? pieces : [name], ink: [...this.background], background: chipColour, baseline, clip }, badge };
  }
}

// ---- Lines, scale and comments ---------------------------------------------------------------------------

/**
 * Baseline and scale of a line from its row profile: ink is densest between the x-height line and the
 * baseline (most letters are lowercase), so the profile rises most sharply at the x-height line and falls
 * most sharply at the baseline. When nothing sticks out above that dense part, the line is in capitals and the
 * dense part is cap height.
 */
function bandMetrics(rows, top = 0) {
  if (rows.length < 4) return null;
  let rise = 0;
  let fall = rows.length;
  let bestRise = -Infinity;
  let bestFall = -Infinity;
  for (let y = 0; y <= rows.length; y++) {
    const above = y > 0 ? rows[y - 1] : 0;
    const here = y < rows.length ? rows[y] : 0;
    if (here - above > bestRise) { bestRise = here - above; rise = y; }
    if (above - here >= bestFall) { bestFall = above - here; fall = y; }
  }
  const dense = fall - rise;
  if (dense < 3) return null;
  const capitals = rise <= Math.max(1, 0.12 * dense);
  return { baseline: top + fall, scale: capitals ? (dense - 0.6) / CAP_HEIGHT : scaleFromXHeight(dense) };
}

// Windows hints Roboto's x-height to whole pixels, so the dense rows of a line are not 7.4px times the scale:
// [scale, rows] as Chromium renders them at common display scales (measured on the corpus), interpolated for
// anything in between.
const HINTED_X_HEIGHT = [[1, 8], [1.25, 10], [1.5, 11], [1.75, 13], [2, 15], [2.5, 18], [3, 22]];

function scaleFromXHeight(rows) {
  const [first] = HINTED_X_HEIGHT;
  const last = HINTED_X_HEIGHT.at(-1);
  if (rows <= first[1]) return (first[0] * rows) / first[1];
  if (rows >= last[1]) return last[0] + (rows - last[1]) / X_HEIGHT;
  const i = HINTED_X_HEIGHT.findIndex(([, h]) => h >= rows);
  const [s0, h0] = HINTED_X_HEIGHT[i - 1];
  const [s1, h1] = HINTED_X_HEIGHT[i];
  return s0 + ((s1 - s0) * (rows - h0)) / (h1 - h0);
}

/**
 * Device px per CSS px. Exact measures decide it when there are any, in this order: a fully visible round
 * avatar (24px: a square box filled like a disc, so not a photo whose dark edges vanish), an owner's chip
 * (21px tall), the spacing of lines holding message text (20px; lines beside emoji are a little further
 * apart, the next comment much further, so only spacings near what the x-height says count, the smallest
 * of them). Otherwise the x-height decides (exact at common display scales, where it is hinted to whole
 * pixels), each line weighted by its ink (a line of emoji bits says little). A comment's first line can
 * hold only the name, in a shorter line box (18-19px), so its spacing to the second counts only when it is
 * not short of the estimate.
 */
function estimateScale(bands, avatarColumn, chipScales = [], imageHeight = Infinity) {
  const avatar = avatarColumn?.box;
  if (avatar && avatar.x > 0 && Math.abs(avatar.width - avatar.height) <= 1 && avatar.width >= 12 && avatarColumn.fill >= 0.72) {
    return nearestCommonScale(avatar.width / AVATAR, 0.04) ?? Math.round((avatar.width / AVATAR) * 100) / 100;
  }
  // An avatar the left edge cut still shows its size.
  if (avatarColumn?.cut && avatarColumn.diameter >= 12) {
    const s = avatarColumn.diameter / AVATAR;
    return nearestCommonScale(s, 0.04) ?? Math.round(s * 100) / 100;
  }
  if (chipScales.length) return nearestCommonScale(median(chipScales), 0.05) ?? Math.round(median(chipScales) * 100) / 100;
  // Lines of text worth measuring: not slivers (bits of emoji), and not cut by the image's edge unless that
  // is all there is.
  const most = Math.max(0, ...bands.map((b) => b.ink ?? 0));
  const solid = bands.filter((b) => b.scale && b.ink >= 0.15 * most);
  const whole = solid.filter((b) => b.top > 0 && b.bottom < imageHeight);
  const text = whole.length ? whole : solid;
  let estimate = weightedMedian(text.map((b) => [b.scale, b.ink]));
  if (!Number.isFinite(estimate)) {
    // No text at all (emoji only): the tallest blob is an emoji or an avatar, 24px.
    estimate = Math.max(...bands.map((b) => b.bottom - b.top)) / EMOJI;
  }
  const near = (value, tolerance) => Math.abs(value - estimate) <= tolerance * estimate;
  // (Only between lines of plain text: emoji and chips make a line taller.)
  const pitches = [];
  for (let i = 1; i < text.length; i++) {
    if (!text[i].blobs.length && !text[i - 1].blobs.length) pitches.push((text[i].baseline - text[i - 1].baseline) / LINE_PITCH);
  }
  const exact = pitches.slice(1).filter((pitch) => near(pitch, 0.2));
  if (pitches.length && pitches[0] >= 0.98 * estimate && pitches[0] <= 1.2 * estimate) exact.push(pitches[0]);
  const refined = exact.length ? Math.min(...exact) : estimate;
  // A spacing a little off a common scale (beside an emoji the line can be a pixel taller) gives way to the
  // x-height when that lands on a common scale close by.
  const snapped = nearestCommonScale(refined, exact.length ? 0.03 : 0.07) ?? nearestCommonScale(estimate, 0.07);
  return snapped && Math.abs(snapped - refined) <= 0.08 * refined ? snapped : Math.round(refined * 100) / 100;
}

/** The median of [value, weight] pairs. */
function weightedMedian(pairs) {
  const sorted = pairs.filter(([, w]) => w > 0).sort((a, b) => a[0] - b[0]);
  const total = sorted.reduce((sum, [, w]) => sum + w, 0);
  let seen = 0;
  for (const [value, w] of sorted) {
    seen += w;
    if (seen >= total / 2) return value;
  }
  return NaN;
}

/** The common display scale nearest `value`, if it is within `tolerance` (a fraction) of it. */
function nearestCommonScale(value, tolerance) {
  const nearest = COMMON_SCALES.reduce((a, b) => (Math.abs(b - value) < Math.abs(a - value) ? b : a));
  return Math.abs(nearest - value) <= tolerance * nearest ? nearest : null;
}


/** Splits the lines into comments wherever the gap between baselines is wider than within a comment. */
function groupComments(bands, scale, imageHeight, avatars) {
  if (avatars?.length) return groupByAvatar(bands, scale, imageHeight, avatars);
  const groups = [];
  let previous = null;
  for (const band of bands) {
    // Compare the lines' middles: emoji are centred on the middle of the x-height (vertical-align: middle, a
    // pixel higher for their -1px top margin), and so, near enough, is an owner's chip; a line without either
    // has its x-height's middle measured. (Bits of an emoji can make text rows of their own: blobs come first.)
    // A line cut off by the bottom edge shows only its top: capitals and ascenders reach ~6.8px above the
    // x-height's middle.
    const anchor = band.bottom >= imageHeight ? band.top + 6.8 * scale
      : band.blobs.length ? median(band.blobs.map((b) => b.box.y + b.box.height / 2)) + scale
        : Number.isFinite(band.baseline) ? band.baseline - (X_HEIGHT / 2) * scale : (band.top + band.bottom) / 2;
    if (previous === null || anchor - previous > NEW_COMMENT_PITCH * scale) groups.push({ bands: [] });
    groups.at(-1).bands.push(band);
    previous = anchor;
  }
  for (const group of groups) group.complete = group.bands[0].top > 0 && group.bands.at(-1).bottom < imageHeight;
  return groups;
}

/**
 * With avatars in the snip, each comment starts at its own: its first line begins near the avatar's top (a
 * single line is centred beside it, 2-6px lower). Lines above the first avatar belong to a comment cut off
 * at the top, and an avatar cut by the image's edge marks its comment as cut.
 */
function groupByAvatar(bands, scale, imageHeight, avatars) {
  const groups = [];
  for (const band of bands) {
    const start = avatars.find((a) => !a.taken && band.top >= a.top - 4 * scale && band.top <= a.top + 10 * scale);
    if (start || !groups.length) {
      if (start) start.taken = true;
      groups.push({ bands: [], avatar: start ?? null });
    }
    groups.at(-1).bands.push(band);
  }
  for (const group of groups) {
    const { avatar } = group;
    group.complete = Boolean(avatar) && avatar.top > 0 && avatar.bottom < imageHeight && group.bands.at(-1).bottom < imageHeight;
  }
  return groups;
}

/**
 * The widest gap (in empty columns) still inside a word: letters are at most ~1.5px apart. A verified badge
 * is 3px or more from the name (at 1.25x: 2 columns inside words, 3 to the badge, 4 for a space).
 */
const joinGap = (scale) => Math.max(2, Math.round(1.6 * scale));

/** An owner's chip: a filled box about 20px tall (14px text plus 2px padding), wider than tall. */
const isChip = (b, scale) => b.height >= 16 * scale && b.height <= 24 * scale && b.width >= b.height;

/** Badges are 16px icons, about 14px of ink: taller than any letter, about as wide as tall. */
function isBadge(b, scale, kind = 'text') {
  if (kind === 'badge') return true;
  const sized = b.height >= 11.5 * scale && b.height <= 17.5 * scale && b.width >= 9.5 * scale && b.width <= 17.5 * scale;
  return sized && Math.abs(b.width - b.height) <= 0.3 * b.height;
}

function nameStyle(ink, background, hasBadge) {
  const [r, g, b] = ink;
  let role = 'viewer';
  if (chroma(ink) >= 50) role = b > r && b > g - 20 ? 'moderator' : g > r && g > b ? 'member' : 'viewer';
  return { role, verified: hasBadge && role === 'viewer' };
}

/** A message line from a band's words: runs of text words (one OCR region each) and emoji, in order. */
function lineOf(page, band, words, scale) {
  if (!words.length) return null;
  const items = [];
  for (const word of words) {
    // Message text is never coloured, so a tinted word is (part of) an emoji: one too small to be a blob,
    // like ✨, or the pieces of one that the background's colour cuts apart.
    const emoji = word.kind === 'blob' || word.box.height >= BLOB * scale || (word.tint >= 45 && word.box.height >= 5 * scale);
    const previous = items.at(-1);
    if (emoji && previous?.type === 'emoji' && word.box.x - right(previous.box) <= 3 * scale
      && right(word.box) - previous.box.x <= (EMOJI + 2) * scale) {
      previous.box = union(previous.box, word.box);
    } else if (emoji) items.push({ type: 'emoji', box: word.box });
    else if (previous?.type === 'text') previous.words.push(word);
    else items.push({ type: 'text', words: [word] });
  }
  return {
    box: words.map((w) => w.box).reduce(union),
    baseline: band.baseline,
    items: items.map((item) => (item.type === 'emoji' ? item : { type: 'text', ...page.textRegion(item.words, band.baseline) })),
  };
}
