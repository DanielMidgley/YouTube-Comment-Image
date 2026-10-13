// Bytes as text, for the panel's <img> of the frame (a data: URL): UXP has no btoa() to count on.

const DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** `bytes` (an ArrayBuffer or a typed array) in base64. */
function base64(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength);
  const parts = [];
  // A piece at a time: one string per byte of a 20 MB frame would be slow.
  for (let start = 0; start < data.length; start += 3 * 4096) {
    const end = Math.min(data.length, start + 3 * 4096);
    let piece = '';
    for (let i = start; i < end; i += 3) {
      const a = data[i];
      const b = i + 1 < end ? data[i + 1] : 0;
      const c = i + 2 < end ? data[i + 2] : 0;
      piece += DIGITS[a >> 2] + DIGITS[((a & 3) << 4) | (b >> 4)]
        + (i + 1 < end ? DIGITS[((b & 15) << 2) | (c >> 6)] : '=') + (i + 2 < end ? DIGITS[c & 63] : '=');
    }
    parts.push(piece);
  }
  return parts.join('');
}

module.exports = { base64 };
