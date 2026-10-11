// Tidies what OCR reads from a chat comment, using what YouTube allows: handles have no spaces and only
// letters, digits and _ - . ·; chat messages are one line of text with single spaces.

// Tesseract reads a handle's '@' as © or ® now and then, or adds a stray bracket before it.
const LEADING_AT = /^[\s([{|'"`]*[@©®](?:\))?/u;
const NOT_IN_HANDLE = /[^\p{L}\p{M}\p{N}_.\-·]/gu;

/** The author's name: an @handle (no spaces, only handle characters) or an older display name. */
export function cleanName(text) {
  const name = text.replace(/\s+/g, ' ').trim();
  if (!LEADING_AT.test(name)) return name;
  const handle = name.replace(LEADING_AT, '').replace(/\|/g, 'l').replace(NOT_IN_HANDLE, '');
  return `@${handle}`;
}

/** The message: single spaces, no leading or trailing ones. (glyphs.js settles straight and curly quotes.) */
export function cleanMessage(text) {
  return text.replace(/\s+/g, ' ').trim();
}
