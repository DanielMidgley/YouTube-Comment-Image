// Reads a comment's name and message from a screenshot for the editor: decodes the image, starts the text
// recognizer on first use (Tesseract in a worker, a fraction of a second) and lets it go after a while
// unused, and runs src/screenshot/read.js.
import { createRecognizer } from '../screenshot/ocr.js';
import { readComment } from '../screenshot/read.js';

// The open dialog's cap (MAX_SCREENSHOT_BYTES in electron/main.js), applied to pasted and dropped files too.
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_PIXELS = 40_000_000; // a few 4K screens' worth; a snip of a comment is far smaller
const HEADER_BYTES = 256 * 1024; // where an image file gives its size (a JPEG's can follow its metadata)
const IDLE_MS = 2 * 60 * 1000; // the recognizer's worker holds the model and Tesseract's memory: let it go when idle
const DOUBTFUL_SHOWN = 5; // words named in the status line; the rest are counted
const NOT_AN_IMAGE = "That file isn't an image the app can open (try a PNG or JPEG screenshot).";

let recognizer = null; // Promise<Recognizer>
let idleTimer = 0;
let running = 0;

/**
 * Reads the comment in `blob` (an image file). Resolves to readComment()'s result; rejects with an Error whose
 * message is meant for the user. onProgress(text) reports slow steps (starting the recognizer). Aborting
 * `signal` rejects with its reason, at once if the read is waiting for the text recognition.
 */
export async function readScreenshot(blob, { onProgress, signal } = {}) {
  signal?.throwIfAborted();
  const image = await decode(blob);
  signal?.throwIfAborted();
  running++;
  clearTimeout(idleTimer);
  try {
    const starting = startRecognizer(onProgress);
    const ocr = await starting;
    signal?.throwIfAborted();
    onProgress?.('Reading the comment…');
    // Cancelling lets the worker go (see cancellable), unless another read is using it too.
    const stop = () => { if (running === 1) stopRecognizer(starting); };
    const recognize = (grey, options) => cancellable(ocr.recognize(grey, options), signal, stop);
    return await readComment(image, { recognize, signal });
  } finally {
    if (!--running) idleTimer = setTimeout(stopRecognizer, IDLE_MS);
  }
}

/**
 * The status line for a reading that found the name, the message or both (`name` and `message` as filled in,
 * empty when unread): what was filled in, what was kept, the words to double-check (each named once, five at
 * most, the rest counted) and the reader's warnings.
 */
export function describeReading({ name, message, doubtful = [], warnings = [] }) {
  const [filled, kept] = name && message ? ['name and message', null] : name ? ['name', 'message'] : ['message', 'name'];
  const notes = [`Filled in the ${filled} from the screenshot.`];
  if (kept) notes.push(`The ${kept} couldn't be read, so yours is kept.`);
  const words = [...new Set(doubtful.filter(Boolean))];
  if (words.length) {
    const more = words.length - DOUBTFUL_SHOWN;
    const named = words.slice(0, DOUBTFUL_SHOWN).map((word) => `“${word}”`).join(', ');
    notes.push(`Check ${named}${more > 0 ? ` and ${more} more` : ''}: hard to read.`);
  }
  return [...notes, ...warnings].join(' ');
}

/** The image's pixels (on white, so a transparent PNG still has a background). */
async function decode(blob) {
  if (blob.size > MAX_BYTES) throw new Error('That file is too big to be a screenshot of a comment.');
  const url = URL.createObjectURL(blob);
  try {
    // The size first: an <img> has it from the header and decodes the pixels only when they are used, while a
    // small file can hold a huge image (a 0.5 MB PNG of 23000 × 23000 px is 2 GB decoded). Chromium refuses an
    // image too big to decode at all (over about 537 million pixels) as a broken one: the header tells which.
    const image = await loadImage(url);
    // (A file that can no longer be read, deleted or offline since it was chosen, fails here too.)
    const size = image ? { width: image.naturalWidth, height: image.naturalHeight } : await headerSize(blob).catch(() => {
      throw new Error("That file couldn't be read.");
    });
    if (size && size.width * size.height > MAX_PIXELS) {
      throw new Error(`That image is ${size.width} × ${size.height} px; crop it to the comment first.`);
    }
    if (!image || !size.width || !size.height) throw new Error(NOT_AN_IMAGE);
    return await pixels(image);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The image at `url` once its header has been read, or null when Chromium can't open it. */
function loadImage(url) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

async function pixels(image) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(image);
  } catch {
    throw new Error(NOT_AN_IMAGE);
  }
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.fillStyle = '#fff';
    context.fillRect(0, 0, bitmap.width, bitmap.height);
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

/** The width and height in the header of a PNG, JPEG, GIF, BMP or extended WebP file (null for anything else). */
async function headerSize(blob) {
  const view = new DataView(await blob.slice(0, HEADER_BYTES).arrayBuffer());
  const has = (end) => view.byteLength >= end;
  const text = (at, length) => (has(at + length) ? String.fromCharCode(...new Uint8Array(view.buffer, at, length)) : '');
  const uint24 = (at) => view.getUint16(at, true) + view.getUint8(at + 2) * 0x10000;
  if (text(1, 3) === 'PNG' && text(12, 4) === 'IHDR' && has(24)) return { width: view.getUint32(16), height: view.getUint32(20) };
  if (text(0, 3) === 'GIF' && has(10)) return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  if (text(0, 2) === 'BM' && has(26) && view.getUint32(14, true) >= 40) {
    return { width: Math.abs(view.getInt32(18, true)), height: Math.abs(view.getInt32(22, true)) };
  }
  if (text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP' && text(12, 4) === 'VP8X' && has(30)) {
    return { width: uint24(24) + 1, height: uint24(27) + 1 };
  }
  if (has(2) && view.getUint16(0) === 0xffd8) {
    // Segments follow the start of image: FF, the marker and (for these) a length. A start of frame (C0–CF
    // but C4, C8 and CC) holds the size.
    for (let at = 2; has(at + 9) && view.getUint8(at) === 0xff;) {
      const marker = view.getUint8(at + 1);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: view.getUint16(at + 7), height: view.getUint16(at + 5) };
      }
      at += marker === 0xff ? 1 : 2 + view.getUint16(at + 2); // FF FF: padding before a marker
    }
  }
  return null;
}

/**
 * `recognizing` (a call to the recognizer), rejected as soon as `signal` aborts. Tesseract would finish the crop
 * first, which can take a minute (a photo read as one huge word), and the next read's calls would wait behind
 * it: `stop` lets the worker go instead, so the next read starts a fresh one.
 */
function cancellable(recognizing, signal, stop) {
  if (!signal) return recognizing;
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => {
      stop();
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([recognizing, aborted]).finally(() => signal.removeEventListener('abort', onAbort));
}

function startRecognizer(onProgress) {
  if (!recognizer) {
    onProgress?.('Starting text recognition…');
    recognizer = createRecognizer().catch((error) => {
      recognizer = null; // let the next attempt start afresh
      throw error; // "Could not start text recognition: …"
    });
  }
  return recognizer;
}

/** Stops `which` (by default the current recognizer); calls still waiting on it reject. */
function stopRecognizer(which = recognizer) {
  if (which === recognizer) recognizer = null;
  which?.then((ocr) => ocr.terminate()).catch(() => {});
}
