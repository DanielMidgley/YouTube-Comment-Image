// Splits chat text into text and emoji runs the way YouTube's live chat does (the emoji manager in its chat
// client, live_chat_polymer.js): every U+FE0F is dropped, then the text is matched against YouTube's own emoji
// set, longest first. Matches are drawn as images of Google's Noto artwork from fonts.gstatic.com; anything
// else, including emoji newer than YouTube's set, stays text.
import { YOUTUBE_EMOJI_CODES, YOUTUBE_EMOJI_VERSION } from './youtube-emoji.js';

export const NOTO_EMOJI_BASE = `https://fonts.gstatic.com/s/e/notoemoji/${YOUTUBE_EMOJI_VERSION}`;

const VARIATION_SELECTOR = String.fromCharCode(0xfe0f);
const BACKSLASH = String.fromCharCode(92);

const fromCode = (code) => String.fromCodePoint(...code.split('_').map((hex) => parseInt(hex, 16)));
const EMOJI = new Set(YOUTUBE_EMOJI_CODES.trim().split(/\s+/).map(fromCode));
// The expression YouTube builds: ids longest first, joined with '|', the one '*' (keycap 002a_20e3)
// escaped, flags 'gi'.
const PATTERN = new RegExp([...EMOJI].sort((a, b) => b.length - a.length).join('|').replace('*', `${BACKSLASH}*`), 'gi');

const withoutVariationSelectors = (text) => text.replaceAll(VARIATION_SELECTOR, '');

export const isEmoji = (text) => EMOJI.has(withoutVariationSelectors(text));

/** Noto's name for an emoji: hex code points (at least 4 digits) joined by '_', without U+FE0F. */
export function emojiCode(emoji) {
  return [...emoji]
    .map((char) => char.codePointAt(0))
    .filter((codePoint) => codePoint !== 0xfe0f)
    .map((codePoint) => codePoint.toString(16).padStart(4, '0'))
    .join('_');
}

export const emojiUrl = (emoji, base = NOTO_EMOJI_BASE) => `${base}/${emojiCode(emoji)}/72.png`;

/** Returns [{ type: 'text', text } | { type: 'emoji', emoji }] in order (U+FE0F removed, as YouTube does). */
export function splitEmoji(text) {
  const plain = withoutVariationSelectors(text);
  const runs = [];
  let from = 0;
  for (const match of plain.matchAll(PATTERN)) {
    if (match.index > from) runs.push({ type: 'text', text: plain.slice(from, match.index) });
    runs.push({ type: 'emoji', emoji: match[0] });
    from = match.index + match[0].length;
  }
  if (from < plain.length) runs.push({ type: 'text', text: plain.slice(from) });
  return runs;
}
