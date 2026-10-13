// The YouTube Chat Comment panel: grabs the sequence frame at the playhead, lets the user draw a box around a
// chat comment in it, and sends both to the YouTube Chat Comment app, which reads the comment for the user to
// check there and sends back a PNG or a typing video, rendered at the app's Scale. The panel then puts that on
// the timeline at the frame's time, at its own size.
const { boxBetween, fileNameFor, fitView, timecode, toFrame, toPanel, zoomTo } = require('./lib/geometry.js');
const { createBridge } = require('./lib/bridge.js');
const { base64 } = require('./lib/bytes.js');
const premiere = require('./lib/premiere.js');

const POLL_MS = 400;
const APP_CHECK_MS = 10_000;
const $ = (id) => document.getElementById(id);
const bridge = createBridge({ fetch: (url, options) => fetch(url, options) });
const { log } = premiere;

// Whatever goes wrong unseen goes to UXP's log, with the panel's name on it (see the README).
window.addEventListener('error', (event) => log('error:', event.message ?? event.error ?? event));
window.addEventListener('unhandledrejection', (event) => log('unhandled:', String(event.reason?.message ?? event.reason)));

let grab = null; // premiere.grabFrame()'s result: the frame on show
let view = null; // the part of the frame on show, in frame px (all of it, or the part zoomed into)
let box = null; // the box drawn around the comment, in frame px
let drag = null; // { from } while the mouse button is held on the frame
let job = null; // { id, grab, box, placing } while the app has the comment (placing: on the timeline by now)

// (Inline display rather than the hidden attribute, and the disabled attribute itself: they work in every UXP.)
const show = (id, on) => { $(id).style.display = on ? '' : 'none'; };
const enable = (id, on) => {
  if (on) $(id).removeAttribute('disabled');
  else $(id).setAttribute('disabled', '');
};
const message = (error) => String(error?.message ?? error);

/**
 * Shows the frame's PNG in the <img>: as an object URL, which Premiere's own panels use; failing that, the file
 * itself (the plugin may read any file); failing that, a data: URL.
 */
let frameUrl = null; // the object URL on show, let go when the next frame comes
function showFrame(img, bytes, file) {
  const sources = [];
  try {
    if (frameUrl) URL.revokeObjectURL(frameUrl);
    frameUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
    sources.push(frameUrl);
  } catch {
    frameUrl = null; // no object URLs here
  }
  if (file) sources.push(`file:///${file.replace(/\\/g, '/')}`);
  sources.push(() => `data:image/png;base64,${base64(bytes)}`);
  let next = 0;
  const tryNext = () => {
    if (next >= sources.length) {
      log('no way to show the frame worked');
      return;
    }
    const source = sources[next++];
    img.src = typeof source === 'function' ? source() : source;
  };
  img.onerror = () => {
    log('the frame did not show from', String(img.src).slice(0, 40));
    tryNext();
  };
  tryNext();
}

function setStatus(kind, text) {
  const status = $('status');
  status.className = `status${kind ? ` ${kind}` : ''}`;
  status.textContent = text;
}

const wholeFrame = () => ({ x: 0, y: 0, width: grab.size.width, height: grab.size.height });
const zoomedIn = () => Boolean(grab && view) && (view.x !== 0 || view.y !== 0 || view.width !== grab.size.width || view.height !== grab.size.height);

/** The buttons that apply now. */
function sync() {
  const free = !job;
  enable('grab', free);
  enable('zoom', free && Boolean(box));
  enable('whole', free && zoomedIn());
  enable('read', free && Boolean(box));
  show('cancel', !free && !job.placing); // (an edit of the timeline can't be called back)
}

/** The frame (the part on show) as wide as the panel, and the box over it. */
function draw() {
  show('stage', Boolean(grab));
  if (!grab) return;
  const stage = $('stage');
  const width = stage.getBoundingClientRect().width || stage.clientWidth || 300;
  const fit = fitView(view, width);
  stage.style.height = `${Math.round(fit.height)}px`;
  const frame = $('frame');
  frame.style.width = `${grab.size.width * fit.scale}px`;
  frame.style.height = `${grab.size.height * fit.scale}px`;
  frame.style.left = `${-view.x * fit.scale}px`;
  frame.style.top = `${-view.y * fit.scale}px`;
  show('box', Boolean(box));
  if (box) {
    const drawn = toPanel(view, fit, box);
    const outline = $('box').style;
    outline.left = `${drawn.left}px`;
    outline.top = `${drawn.top}px`;
    outline.width = `${drawn.width}px`;
    outline.height = `${drawn.height}px`;
  }
}

/** The frame pixel under the mouse. */
function framePoint(event) {
  const rect = $('stage').getBoundingClientRect();
  return toFrame(view, fitView(view, rect.width), event.clientX - rect.left, event.clientY - rect.top);
}

async function grabFrame() {
  if (job) return;
  setStatus('', 'Exporting the frame at the playhead…');
  try {
    const grabbed = await premiere.grabFrame();
    grab = grabbed;
    view = wholeFrame();
    box = null;
    showFrame(/** @type {HTMLImageElement} */ ($('frame')), grab.bytes, grab.file);
    $('hint').textContent = 'Drag a box around one chat comment. Zoom to the box to draw it more closely.';
    setStatus('', `${grab.name} at ${timecode(grab.seconds, grab.fps, grab)} (${grab.size.width} × ${grab.size.height} px).`);
  } catch (error) {
    log('grabbing the frame failed:', message(error));
    setStatus('error', message(error));
  }
  draw();
  sync();
  checkApp();
}

async function readComment() {
  if (!grab || !box || job) return;
  const current = { id: null, grab, box: { ...box }, placing: false };
  job = current;
  sync();
  setStatus('', 'Sending the frame to the app…');
  try {
    await premiere.checkPlace(grab); // (an unsaved project, say: before the app reads and renders anything)
    const started = await bridge.startJob(grab.bytes, current.box, `${grab.name} at ${timecode(grab.seconds, grab.fps, grab)}`);
    current.id = started.id;
    await follow(current);
  } catch (error) {
    log('reading the comment failed:', message(error));
    if (job === current) setStatus('error', message(error));
  } finally {
    if (job === current) job = null;
    sync();
  }
}

/** Follows the app's work on the comment until it hands over the file, then puts that on the timeline. */
async function follow(current) {
  for (;;) {
    if (job !== current) return; // cancelled here
    const state = await bridge.job(current.id);
    if (job !== current) return;
    if (state.state === 'done') {
      await putOnTimeline(current, state);
      return;
    }
    if (state.state === 'failed') throw new Error(`The app couldn't read a comment there: ${state.message}`);
    if (state.state === 'cancelled') {
      setStatus('', state.message || 'Cancelled.');
      return;
    }
    setStatus('', state.state === 'review'
      ? 'Check the comment in the YouTube Chat Comment app, then click Send image or Send typing video there.'
      : state.message || 'The app is working on it…');
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

async function putOnTimeline(current, state) {
  current.placing = true;
  sync();
  setStatus('', 'Putting it on the timeline…');
  const { file } = state;
  try {
    const bytes = await bridge.file(current.id);
    const placed = await premiere.place(current.grab, {
      bytes, kind: file.kind, fileName: fileNameFor(file.name, file.kind, new Date()), duration: file.duration,
    });
    const text = `Placed the ${file.kind === 'mp4' ? 'typing video' : 'image'} (${file.width} × ${file.height} px) on V${placed.track} at ${timecode(current.grab.seconds, current.grab.fps, current.grab)}.`;
    setStatus('ok', text);
    await bridge.placed(current.id, text).catch(() => {});
  } catch (error) {
    // (The app says so too, rather than "putting it on the timeline" for ever.)
    await bridge.placed(current.id, `Premiere Pro couldn't place it: ${message(error)}`, false).catch(() => {});
    throw error;
  }
}

async function cancel() {
  const current = job;
  if (!current || current.placing) return;
  job = null;
  sync();
  setStatus('', 'Cancelled.');
  if (current.id) await bridge.cancel(current.id).catch(() => {});
}

async function checkApp() {
  const hello = await bridge.find().catch(() => null);
  $('connection').textContent = hello
    ? `Connected to the YouTube Chat Comment app${hello.version ? ` ${hello.version}` : ''}.`
    : "Can't find the YouTube Chat Comment app: open it to read comments.";
}

$('grab').addEventListener('click', grabFrame);
$('read').addEventListener('click', readComment);
$('cancel').addEventListener('click', cancel);
$('zoom').addEventListener('click', () => {
  if (!box || job) return;
  view = zoomTo(box, grab.size);
  $('hint').textContent = 'Now drag the box closely around the comment, avatar and all.';
  draw();
  sync();
});
$('whole').addEventListener('click', () => {
  if (!grab || job) return;
  view = wholeFrame();
  draw();
  sync();
});
// Drawing the box: the pointer is captured, so the box follows it past the frame's edge.
$('stage').addEventListener('pointerdown', (event) => {
  if (!grab || job) return;
  drag = { from: framePoint(event) };
  box = null;
  try {
    $('stage').setPointerCapture(event.pointerId);
  } catch {
    // (followed on the stage only)
  }
  draw();
  sync();
});
$('stage').addEventListener('pointermove', (event) => {
  if (!drag) return;
  box = boxBetween(drag.from, framePoint(event), grab.size);
  draw();
});
$('stage').addEventListener('pointerup', (event) => {
  if (!drag) return;
  box = boxBetween(drag.from, framePoint(event), grab.size);
  drag = null;
  if (box.width < 8 || box.height < 8) box = null; // a click, not a box
  $('hint').textContent = box
    ? 'Read the comment, or zoom to the box to draw it more closely.'
    : 'Drag a box around one chat comment. Zoom to the box to draw it more closely.';
  draw();
  sync();
});
window.addEventListener('resize', draw);

show('stage', false);
show('box', false);
sync();
checkApp();
setInterval(() => { if (!job) checkApp(); }, APP_CHECK_MS);
