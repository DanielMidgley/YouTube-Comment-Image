// Reads the text of one crop of a chat screenshot with Tesseract's LSTM engine (tesseract.js: Tesseract built
// as WebAssembly, run in a Web Worker). The caller does the image work: it finds the name and message lines,
// crops them, makes them black ink on white paper and upscales them. This module only turns such a crop into
// text, with boxes and confidences per word and per character.
//
// Everything comes from the app itself, over app://, so recognition works offline and never touches the
// network: tesseract.js's worker script, its WebAssembly core and the English model ship in node_modules
// (package.json "build" packs just those files), where tesseract.js would otherwise fetch all three from a
// CDN. The worker is created from its URL, not from a blob: URL (tesseract.js's default), because the editor's
// CSP only allows workers from 'self'. A worker's CSP comes with its script and app:// sends none, so the
// worker may compile the WebAssembly core while the page's CSP needs no 'wasm-unsafe-eval'.

const MODULES = new URL('../../node_modules/', import.meta.url);
const TESSERACT_MODULE = new URL('tesseract.js/dist/tesseract.esm.min.js', MODULES).href;

/** Where the browser build of tesseract.js finds its worker, its WebAssembly core and the model. */
const BROWSER_PATHS = {
  workerPath: new URL('tesseract.js/dist/worker.min.js', MODULES).href,
  // A folder rather than a file: the worker picks the relaxed-SIMD, SIMD or plain build of the LSTM-only core,
  // whichever the CPU supports (the *-lstm.wasm.js files, which carry their WebAssembly inline).
  corePath: new URL('tesseract.js-core/', MODULES).href,
  // "best_int": the LSTM model alone (no legacy engine), quantised to integers: 2.9 MB instead of 11 MB.
  langPath: new URL('@tesseract.js-data/eng/4.0.0_best_int/', MODULES).href,
};

/** Tesseract's page segmentation modes: what one crop holds. */
const SEGMENTATION = { line: '7', word: '8', block: '6' };

const LSTM_ONLY = 1; // Tesseract's OEM_LSTM_ONLY: the model has no legacy engine to combine with
// Starting (compiling the core, unpacking the model) takes about a tenth of a second; a start that never
// finishes means a file is missing or broken, so give up with an error rather than wait forever.
const START_TIMEOUT_MS = 30_000;
// Tesseract keeps coordinates in 16 bits and does not finish a crop just short of that limit: a line 32,760 px
// wide was still being read after 20 s (holding up every call queued behind it) where 32,740 px took 0.08 s, so
// stay well clear. The pixel cap keeps the image copies within the worker's memory.
const MAX_SIDE = 32_000;
const MAX_PIXELS = 25_000_000;
// A crop with no pixel darker than mid-grey has no ink. Tesseract would still answer for a single line or word
// (an empty crop reads as "I"), so such crops get the empty result that Tesseract gives for an empty block.
const INK_LEVEL = 128;

const OUTPUT = { text: true, blocks: true, hocr: true };

/**
 * Starts Tesseract in a Web Worker and resolves to a Recognizer:
 *   recognize(image, { mode = 'line' }) → Promise<{ text, confidence, words }>
 *     image: { width, height, data }, one byte per pixel (0 = black ink, 255 = white paper), already cropped,
 *       normalised and upscaled; mode: 'line' (one line of text), 'word' or 'block' (several lines). Read a
 *       lone @handle as a line too: Tesseract's single-word mode gets far more of them wrong.
 *     text: what Tesseract read (lines joined by "\n"); confidence: 0–100;
 *     words: [{ text, confidence, box, symbols: [{ text, confidence, box, choices? }] }], boxes
 *       { x, y, width, height } in image pixels, choices the alternatives Tesseract weighed for that character,
 *       best first, as [{ text, confidence }] (the character read is normally among them, not always first).
 *     Calls run one at a time, in order; a crop without ink resolves at once, as an empty reading.
 *   terminate() → Promise<void>: stops the worker; calls still waiting reject.
 * dictionary: false stops Tesseract favouring English words (and its punctuation and number patterns), for
 * text such as @handles that are not words. onProgress({ status, progress }) follows tesseract.js's progress
 * reports (progress from 0 to 1).
 */
export async function createRecognizer({ dictionary = true, onProgress } = {}) {
  // Loaded on first use, so the editor does not parse tesseract.js until someone reads a screenshot.
  const { default: tesseract } = await import(TESSERACT_MODULE).catch((error) => {
    throw ocrError('Could not start text recognition', error);
  });
  return startRecognizer(tesseract, { ...BROWSER_PATHS, workerBlobURL: false }, { dictionary, onProgress });
}

/**
 * createRecognizer() for any build of tesseract.js: `tesseract` is the module, `paths` its createWorker
 * options locating the worker, core and model. test/support/node-recognizer.js runs the Node build through
 * this, so evaluation scripts see exactly what the app sees.
 */
export async function startRecognizer(tesseract, paths, { dictionary = true, onProgress } = {}) {
  let starting = true;
  let failStart;
  const startFailed = new Promise((_, reject) => { failStart = reject; });
  const creating = tesseract.createWorker('eng', LSTM_ONLY, {
    ...paths,
    gzip: true,
    // The model is read from the app's own files, so a copy cached in IndexedDB (or, in Node, written to the
    // working directory) would only cost space and could outlive an update of the model.
    cacheMethod: 'none',
    logger: ({ status, progress }) => reportProgress(onProgress, { status, progress }),
    // Without a handler tesseract.js rethrows a failed job's message as an uncaught error (the job's promise
    // rejects as well). A failure while starting rejects only through here: loading the model and
    // initialising Tesseract happen inside createWorker, whose promise would then never settle.
    errorHandler: (reason) => { if (starting) failStart(reason); },
  }, tesseractParameters({ dictionary }));

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(`timed out after ${START_TIMEOUT_MS / 1000} s`), START_TIMEOUT_MS);
  });
  let worker;
  try {
    worker = await Promise.race([creating, startFailed, timeout]);
  } catch (reason) {
    // tesseract.js hands out the worker only once it has started: stop it if that still happens. (One that
    // failed to load the model never does, and lives on unreachable until the page goes.)
    creating.then((late) => late.terminate(), () => {});
    // A worker script that fails to load rejects with the message of its error event, which has none.
    throw ocrError('Could not start text recognition', reason ?? 'its worker script could not be loaded');
  } finally {
    starting = false;
    clearTimeout(timer);
  }

  let queue = Promise.resolve();
  let terminated = false;
  const waiting = new Set(); // calls not settled yet: { resolve, reject }

  async function run(call, bytes, segmentation) {
    if (!waiting.has(call)) return; // terminated while it waited
    try {
      const { data } = await worker.recognize(bytes, { tessedit_pageseg_mode: segmentation }, OUTPUT);
      call.resolve(toRecognition(data));
    } catch (reason) {
      call.reject(ocrError('Text recognition failed', reason));
    } finally {
      waiting.delete(call);
    }
  }

  return {
    recognize(image, { mode = 'line' } = {}) {
      if (terminated) return Promise.reject(new Error('Text recognition has been stopped.'));
      let bytes;
      try {
        if (!Object.hasOwn(SEGMENTATION, mode)) throw new TypeError(`Unknown recognition mode "${mode}": expected line, word or block.`);
        bytes = encodePgm(image);
      } catch (error) {
        return Promise.reject(error);
      }
      if (!hasInk(image)) return Promise.resolve({ text: '', confidence: 0, words: [] });
      return new Promise((resolve, reject) => {
        const call = { resolve, reject };
        waiting.add(call);
        queue = queue.then(() => run(call, bytes, SEGMENTATION[mode]));
      });
    },

    async terminate() {
      if (terminated) return;
      terminated = true;
      for (const call of waiting) call.reject(new Error('Text recognition was stopped before it finished.'));
      waiting.clear();
      await worker.terminate();
    },
  };
}

/**
 * Tesseract parameters for the whole session. They go in at initialisation: the dictionary switches only take
 * effect then. Values are strings, as in Tesseract's config files.
 */
function tesseractParameters({ dictionary }) {
  return {
    // The LSTM engine reads with the model's own lists (English words, punctuation and number patterns), which
    // pull uncertain readings towards them; lstm_use_matrix is the switch that loads them. load_system_dawg and
    // load_freq_dawg cannot do this: they belong to the legacy engine, whose lists this model does not contain
    // (turning them off changes no reading).
    lstm_use_matrix: dictionary ? '1' : '0',
    // The crops state no resolution, which Tesseract takes as 70 dpi (and warns about when a file states an
    // implausible one). 14px text upscaled about 3× is roughly 10pt type at 300 dpi, the size its heuristics
    // expect; on the test crops the readings are the same either way.
    user_defined_dpi: '300',
    // YouTube collapses runs of spaces (its message has white-space: normal), so a wider gap in a crop (say
    // where an emoji was masked out) is still one space. Callers that need the gaps have the word boxes.
    preserve_interword_spaces: '0',
    // Alternatives for every character, from the LSTM's own output (per character, unlike mode 1's per
    // timestep); they arrive in the hOCR, as tesseract.js's JSON has no per-character alternatives.
    lstm_choice_mode: '2',
    // Tesseract reports harmless conditions (an empty or tiny crop) on stderr, which the WebAssembly build
    // turns into console errors. Failures reach the caller through the promises instead.
    debug_file: '/dev/null',
  };
}

/** The image as a binary PGM, the simplest format Leptonica reads: a text header, then the bytes as they are. */
function encodePgm(image) {
  if (image === null || typeof image !== 'object') {
    throw new TypeError('Text recognition needs an image: { width, height, data } with one byte per pixel.');
  }
  const { width, height, data } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new TypeError('The image for text recognition must have a whole number of pixels as its width and height.');
  }
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || data.length !== width * height) {
    throw new TypeError(`The image for text recognition must have one byte per pixel (${width} × ${height} bytes).`);
  }
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
    throw new RangeError(`The ${width} × ${height} px image is too large for text recognition.`);
  }
  const header = new TextEncoder().encode(`P5\n${width} ${height}\n255\n`);
  const bytes = new Uint8Array(header.length + data.length);
  bytes.set(header);
  bytes.set(data, header.length);
  return bytes;
}

function hasInk({ data }) {
  for (let i = 0; i < data.length; i++) if (data[i] < INK_LEVEL) return true;
  return false;
}

/** tesseract.js's result as the Recognizer's: words in reading order, with their characters. */
function toRecognition({ text, confidence, blocks, hocr }) {
  const alternatives = hocr ? alternativesPerWord(hocr) : [];
  const words = [];
  for (const block of blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        for (const word of line.words) {
          // Matched by position, so only when Tesseract listed alternatives for every visible character (a
          // word can begin with a space symbol, after a blank stretch).
          const choices = alternatives[words.length];
          const aligned = choices?.length === word.symbols.filter((symbol) => !isBlank(symbol.text)).length;
          let next = 0;
          words.push({
            text: word.text,
            confidence: word.confidence,
            box: toBox(word.bbox),
            symbols: word.symbols.map((symbol) => {
              const result = { text: symbol.text, confidence: symbol.confidence, box: toBox(symbol.bbox) };
              const alternativesHere = aligned && !isBlank(symbol.text) ? choices[next++] : [];
              return alternativesHere.length ? { ...result, choices: alternativesHere } : result;
            }),
          });
        }
      }
    }
  }
  return { text: text.trim(), confidence, words };
}

const toBox = ({ x0, y0, x1, y1 }) => ({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
const isBlank = (text) => text.trim() === '';

const WORD_START = "<span class='ocrx_word'";
const CHARACTER_START = "id='lstm_choices_";
const CHOICE = /<span class='ocrx_cinfo' id='choice_[^']*' title='x_confs ([^']*)'>([^<]*)<\/span>/g;

/**
 * The alternatives lstm_choice_mode 2 writes into the hOCR, per word and per character:
 * [[[{ text, confidence }]]], best first. Alternatives Tesseract rates at 0 are left out.
 */
function alternativesPerWord(hocr) {
  return hocr.split(WORD_START).slice(1).map((word) => word.split(CHARACTER_START).slice(1)
    .map((character) => [...character.matchAll(CHOICE)]
      .map(([, confidence, text]) => ({ text: decodeEntities(text), confidence: Number(confidence) }))
      .filter((choice) => choice.text && choice.confidence > 0))
    // The LSTM reads the space before a word as one more character of it (its first choice is the space).
    .filter((choices) => !choices.length || !isBlank(choices[0].text))
    // Tesseract lists them in the order its repeated decoding found them, which is not always by confidence
    // ("d" 82, then "4" 84), and with the dictionary on the character it settles on need not be the first.
    .map((choices) => choices.sort((a, b) => b.confidence - a.confidence)));
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (entity, name) => {
    if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? entity;
    const codePoint = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
  });
}

function reportProgress(onProgress, progress) {
  if (!onProgress) return;
  try {
    onProgress(progress);
  } catch (error) {
    console.error(error); // a broken progress display must not stop recognition
  }
}

/** tesseract.js rejects with strings ("Error: …"); turn them into Errors that say what failed. */
function ocrError(what, reason) {
  const detail = reason instanceof Error ? reason.message : String(reason ?? 'unknown error');
  return new Error(`${what}: ${detail.replace(/^(Runtime)?Error: /, '')}`, { cause: reason });
}
