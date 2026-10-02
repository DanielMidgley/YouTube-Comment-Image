// Timing of the typing animation (video export and its preview): which part of the message each frame
// shows. Characters are graphemes, so an emoji or an accented letter appears as one keystroke.

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

export const TYPING = {
  cps: { min: 1, max: 60, default: 15 }, // characters per second
  leadIn: { min: 0, max: 5, default: 0.5 }, // seconds before the first character
  hold: { min: 0, max: 10, default: 2 }, // seconds the finished comment stays
  fps: [30, 60],
};

export const splitGraphemes = (text) => Array.from(graphemes.segment(text), ({ segment }) => segment);

/** When the `index`-th character (0-based) appears, in seconds. */
export const appearTime = (index, { cps, leadIn }) => leadIn + index / cps;

/** How many of `count` characters are on screen `t` seconds into the animation. */
export const shownAt = (t, count, { cps, leadIn }) =>
  (t < leadIn ? 0 : Math.min(count, Math.floor((t - leadIn) * cps + 1e-9) + 1));

/**
 * The frames of a typing animation of `count` characters: element i is how many characters frame i shows.
 * The first character appears after `leadIn` seconds, then one every 1/`cps` seconds, and the finished
 * comment stays on screen for `hold` seconds (at least one frame).
 */
export function typingFrames(count, { cps, fps, leadIn, hold }) {
  const finished = count ? appearTime(count - 1, { cps, leadIn }) : leadIn;
  const total = Math.max(1, Math.ceil((finished + hold) * fps - 1e-9));
  const frames = new Array(total);
  for (let i = 0; i < total; i++) frames[i] = shownAt(i / fps, count, { cps, leadIn });
  frames[total - 1] = count; // the video always ends on the whole comment
  return frames;
}
