// Splits chat text into text and emoji runs the way YouTube live chat shows it: every emoji is drawn
// as an image of Google's Noto emoji artwork (served from fonts.gstatic.com), everything else is text.

const RGI_EMOJI = /^\p{RGI_Emoji}$/v;
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

// The version YouTube's chat requests; 'latest' serves different (newer) artwork.
export const NOTO_EMOJI_BASE = 'https://fonts.gstatic.com/s/e/notoemoji/15.1';

export const isEmoji = (grapheme) => RGI_EMOJI.test(grapheme);

/** Noto's name for an emoji: hex code points (at least 4 digits) joined by '_', without U+FE0F. */
export function emojiCode(emoji) {
  return [...emoji]
    .map((char) => char.codePointAt(0))
    .filter((codePoint) => codePoint !== 0xfe0f)
    .map((codePoint) => codePoint.toString(16).padStart(4, '0'))
    .join('_');
}

export const emojiUrl = (emoji, base = NOTO_EMOJI_BASE) => `${base}/${emojiCode(emoji)}/72.png`;

/** Returns [{ type: 'text', text } | { type: 'emoji', emoji }] in order, merging adjacent text. */
export function splitEmoji(text) {
  const runs = [];
  for (const { segment } of graphemes.segment(text)) {
    const last = runs.at(-1);
    if (isEmoji(segment)) runs.push({ type: 'emoji', emoji: segment });
    else if (last?.type === 'text') last.text += segment;
    else runs.push({ type: 'text', text: segment });
  }
  return runs;
}
