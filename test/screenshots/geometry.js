// Geometry of a rendered comment: the boxes ({ x, y, width, height }) of its parts, measured by the stage page
// in CSS px and carried into the device pixels of the final image through every transform (crop, stack cut,
// pad, resample) exactly as the pixels themselves are moved.

/** Applies `fn` to every box of one comment's geometry; null boxes stay null. Keeps the manifest's key order. */
export function mapBoxes(geometry, fn) {
  const box = (value) => (value ? fn(value) : null);
  return {
    row: box(geometry.row),
    avatar: box(geometry.avatar),
    timestamp: box(geometry.timestamp),
    nameChip: box(geometry.nameChip),
    nameText: box(geometry.nameText),
    badges: geometry.badges.map((badge) => ({ type: badge.type, box: fn(badge.box) })),
    message: box(geometry.message),
    lines: geometry.lines.map((line) => ({ box: fn(line.box), text: line.text })),
    emoji: geometry.emoji.map((item) => ({ box: fn(item.box), emoji: item.emoji, ...(item.fallback ? { fallback: true } : {}) })),
  };
}

/**
 * CSS px → device px of a capture: the crop of electron/capture.js takes device pixels from
 * round(x·scale) on, so a CSS position p lands at p·scale − crop.x.
 */
export const toDevice = (scale, crop) => (box) => ({
  x: box.x * scale - crop.x, y: box.y * scale - crop.y, width: box.width * scale, height: box.height * scale,
});
export const shift = (dx, dy) => (box) => ({ x: box.x + dx, y: box.y + dy, width: box.width, height: box.height });
export const stretch = (sx, sy) => (box) => ({ x: box.x * sx, y: box.y * sy, width: box.width * sx, height: box.height * sy });

const r2 = (value) => Math.round(value * 100) / 100 || 0; // `|| 0` turns -0 into 0
export const rounded = (box) => ({ x: r2(box.x), y: r2(box.y), width: r2(box.width), height: r2(box.height) });

/** What a reader reads (timestamp, name chip, badges, message lines, emoji); the avatar is not part of it. */
export function contentBoxes(geometry) {
  return [
    geometry.timestamp, geometry.nameChip, ...geometry.badges.map((b) => b.box),
    ...geometry.lines.map((l) => l.box), ...geometry.emoji.map((e) => e.box),
  ].filter(Boolean);
}

export const insideImage = (box, width, height, tolerance = 0.01) => box.x >= -tolerance && box.y >= -tolerance
  && box.x + box.width <= width + tolerance && box.y + box.height <= height + tolerance;

export const overlapsImage = (box, width, height) => box.x < width && box.y < height && box.x + box.width > 0 && box.y + box.height > 0;

export const contains = (outer, inner, tolerance = 0) => inner.x >= outer.x - tolerance && inner.y >= outer.y - tolerance
  && inner.x + inner.width <= outer.x + outer.width + tolerance && inner.y + inner.height <= outer.y + outer.height + tolerance;
