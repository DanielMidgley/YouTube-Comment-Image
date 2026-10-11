// The app's text recognizer (src/screenshot/ocr.js) on Node's build of tesseract.js, for evaluation scripts
// that read many crops without starting Electron: the same Tesseract parameters, model and result shape. Only
// the worker differs, a worker thread running the Node build's own worker script, which loads the full core
// (the legacy engine is in it, unused) where the app loads the LSTM-only one. test/smoke/ocr.js checks that
// both give the same results.
import tesseract from 'tesseract.js';
import { fileURLToPath } from 'node:url';
import { startRecognizer } from '../../src/screenshot/ocr.js';

// Node's tesseract.js reads a local folder with fs; a file: URL would go to fetch(), which cannot read files.
const LANG_PATH = fileURLToPath(new URL('../../node_modules/@tesseract.js-data/eng/4.0.0_best_int', import.meta.url));

/** createRecognizer() from src/screenshot/ocr.js, running in Node: same options, same Recognizer. */
export async function createNodeRecognizer({ dictionary = true, onProgress } = {}) {
  return startRecognizer(tesseract, { langPath: LANG_PATH }, { dictionary, onProgress });
}
