// Plain BGRA bitmaps ({ width, height, data }, the layout nativeImage.toBitmap() gives on Windows) and the
// few operations the corpus needs on them: crop, pad, measure ink, and draw debug outlines. Pure JS, so the
// pixels a case is made of never depend on an encoder's choices until the final file is written.

export function createBitmap(width, height, [r, g, b] = [0, 0, 0]) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = b;
    data[i + 1] = g;
    data[i + 2] = r;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

/** Copies the whole-pixel `rect` (which must lie inside the bitmap) into a new bitmap. */
export function crop(bitmap, { x, y, width, height }) {
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > bitmap.width || y + height > bitmap.height) {
    throw new RangeError(`crop: ${width}×${height} at (${x}, ${y}) is outside the ${bitmap.width}×${bitmap.height} bitmap.`);
  }
  const out = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row++) {
    const from = ((y + row) * bitmap.width + x) * 4;
    bitmap.data.copy(out, row * width * 4, from, from + width * 4);
  }
  return { width, height, data: out };
}

/** The bitmap with `color` added around it ({ left, top, right, bottom } whole pixels). */
export function pad(bitmap, { left, top, right, bottom }, color) {
  const out = createBitmap(bitmap.width + left + right, bitmap.height + top + bottom, color);
  for (let row = 0; row < bitmap.height; row++) {
    const from = row * bitmap.width * 4;
    bitmap.data.copy(out.data, ((top + row) * out.width + left) * 4, from, from + bitmap.width * 4);
  }
  return out;
}

export function pixel(bitmap, x, y) {
  const at = (y * bitmap.width + x) * 4;
  return [bitmap.data[at + 2], bitmap.data[at + 1], bitmap.data[at]];
}

/** The whole pixels a box covers at least partly, clipped to the bitmap (null if none). */
export function pixelSpan(bitmap, box) {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(bitmap.width, Math.ceil(box.x + box.width));
  const y1 = Math.min(bitmap.height, Math.ceil(box.y + box.height));
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
}

/**
 * How many pixels of `box` differ from `background` by more than `threshold` (sum of the channel
 * differences). Pixels touching any of the `exclude` boxes are not counted.
 */
export function inkCount(bitmap, box, background, threshold, { exclude = [] } = {}) {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(bitmap.width, Math.ceil(box.x + box.width));
  const y1 = Math.min(bitmap.height, Math.ceil(box.y + box.height));
  const excluded = (x, y) => exclude.some((b) => x + 1 > b.x && x < b.x + b.width && y + 1 > b.y && y < b.y + b.height);
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (exclude.length && excluded(x, y)) continue;
      const at = (y * bitmap.width + x) * 4;
      const diff = Math.abs(bitmap.data[at + 2] - background[0]) + Math.abs(bitmap.data[at + 1] - background[1])
        + Math.abs(bitmap.data[at] - background[2]);
      if (diff > threshold) count++;
    }
  }
  return count;
}

/** The most common colour in `box` (clipped to the bitmap); null if the box covers no pixel. */
export function dominantColor(bitmap, box) {
  const span = pixelSpan(bitmap, box);
  if (!span) return null;
  const counts = new Map();
  for (let y = span.y0; y < span.y1; y++) {
    for (let x = span.x0; x < span.x1; x++) {
      const key = bitmap.data.readUInt32LE((y * bitmap.width + x) * 4) & 0xffffff;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let best = 0;
  let bestCount = -1;
  for (const [key, count] of counts) if (count > bestCount) [best, bestCount] = [key, count];
  return [(best >> 16) & 0xff, (best >> 8) & 0xff, best & 0xff];
}

/** Nearest-neighbour enlargement by a whole factor (debug overlays). */
export function enlarge(bitmap, factor) {
  const width = bitmap.width * factor;
  const height = bitmap.height * factor;
  const data = Buffer.alloc(width * height * 4);
  const rowBytes = width * 4;
  for (let y = 0; y < bitmap.height; y++) {
    const first = y * factor * rowBytes;
    for (let x = 0; x < bitmap.width; x++) {
      const from = (y * bitmap.width + x) * 4;
      for (let i = 0; i < factor; i++) bitmap.data.copy(data, first + (x * factor + i) * 4, from, from + 4);
    }
    for (let i = 1; i < factor; i++) data.copy(data, first + i * rowBytes, first, first + rowBytes);
  }
  return { width, height, data };
}

/** Draws the outline of `box` (in this bitmap's pixels, rounded outward) in `color`, clipped to the bitmap. */
export function strokeRect(bitmap, box, [r, g, b]) {
  const left = Math.floor(box.x);
  const top = Math.floor(box.y);
  const right = Math.ceil(box.x + box.width) - 1;
  const bottom = Math.ceil(box.y + box.height) - 1;
  const put = (x, y) => {
    if (x < 0 || y < 0 || x >= bitmap.width || y >= bitmap.height) return;
    const at = (y * bitmap.width + x) * 4;
    bitmap.data[at] = b;
    bitmap.data[at + 1] = g;
    bitmap.data[at + 2] = r;
    bitmap.data[at + 3] = 255;
  };
  for (let x = left; x <= right; x++) {
    put(x, top);
    put(x, bottom);
  }
  for (let y = top; y <= bottom; y++) {
    put(left, y);
    put(right, y);
  }
}
