// Text limits shared by the editor (so its preview shows exactly what gets exported) and the main process
// (which enforces them on everything the renderer sends). Counted in code points; YouTube's own chat input
// allows 200 characters, the generous message limit just keeps renders bounded.
export const LIMITS = { name: 200, message: 1000, timestamp: 40 };

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

function codePoints(text) {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

/**
 * `text` cut to at most `max` code points, at a grapheme boundary so an emoji or a letter with its accents
 * is never split. Only looks at the start of the text, so huge inputs cost no more than short ones.
 */
export function capText(text, max) {
  if (text.length <= max) return text; // every code point takes at least one UTF-16 unit
  // max code points fit in 2·max UTF-16 units; the slack keeps the grapheme at the limit whole.
  const window = text.slice(0, 2 * max + 64);
  const truncated = window.length < text.length;
  let result = '';
  let count = 0;
  for (const { segment, index } of graphemes.segment(window)) {
    if (truncated && index + segment.length === window.length) break; // may have been cut by the slice
    const size = codePoints(segment);
    if (count + size > max) break;
    result += segment;
    count += size;
  }
  return result;
}
