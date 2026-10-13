// The link to the Premiere Pro panel (premiere-plugin/): a small HTTP server at http://localhost. The panel
// sends the sequence frame at the playhead and the box drawn around a comment in it; the editor reads the
// comment, the user checks it there and sends back a PNG or a typing video, which the panel fetches and puts
// on the timeline. Jobs live in memory, one at a time: a new frame replaces the job before it.
//
// The panel has to say localhost: UXP allows a plugin only the domains its manifest names, and drops an entry
// that is a bare IP address. Windows resolves localhost to ::1 as well as 127.0.0.1, so the server listens on
// both loopback addresses (and on nothing else: no other computer can reach it, and Windows asks no firewall
// question for it). Only the panel may use it: it answers only requests that name it as their Host (a web page
// that rebinds its own domain name to 127.0.0.1 can't use it) and that carry the X-YouTube-Chat-Comment
// header, which a web page can't send to another origin without first asking in a CORS preflight. Anything
// from a web page (an Origin of http:, https:, file: or null) is refused, preflights included; only UXP's own
// origin (plugin:), should a version of it send one, has a preflight answered or a reply it may read. A frame
// is taken one at a time, and refused as soon as its first bytes show it is no PNG or too big. No Node or
// Electron module beyond node:http and node:crypto, so test/unit/premiere-bridge.test.js runs it in plain Node.
import crypto from 'node:crypto';
import http from 'node:http';

// The panel looks for the app on these ports, in this order (the first one free is used).
export const BRIDGE_PORTS = [47811, 47812, 47813];
const LOOPBACK = ['127.0.0.1', '::1'];
export const PROTOCOL = 1;
export const HEADER = 'x-youtube-chat-comment'; // its value: the PROTOCOL the sender speaks
const MAX_FRAME_BYTES = 80 * 1024 * 1024; // a 4K frame as PNG is 10-40 MB
// As the screenshot reader's own cap (MAX_PIXELS in src/editor/screenshot.js): an 8K frame is 33 million.
const MAX_FRAME_PIXELS = 40_000_000;
const DRAIN_BYTES = 1024 * 1024; // of a refused upload, read (so the client sees the reply) before hanging up
const MAX_NOTE_BYTES = 4096;
const MAX_LABEL = 200;
const KEEP_JOBS = 4; // finished jobs kept for the panel to fetch, newest first
// A job is 'reading', 'review' (waiting for the user in the app), 'rendering', then 'done', 'failed' or 'cancelled'.
const OPEN = new Set(['reading', 'review', 'rendering']);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FILE_TYPES = { png: 'image/png', mp4: 'video/mp4' };

/**
 * Starts the server on the first port of `ports` free on every loopback address (0 lets the system choose).
 * Resolves to the bridge, or null when no port is (the app works as before; the panel then says it can't find
 * the app).
 *   onJob({ id, frame, rect, label })   a frame arrived: frame is the PNG's bytes (a Buffer), rect the box
 *                                       { x, y, width, height } drawn in it (whole pixels, inside the frame),
 *                                       label a line of text for the user ('Sequence 01 at 00:01:23:12')
 *   onCancel(id)                        the panel gave the job up
 *   onPlaced(id, message, ok)           the panel put the file on the timeline (message says where), or
 *                                       couldn't (ok false; message says why)
 * The bridge: { port, update(id, state, message), deliver(id, file), fail(id, message), cancel(id, message),
 * close() }, where file is { kind: 'png' | 'mp4', bytes, width, height, duration?, name? }.
 */
export async function startPremiereBridge({
  ports = BRIDGE_PORTS, version = '', maxFrameBytes = MAX_FRAME_BYTES, onJob, onCancel, onPlaced,
} = {}) {
  const jobs = new Map(); // id → job, oldest first
  let servers = [];
  let port = 0;
  let uploading = false; // a frame is on its way in

  const job = (id) => jobs.get(id) ?? null;
  const forget = () => {
    const done = [...jobs.values()].filter((j) => !OPEN.has(j.state));
    for (const old of done.slice(0, Math.max(0, done.length - KEEP_JOBS))) jobs.delete(old.id);
  };
  const settle = (j, state, message) => {
    j.state = state;
    j.message = message;
    if (state !== 'done') j.file = null;
  };

  const routes = async (request, url) => {
    const parts = url.pathname.split('/').filter(Boolean); // ['v1', 'jobs', id, 'file']
    if (parts[0] !== 'v1') return [404, { error: 'Not found.' }];
    if (parts.length === 2 && parts[1] === 'hello') {
      if (request.method !== 'GET') return [405, { error: 'Use GET.' }];
      return [200, { app: 'YouTube Chat Comment', version, protocol: PROTOCOL }];
    }
    if (parts[1] !== 'jobs') return [404, { error: 'Not found.' }];
    if (parts.length === 2) {
      if (request.method !== 'POST') return [405, { error: 'Use POST.' }];
      return createJob(request, url);
    }
    const j = job(parts[2]);
    if (!j) return [404, { error: 'No such job: it was replaced by a newer frame, or the app was restarted.' }];
    if (parts.length === 3) {
      if (request.method !== 'GET') return [405, { error: 'Use GET.' }];
      return [200, describe(j)];
    }
    if (parts.length !== 4) return [404, { error: 'Not found.' }];
    if (parts[3] === 'file') {
      if (request.method !== 'GET') return [405, { error: 'Use GET.' }];
      if (j.state !== 'done' || !j.file) return [409, { error: 'The file is not ready yet.' }];
      return [200, j.file.bytes, FILE_TYPES[j.file.kind]];
    }
    if (parts[3] === 'cancel') {
      if (request.method !== 'POST') return [405, { error: 'Use POST.' }];
      await readBody(request, MAX_NOTE_BYTES); // nothing is expected, and anything sent is ignored
      if (OPEN.has(j.state)) {
        settle(j, 'cancelled', 'Cancelled in Premiere Pro.');
        onCancel?.(j.id);
      }
      return [200, describe(j)];
    }
    if (parts[3] === 'placed') {
      if (request.method !== 'POST') return [405, { error: 'Use POST.' }];
      const body = await readBody(request, MAX_NOTE_BYTES);
      let note;
      try {
        note = JSON.parse(body.toString('utf8'));
      } catch {
        return [400, { error: 'Expected JSON: { "message": "…" }.' }];
      }
      if (!isPlainObject(note) || typeof note.message !== 'string') return [400, { error: 'Expected JSON: { "message": "…" }.' }];
      if (j.state === 'done') onPlaced?.(j.id, clean(note.message).slice(0, MAX_LABEL), note.ok !== false);
      return [200, describe(j)];
    }
    return [404, { error: 'Not found.' }];
  };

  const createJob = async (request, url) => {
    const type = String(request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'image/png') return [415, { error: 'Send the frame as image/png.' }];
    const rect = {};
    for (const key of ['x', 'y', 'width', 'height']) {
      const value = Number(url.searchParams.get(key));
      if (!url.searchParams.has(key) || !Number.isInteger(value) || value < 0) return [400, { error: `${key} must be a whole number of pixels.` }];
      rect[key] = value;
    }
    if (uploading) return [503, { error: 'The app is still taking another frame: try again in a moment.' }];
    uploading = true;
    let frame;
    try {
      // (Judged by its header, as soon as that is in: a wrong frame is refused without the rest being kept.)
      frame = await readBody(request, maxFrameBytes, (head) => {
        const found = pngSize(head);
        if (!found) return new Refused(400, 'The frame is not a PNG image.');
        if (found.width * found.height > MAX_FRAME_PIXELS) return new Refused(413, `The frame is ${found.width} × ${found.height} px, more than the app reads.`);
        if (rect.width < 8 || rect.height < 8 || rect.x + rect.width > found.width || rect.y + rect.height > found.height) {
          return new Refused(400, `The box must lie inside the ${found.width} × ${found.height} px frame and be at least 8 px each way.`);
        }
        return null;
      });
    } finally {
      uploading = false;
    }
    for (const old of jobs.values()) {
      if (!OPEN.has(old.state)) continue;
      settle(old, 'cancelled', 'Replaced by a newer frame.');
      onCancel?.(old.id);
    }
    const label = clean(url.searchParams.get('label') ?? '').slice(0, MAX_LABEL);
    const j = { id: crypto.randomUUID(), state: 'reading', message: 'Reading the comment…', rect, label, file: null };
    jobs.set(j.id, j);
    forget();
    // The app's side runs after the reply: the panel learns the id at once and asks how the job is going.
    setImmediate(() => {
      Promise.resolve()
        .then(() => onJob?.({ id: j.id, frame, rect: { ...rect }, label }))
        .catch((error) => { if (OPEN.has(j.state)) settle(j, 'failed', clean(String(error?.message ?? error)).slice(0, MAX_LABEL)); });
    });
    return [201, describe(j)];
  };

  const handle = async (request, response) => {
    const origin = request.headers.origin;
    const send = (status, body, type = 'application/json') => {
      const bytes = Buffer.isBuffer(body) || body instanceof Uint8Array ? Buffer.from(body.buffer, body.byteOffset, body.byteLength) : Buffer.from(JSON.stringify(body));
      const headers = {
        'Content-Type': type === 'application/json' ? 'application/json; charset=utf-8' : type,
        'Content-Length': bytes.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      };
      if (status !== 403 && isPluginOrigin(origin)) Object.assign(headers, { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' });
      response.writeHead(status, headers);
      response.end(bytes);
    };
    try {
      const hostHeader = String(request.headers.host ?? '').toLowerCase();
      if (![`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`].includes(hostHeader)) return send(403, { error: 'Refused: wrong Host.' });
      if (origin !== undefined && isWebOrigin(origin)) return send(403, { error: 'Refused: web pages may not use the app.' });
      if (request.method === 'OPTIONS' && isPluginOrigin(origin)) {
        response.writeHead(204, {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'GET, POST',
          'Access-Control-Allow-Headers': `${HEADER}, content-type`,
          'Access-Control-Max-Age': '600',
          Vary: 'Origin',
        });
        response.end();
        return;
      }
      if (request.headers[HEADER] !== String(PROTOCOL)) return send(403, { error: `Refused: requests must carry ${HEADER}: ${PROTOCOL}.` });
      const url = new URL(request.url ?? '/', `http://${hostHeader}`);
      const [status, body, type] = await routes(request, url);
      send(status, body, type);
    } catch (error) {
      if (error instanceof Refused) {
        // The rest of the upload is read and dropped for a while, so the client sees the reply; then, if it keeps
        // sending, the connection goes.
        response.setHeader('Connection', 'close');
        send(error.status, { error: error.message });
        let drained = 0;
        request.on('data', (chunk) => {
          drained += chunk.length;
          if (drained > DRAIN_BYTES) request.destroy();
        });
        request.resume();
        return;
      }
      if (!response.headersSent) send(500, { error: String(error?.message ?? error) });
      else response.destroy();
    }
  };

  for (const candidate of ports) {
    // (Port 0: the system picks one for 127.0.0.1, which ::1 may have taken already; then pick again.)
    for (let attempt = 0; attempt < (candidate === 0 ? 5 : 1) && !servers.length; attempt++) servers = await listenOnLoopback(candidate, handle);
    if (servers.length) {
      port = servers[0].address().port;
      break;
    }
  }
  if (!servers.length) return null;
  for (const server of servers) server.on('error', () => {}); // a client hanging up mid-request is no reason to stop

  const open = (id) => {
    const j = job(id);
    return j && OPEN.has(j.state) ? j : null;
  };
  return {
    port,
    /** Moves an open job on ('reading' → 'review' → 'rendering'), with a line for the panel to show. */
    update(id, state, message = '') {
      const j = open(id);
      if (!j || !OPEN.has(state)) return false;
      j.state = state;
      j.message = clean(message).slice(0, MAX_LABEL);
      return true;
    },
    /** The finished file, for the panel to fetch. */
    deliver(id, file) {
      const j = open(id);
      if (!j) return false;
      j.file = checkFile(file);
      j.state = 'done';
      j.message = 'Ready.';
      return true;
    },
    fail(id, message) {
      const j = open(id);
      if (!j) return false;
      settle(j, 'failed', clean(String(message)).slice(0, MAX_LABEL) || 'Something went wrong.');
      return true;
    },
    cancel(id, message = 'Cancelled in the app.') {
      const j = open(id);
      if (!j) return false;
      settle(j, 'cancelled', clean(message).slice(0, MAX_LABEL));
      return true;
    },
    state: (id) => job(id)?.state ?? null,
    close: () => Promise.all(servers.map((server) => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    }))).then(() => {}),
  };
}

/**
 * Servers on `port` of each loopback address, all with `handle`: [] when the port is taken on one of them. A
 * computer without IPv6 has no ::1, and does without it.
 */
async function listenOnLoopback(port, handle) {
  const servers = [];
  for (const address of LOOPBACK) {
    // (Timeouts checked each second rather than Node's default 30, so a slow client is let go when it should be.)
    const server = http.createServer({ requestTimeout: 60_000, headersTimeout: 10_000, maxHeaderSize: 16 * 1024, connectionsCheckingInterval: 1000 }, handle);
    server.maxConnections = 32;
    const error = await new Promise((resolve) => {
      server.once('error', resolve);
      server.listen(servers.length ? servers[0].address().port : port, address, () => resolve(null));
    });
    if (!error) {
      servers.push(server);
      continue;
    }
    server.close();
    if (address !== '127.0.0.1' && error.code !== 'EADDRINUSE' && error.code !== 'EACCES') continue; // no IPv6 here
    await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
    return [];
  }
  return servers;
}

/** What the panel is told about a job. */
function describe(j) {
  const out = { id: j.id, state: j.state, message: j.message, label: j.label };
  if (j.state === 'done' && j.file) {
    const { kind, width, height, duration, name } = j.file;
    out.file = { kind, width, height, bytes: j.file.bytes.length, duration, name };
  }
  return out;
}

/** The file the app hands over, checked: a PNG or an MP4 of a sensible size. */
function checkFile(file) {
  if (!isPlainObject(file) || !FILE_TYPES[file.kind]) throw new TypeError('deliver: kind must be png or mp4.');
  const bytes = Buffer.isBuffer(file.bytes) ? file.bytes : file.bytes instanceof Uint8Array ? Buffer.from(file.bytes) : null;
  if (!bytes || bytes.length < 16) throw new TypeError('deliver: bytes must be the file.');
  if (file.kind === 'png' ? !pngSize(bytes) : bytes.toString('latin1', 4, 8) !== 'ftyp') throw new TypeError(`deliver: that is not a ${file.kind.toUpperCase()} file.`);
  const whole = (n) => Number.isInteger(n) && n > 0 && n <= 16384;
  if (!whole(file.width) || !whole(file.height)) throw new TypeError('deliver: width and height must be whole pixels.');
  return {
    kind: file.kind,
    bytes,
    width: file.width,
    height: file.height,
    duration: Number.isFinite(file.duration) && file.duration > 0 ? file.duration : undefined,
    name: typeof file.name === 'string' ? clean(file.name).slice(0, MAX_LABEL) : undefined,
  };
}

/** A request refused part-way through its body: the status and the reason to answer with. */
class Refused extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * The request's body, at most `limit` bytes: refused (413) past that, as soon as it is. `inspect(head)`, if given,
 * sees the first 24 bytes (or all there is, if fewer) as soon as they are in, and may refuse the rest by returning
 * a Refused.
 */
function readBody(request, limit, inspect = null) {
  return new Promise((resolve, reject) => {
    const tooBig = () => new Refused(413, 'Too much data.');
    const declared = Number(request.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(tooBig());
      return;
    }
    const chunks = [];
    let total = 0;
    let inspected = !inspect;
    const stop = (problem) => {
      request.removeAllListeners('data');
      request.removeAllListeners('end');
      reject(problem);
    };
    const look = () => {
      inspected = true;
      return inspect(Buffer.concat(chunks, total));
    };
    request.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) return stop(tooBig());
      chunks.push(chunk);
      if (!inspected && total >= 24) {
        const problem = look();
        if (problem) stop(problem);
      }
      return undefined;
    });
    request.on('end', () => {
      const problem = inspected ? null : look();
      if (problem) reject(problem);
      else resolve(Buffer.concat(chunks, total));
    });
    request.on('error', reject);
  });
}

/** { width, height } from a PNG's header, or null if `bytes` doesn't start like a PNG. */
export function pngSize(bytes) {
  if (!bytes || bytes.length < 24 || !Buffer.from(bytes.buffer, bytes.byteOffset, 8).equals(PNG_SIGNATURE)) return null;
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, 24);
  if (view.toString('latin1', 12, 16) !== 'IHDR') return null;
  const width = view.readUInt32BE(16);
  const height = view.readUInt32BE(20);
  return width && height ? { width, height } : null;
}

/**
 * Whether `origin` (an Origin header) is a web page's: one a browser sends for a site, a file it opened, or a
 * sandboxed or otherwise opaque page (null). The panel's requests carry none of these.
 */
function isWebOrigin(origin) {
  const value = String(origin).trim().toLowerCase();
  return value === 'null' || value === '' || /^(https?|file|ftp|wss?|blob|data):/.test(value);
}

/** Whether `origin` (an Origin header) is UXP's own, plugin: (a browser never sends that). */
function isPluginOrigin(origin) {
  return typeof origin === 'string' && /^plugin:/i.test(origin.trim());
}

/**
 * Text from the panel or the app, without control characters, and without the ones that turn text round (bidi
 * overrides, embeddings and isolates), which could make a line read as something else.
 */
function clean(text) {
  return String(text)
    .replace(/[\u0000-\u001f\u007f-\u009f\u{2028}\u{2029}]/gu, ' ')
    .replace(/[\u{061C}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu, '')
    .trim();
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}
