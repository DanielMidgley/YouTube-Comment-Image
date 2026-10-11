// Debug overlays: a case's image, enlarged so 1 px outlines don't hide what they frame, with every box of
// its geometry drawn on top, one colour per kind. For checking by eye that the geometry lines up.
import { enlarge, strokeRect } from './bitmap.js';
import { stretch } from './geometry.js';

export const OVERLAY_COLORS = {
  row: [140, 140, 140],
  avatar: [255, 0, 255],
  message: [60, 120, 255],
  timestamp: [0, 200, 255],
  nameChip: [255, 210, 0],
  nameText: [255, 120, 0],
  badge: [0, 220, 0],
  line: [255, 40, 40],
  emoji: [0, 255, 170],
};

/** The overlay bitmap for `entry` drawn over its decoded image `bitmap`. */
export function drawOverlay(bitmap, entry) {
  const factor = Math.max(1, Math.min(4, Math.round(3 / entry.pixelScale)));
  const out = enlarge(bitmap, factor);
  const draw = (box, color) => { if (box) strokeRect(out, stretch(factor, factor)(box), color); };
  for (const { geometry: g } of entry.comments) {
    draw(g.row, OVERLAY_COLORS.row);
    draw(g.message, OVERLAY_COLORS.message);
    for (const line of g.lines) draw(line.box, OVERLAY_COLORS.line);
    draw(g.nameChip, OVERLAY_COLORS.nameChip);
    draw(g.nameText, OVERLAY_COLORS.nameText);
    draw(g.timestamp, OVERLAY_COLORS.timestamp);
    for (const badge of g.badges) draw(badge.box, OVERLAY_COLORS.badge);
    draw(g.avatar, OVERLAY_COLORS.avatar);
    for (const item of g.emoji) draw(item.box, OVERLAY_COLORS.emoji);
  }
  return out;
}
