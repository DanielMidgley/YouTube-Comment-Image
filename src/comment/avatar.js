// Avatar and member-badge images, prepared the way YouTube serves them to the live chat (browser ES module,
// uses canvas). Chat avatars are drawn at 24 CSS px from a 32 px image (s32) on displays up to 4/3 device
// px per CSS px and from a 64 px one (s64) above; member badges come as 16 px and 32 px images.

export const AVATAR_SIZES = [32, 64];
export const BADGE_SIZES = [16, 32];

/** Which avatar image YouTube would load at `scale` device px per CSS px. */
export const avatarSizeFor = (scale) => (scale <= 4 / 3 ? 32 : 64);
/** Which member badge image YouTube would load at `scale`. */
export const badgeSizeFor = (scale) => (scale <= 1 ? 16 : 32);

/** Material 700 colours of YouTube's default letter avatars. */
export const DEFAULT_AVATAR_COLORS = [
  '#D32F2F', '#C2185B', '#7B1FA2', '#512DA8', '#303F9F', '#1976D2', '#0288D1', '#0097A7',
  '#00796B', '#388E3C', '#689F38', '#F57C00', '#E64A19', '#5D4037', '#616161', '#455A64',
];
export const DEFAULT_AVATAR_COLOR_NAMES = [
  'Red', 'Pink', 'Purple', 'Deep purple', 'Indigo', 'Blue', 'Light blue', 'Cyan',
  'Teal', 'Green', 'Light green', 'Orange', 'Deep orange', 'Brown', 'Grey', 'Blue grey',
];

const MAX_FILE_BYTES = 40 * 1024 * 1024;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** A palette colour picked by a stable hash (FNV-1a) of the name, so a name always gets the same colour. */
export function pickAvatarColor(name) {
  const text = String(name ?? '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return DEFAULT_AVATAR_COLORS[hash % DEFAULT_AVATAR_COLORS.length];
}

/** First grapheme of the name after a leading '@' (and whitespace), as a capital; '?' if there is none. */
export function avatarInitial(name) {
  const text = String(name ?? '').replace(/^\s*@?\s*/u, '');
  const first = graphemes.segment(text)[Symbol.iterator]().next().value?.segment;
  if (!first) return '?';
  const upper = first.toLocaleUpperCase();
  // Some capitals are two letters ('ß' → 'SS'); an avatar shows one, so keep the original then.
  return [...graphemes.segment(upper)].length === 1 ? upper : first;
}

/**
 * YouTube's default avatar as a PNG data URL: a square fully filled with `color` (the circle comes from the
 * chat's CSS), with the white capital initial in Roboto 400 at 0.53 × the size (cap height ≈ 12/32 of it),
 * centred horizontally on its ink and vertically on the cap height, so every capital shares one baseline.
 */
export async function makeDefaultAvatar({ name, color, size = 32 } = {}) {
  const initial = avatarInitial(name);
  const font = `400 ${size * 0.53}px Roboto, Arial, sans-serif`;
  try {
    await document.fonts.load(font, initial);
  } catch {
    // Fall back to whatever the canvas has; a missing font must not block the avatar.
  }
  const canvas = createCanvas(size);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = color || pickAvatarColor(name);
  ctx.fillRect(0, 0, size, size);

  ctx.font = font;
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const ink = ctx.measureText(initial);
  const x = (size - (ink.actualBoundingBoxLeft + ink.actualBoundingBoxRight)) / 2 + ink.actualBoundingBoxLeft;
  let y;
  if (/^[\p{Lu}\p{Lt}\p{Nd}]\p{M}*$/u.test(initial)) {
    y = (size + ctx.measureText('H').actualBoundingBoxAscent) / 2;
  } else {
    // Uncased scripts, symbols, emoji: centre the glyph's own ink.
    y = (size - (ink.actualBoundingBoxAscent + ink.actualBoundingBoxDescent)) / 2 + ink.actualBoundingBoxAscent;
  }
  ctx.fillText(initial, x, y);
  return canvas.toDataURL('image/png');
}

/** An uploaded avatar as { 32: dataUrl, 64: dataUrl }: centre-cropped square, transparency on white. */
export function prepareAvatar(blob) {
  return prepareSizes(blob, AVATAR_SIZES, { background: '#fff' });
}

/** An uploaded member badge as { 16: dataUrl, 32: dataUrl }: centre-cropped square, transparency kept. */
export function prepareBadge(blob) {
  return prepareSizes(blob, BADGE_SIZES, { background: null });
}

/**
 * One image as a square PNG data URL of `size` px: centre-cropped, resampled with high quality (halving
 * steps when shrinking a lot), optionally composited onto `background`. A source that is already exactly
 * that size is copied 1:1: as its original file when that is a JPEG or (without a background) a static PNG,
 * otherwise by an unscaled canvas draw.
 */
export async function normalizeImage(blob, size, { background = null } = {}) {
  return (await prepareSizes(blob, [size], { background }))[size];
}

async function prepareSizes(blob, sizes, { background }) {
  if (!(blob instanceof Blob)) throw new TypeError('Expected an image file.');
  const label = blob.name ? `“${blob.name}”` : 'That file';
  if (blob.type && !blob.type.startsWith('image/')) throw new Error(`${label} is not an image.`);
  if (blob.size > MAX_FILE_BYTES) throw new Error(`${label} is too large (over 40 MB).`);

  const source = await decode(blob, label);
  try {
    const width = source.naturalWidth ?? source.width;
    const height = source.naturalHeight ?? source.height;
    const side = Math.min(width, height) || Math.max(...sizes); // SVGs without intrinsic size: just draw it
    // Whole-pixel offsets: a half-pixel crop would resample every pixel, even at 1:1.
    const crop = width && height
      ? { x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), side }
      : { x: 0, y: 0, side, whole: true };
    // The file itself can be used as is when it is already the right square size, cannot animate, and
    // compositing onto the background would not change a pixel (JPEG has no transparency).
    const keepable = blob.type === 'image/jpeg' || (!background && blob.type === 'image/png' && !(await isAnimatedPng(blob)));

    const result = {};
    for (const size of sizes) {
      result[size] = keepable && width === size && height === size
        ? await readAsDataUrl(blob)
        : resample(source, crop, size, background).toDataURL('image/png');
    }
    return result;
  } finally {
    source.close?.();
  }
}

async function decode(blob, label) {
  try {
    return await createImageBitmap(blob);
  } catch {
    // SVG (and a few other formats) only decode through <img>.
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } catch {
    throw new Error(`${label} isn't an image this app can read (PNG, JPEG, GIF, WebP, AVIF, BMP or SVG).`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Draws the crop of `source` into a size×size canvas, halving in steps so large shrinks stay smooth. */
function resample(source, crop, size, background) {
  let current = source;
  let region = crop.whole ? null : { x: crop.x, y: crop.y, side: crop.side };
  let side = crop.side;
  // Halve until one more step reaches the target: each draw then shrinks by less than 2×.
  while (region && side / 2 > size) {
    const next = Math.ceil(side / 2);
    const step = createCanvas(next);
    draw(step.getContext('2d'), current, region, next);
    current = step;
    region = { x: 0, y: 0, side: next };
    side = next;
  }
  const canvas = createCanvas(size);
  const ctx = canvas.getContext('2d');
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, size, size);
  }
  draw(ctx, current, region, size);
  return canvas;
}

function draw(ctx, image, region, size) {
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (region) ctx.drawImage(image, region.x, region.y, region.side, region.side, 0, 0, size, size);
  else ctx.drawImage(image, 0, 0, size, size);
}

function createCanvas(size) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

/** APNGs carry an 'acTL' chunk before the image data. */
async function isAnimatedPng(blob) {
  const head = new Uint8Array(await blob.slice(0, 64 * 1024).arrayBuffer());
  for (let i = 8; i + 8 <= head.length;) {
    const length = ((head[i] << 24) | (head[i + 1] << 16) | (head[i + 2] << 8) | head[i + 3]) >>> 0;
    const type = String.fromCharCode(head[i + 4], head[i + 5], head[i + 6], head[i + 7]);
    if (type === 'acTL') return true;
    if (type === 'IDAT') return false;
    i += 12 + length;
  }
  return false;
}

function readAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file.'));
    reader.readAsDataURL(blob);
  });
}
