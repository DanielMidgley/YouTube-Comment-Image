// The panel's arithmetic, with no Premiere Pro or UXP in it (test/unit/premiere-plugin.test.js runs it in
// Node): where the frame shows on the panel and which pixels a drag covers, and the labels and names the panel
// gives things. Boxes are { x, y, width, height }.

/** How `view` (the part of the frame on show, in frame px) fits `width` CSS px of the panel. */
function fitView(view, width) {
  const scale = width / view.width;
  return { scale, width, height: view.height * scale };
}

/** The frame point under (x, y) CSS px of the shown view. */
function toFrame(view, fit, x, y) {
  return { x: view.x + x / fit.scale, y: view.y + y / fit.scale };
}

/** `box` (frame px) where it shows on the panel, in CSS px from the view's top-left. */
function toPanel(view, fit, box) {
  return {
    left: (box.x - view.x) * fit.scale,
    top: (box.y - view.y) * fit.scale,
    width: box.width * fit.scale,
    height: box.height * fit.scale,
  };
}

/** The box a drag from frame point `a` to `b` covers: whole pixels, inside the frame. */
function boxBetween(a, b, frame) {
  const clampX = (v) => Math.min(frame.width, Math.max(0, v));
  const clampY = (v) => Math.min(frame.height, Math.max(0, v));
  const left = Math.floor(clampX(Math.min(a.x, b.x)));
  const top = Math.floor(clampY(Math.min(a.y, b.y)));
  const right = Math.ceil(clampX(Math.max(a.x, b.x)));
  const bottom = Math.ceil(clampY(Math.max(a.y, b.y)));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * The view that shows `box` (a drag around the chat, say) large: the box and a margin around it, at the frame's
 * own proportions where the box is wide, never past the frame's edges.
 */
function zoomTo(box, frame, margin = 0.15) {
  let width = Math.max(box.width * (1 + 2 * margin), 32);
  let height = Math.max(box.height * (1 + 2 * margin), 32);
  // A thin box (one comment) gets some height around it, so the view isn't a sliver.
  height = Math.max(height, width / 4);
  width = Math.min(width, frame.width);
  height = Math.min(height, frame.height);
  const x = Math.min(frame.width - width, Math.max(0, box.x + box.width / 2 - width / 2));
  const y = Math.min(frame.height - height, Math.max(0, box.y + box.height / 2 - height / 2));
  return { x, y, width, height };
}

/** Frames per second from a sequence's timebase (ticks per frame; Premiere counts 254 016 000 000 a second). */
function framesPerSecond(timebase) {
  const ticks = Number(timebase);
  return ticks > 0 ? 254016000000 / ticks : 30;
}

/**
 * The timecode Premiere Pro shows for `seconds` into a sequence of `fps` frames a second that starts at `start`
 * seconds (its zero point): 'HH:MM:SS:FF', or 'HH:MM:SS;FF' counted drop-frame (29.97 and 59.94 fps), which
 * skips 2 (or 4) frame numbers each minute but every tenth.
 */
function timecode(seconds, fps, { start = 0, dropFrame = false } = {}) {
  const rate = Math.max(1, Math.round(fps));
  let frames = Math.max(0, Math.round((seconds + start) * fps));
  const two = (n) => String(n).padStart(2, '0');
  const drop = dropFrame && (rate === 30 || rate === 60) ? rate / 15 : 0;
  if (drop) {
    const perTenMinutes = rate * 600 - drop * 9;
    const perMinute = rate * 60 - drop;
    const tens = Math.floor(frames / perTenMinutes);
    const rest = frames % perTenMinutes;
    frames += drop * 9 * tens + (rest > drop ? drop * Math.floor((rest - drop) / perMinute) : 0);
  }
  const ff = frames % rate;
  const total = Math.floor(frames / rate);
  return `${two(Math.floor(total / 3600))}:${two(Math.floor(total / 60) % 60)}:${two(total % 60)}${drop ? ';' : ':'}${two(ff)}`;
}

/** A file name for a comment by `name` ('@Some Name!' → 'comment-some-name-20261011-153012.png'). */
function fileNameFor(name, kind, date) {
  const slug = String(name ?? '').normalize('NFKC').replace(/^\s*@+/u, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'comment';
  const two = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
  return `comment-${slug}-${stamp}.${kind === 'mp4' ? 'mp4' : 'png'}`;
}

module.exports = { boxBetween, fileNameFor, fitView, framesPerSecond, timecode, toFrame, toPanel, zoomTo };
