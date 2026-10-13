// The Premiere Pro panel's own code (premiere-plugin/lib/premiere.js and panel.js) run end to end in Node,
// against a stand-in for Premiere Pro 26.5's UXP modules (premierepro, uxp and fs). The stand-in follows Adobe's
// typings (@adobe/premierepro 26.5.1), the wrappers of the premierepro module that Premiere ships, and what
// panels found running on 26.5 (CutDeck's PREMIERE_FACTS.md, premiere-pro-mcp #765 and #801):
//  - actions are made inside project.lockedAccess() and inside the transaction's callback, or adding one
//    throws; executeTransaction() returns true when the edit is done, false when Premiere refuses it;
//  - script objects for sequences, tracks, clips and effects go stale once a transaction has committed;
//  - importFiles() resolves before the item shows in its bin; exportSequenceFrame() resolves before the file
//    is written (and some versions write name.png.png);
//  - Motion's Position reads back as { value: { value: [x, y] } } and takes only a PointF; Scale is a percentage;
//  - Project.path comes with the \\?\ prefix; a still is 5 s long; getTrackItems() is synchronous;
//  - an overwrite on the next track index makes that track (one per transaction); a locked track refuses edits.
// Time is virtual: the panel's waits pass at once, and the stand-in's delays count in the same virtual time.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { startPremiereBridge } from '../../electron/premiere-bridge.js';

const PLUGIN = path.join(import.meta.dirname, '..', '..', 'premiere-plugin');

const TICKS = 254016000000; // Premiere's ticks in a second
const STALE = 'The script object is no longer valid.';
const BIN = 'YouTube Chat Comments';
const seconds = (ticks) => ticks / TICKS;
const ticksOf = (s) => Math.round(s * TICKS);

/** The first bytes of a PNG of width × height, its body and its IEND chunk: `length` bytes in all. */
function pngBytes(width, height, length = 4096) {
  const bytes = new Uint8Array(length);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  for (let i = 33; i < length - 12; i++) bytes[i] = (i * 31) & 255;
  bytes.set([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82], length - 12);
  return bytes;
}
const endsLikePng = (bytes) => Buffer.from(bytes).subarray(-8, -4).toString('latin1') === 'IEND';

/**
 * A stand-in for Premiere Pro with one project ("Stream Edit") and one sequence ("Stream 01", 1920 × 1080,
 * 30 fps, playhead at 125.5 s). `options.video` lists each video track's clips ({ name, start, end } in s).
 */
function createPremiere(options = {}) {
  const o = {
    projectPath: String.raw`\\?\C:\Users\Test\Videos\Stream Edit.prproj`,
    frame: { width: 1920, height: 1080 },
    fps: 30,
    playhead: 125.5,
    video: [[{ name: 'stream.mp4', start: 0, end: 600 }], []],
    audio: [[{ name: 'stream.mp4', start: 0, end: 600 }]],
    locked: [], // video track indexes
    muted: [], // video track indexes with their output switched off (the eye in the Timeline)
    zeroPoint: 0, // the sequence's start time, s
    dropFrame: false, // the sequence counts drop-frame timecode
    stillSeconds: 5, // Premiere's default length for a still
    mp4Seconds: 8,
    lengthUnreadable: false, // the project item's In/Out read as 0 (as right after an import, say)
    importDelayMs: 600, // importFiles() resolves this long before the item shows
    importBumpsEpoch: true, // an import makes sequence/track/clip objects stale, like a transaction
    mediaPathPrefix: '', // what getMediaFilePath() puts before the path (String.raw`\\?\`, say)
    exportDelayMs: 2000, // exportSequenceFrame() resolves this long before the file appears
    exportWriteMs: 300,
    exportStallMs: 0, // the file stops growing this long, part-written
    exportName: 'same', // 'same' | 'doubled' (name.png.png) | 'never' (no file at all)
    binFails: false, // the transaction that makes the bin is refused
    overwriteMakesTrack: true, // an overwrite at index = track count makes the track (CutDeck, live 26.5)
    insert: 'creates', // insert at index = track count: 'creates' a track | 'noop' | 'throws' | 'clamp' (on the top track)
    rippleAll: false, // an insert shifts every track, limitShift or not
    motion: true, // the clip has Motion
    positionUnits: 'normalized', // or 'pixels'
    startValueShape: 'array', // Position's getStartValue(): 'array' { value: { value: [x, y] } } (live) | 'pointf' (typings)
    startScale: 100, // Scale as placed (not 100 when Default Media Scaling is Set to Frame Size)
    getSequenceAsync: false, // Project.getSequence() returns a Promise (as in the 27.0 typings)
    staleProjectItems: false, // project items go stale after a transaction too
    itemsLackGetId: false, // getItems() and getProjectItem() give items without getId() until ProjectItem.cast (mcp #801)
    placedProjectItemFails: false, // getProjectItem() fails on the clip the panel put down
    hooks: {}, // { onImport() }: called as importFiles() is
    ...options,
  };
  const TYPE = { CLIP: 1, BIN: 2, ROOT: 3, FILE: 4 };
  const Constants = Object.freeze({
    MediaType: Object.freeze({ ANY: 'media-any', VIDEO: 'media-video', AUDIO: 'media-audio' }),
    TrackItemType: Object.freeze({ EMPTY: 0, CLIP: 1, TRANSITION: 2, PREVIEW: 3, FEEDBACK: 4 }),
    // (Values unlike the typings' order, as some of Premiere's own constants are: the panel must ask, not count.)
    VideoDisplayFormatType: Object.freeze({ FPS_23_976: 100, FPS_25: 101, FPS_29_97: 102, FPS_29_97_NON_DROP: 103, FRAMES: 106 }),
  });

  const clock = { now: 0 };
  const pending = [];
  const later = (ms, fn) => pending.push({ at: clock.now + ms, fn });
  const tick = () => {
    pending.sort((a, b) => a.at - b.at);
    while (pending.length && pending[0].at <= clock.now) pending.shift().fn();
  };
  const world = { epoch: 0, projectEpoch: 0, lockDepth: 0, txn: null, txnSeq: 0, history: [], refused: [], imports: [], exports: [] };
  let serial = 1;
  const newId = (prefix) => `${prefix}-${serial++}`;

  // ---- the disk (Windows paths, any case) ----
  const disk = new Map();
  const plain = (p) => String(p).replace(/\//g, '\\').replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
  const key = (p) => plain(p).replace(/\\+$/, '').toLowerCase();
  const absolute = (p) => /^[a-z]:\\/i.test(p) || /^\\\\[^\\?.]+\\[^\\]+/.test(p);
  const parentOf = (p) => plain(p).replace(/\\+$/, '').replace(/\\[^\\]*$/, '');
  const isDrive = (p) => /^[a-z]:\\?$/i.test(plain(p));
  const folderExists = (p) => isDrive(p) || disk.get(key(p))?.folder === true;
  const seedFolder = (p) => {
    for (let at = plain(p); at && !isDrive(at) && !disk.has(key(at)); at = parentOf(at)) {
      disk.set(key(at), { path: at, folder: true });
      if (/^\\\\[^\\]+\\[^\\]+$/.test(at)) break; // a share's root
    }
  };
  const TEMP = String.raw`C:\Users\Test\AppData\Local\Temp\UXP\PluginsStorage\PPRO\26\External\com.danielmidgley.youtube-chat-comment\PluginTemp`;
  for (const folder of [String.raw`C:\Users\Test\Videos`, String.raw`\\nas\shows`, TEMP]) seedFolder(folder);
  const putFile = (p, bytes, visible = bytes.length) => disk.set(key(p), { path: plain(p), bytes, visible });
  putFile(`${TEMP}\\frame-1000.png`, pngBytes(1920, 1080)); // an earlier grab's frame
  putFile(`${TEMP}\\notes.txt`, new TextEncoder().encode('not a frame'));

  const fsModule = {
    async mkdir(p, { recursive = false } = {}) {
      tick();
      if (!absolute(plain(p))) throw new Error(`Invalid path: ${p}`);
      if (folderExists(p)) {
        if (recursive) return undefined;
        throw new Error(`EEXIST: file already exists, mkdir '${p}'`);
      }
      const missing = [];
      for (let at = plain(p); !folderExists(at); at = parentOf(at)) {
        if (!absolute(at)) throw new Error(`ENOENT: no such file or directory, mkdir '${p}'`);
        missing.push(at);
      }
      if (missing.length > 1 && !recursive) throw new Error(`ENOENT: no such file or directory, mkdir '${p}'`);
      for (const at of missing) disk.set(key(at), { path: at, folder: true });
      return undefined;
    },
    async writeFile(p, data) {
      tick();
      if (!absolute(plain(p))) throw new Error(`Invalid path: ${p}`);
      if (!folderExists(parentOf(p))) throw new Error(`ENOENT: no such file or directory, open '${p}'`);
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data.slice(0))
        : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
          : new TextEncoder().encode(String(data));
      putFile(p, bytes);
      return bytes.length;
    },
  };

  // ---- uxp.storage ----
  const formats = { utf8: Symbol('utf8'), binary: Symbol('binary') };
  const fileEntry = (record) => ({
    name: record.path.split('\\').pop(),
    nativePath: record.path,
    isFile: true,
    isFolder: false,
    async getMetadata() {
      tick();
      return { name: record.path.split('\\').pop(), size: record.visible };
    },
    async read({ format = formats.utf8 } = {}) {
      tick();
      const bytes = record.bytes.slice(0, record.visible);
      return format === formats.binary ? bytes.buffer : new TextDecoder().decode(bytes);
    },
    async delete() {
      disk.delete(key(record.path));
      return true;
    },
  });
  const folderEntry = (p) => ({
    name: p.split('\\').pop(),
    nativePath: p,
    isFile: false,
    isFolder: true,
    async getEntry(name) {
      tick();
      const record = disk.get(key(`${p}\\${name}`));
      if (!record || record.folder) throw new Error(`Could not find an entry of '${name}'`);
      return fileEntry(record);
    },
    async getEntries() {
      tick();
      return [...disk.values()].filter((r) => !r.folder && key(parentOf(r.path)) === key(p)).map(fileEntry);
    },
  });
  const uxp = { storage: { formats, localFileSystem: { getTemporaryFolder: async () => folderEntry(TEMP) } }, versions: { uxp: 'uxp-9.3.0' } };

  // ---- the project ----
  const root = { kind: 'root', id: 'root', name: 'Stream Edit.prproj', type: TYPE.ROOT, children: [] };
  const footage = new Map();
  const footageItem = (name) => {
    if (!footage.has(name)) {
      const item = { kind: 'clip', id: newId('item'), name, type: TYPE.CLIP, mediaPath: `D:\\Footage\\${name}`, in: 0, out: ticksOf(3600) };
      footage.set(name, item);
      root.children.push(item);
    }
    return footage.get(name);
  };
  const motionComponent = () => ({
    matchName: 'AE.ADBE Motion',
    params: [
      { kind: 'point', value: o.positionUnits === 'pixels' ? [o.frame.width / 2, o.frame.height / 2] : [0.5, 0.5] }, // Position
      { kind: 'number', value: o.startScale }, // Scale
      { kind: 'number', value: 100 }, // Scale Width
      { kind: 'boolean', value: true }, // Uniform Scale
      { kind: 'number', value: 0 }, // Rotation
      { kind: 'point', value: [0.5, 0.5] }, // Anchor Point
    ],
  });
  const components = () => [{ matchName: 'AE.ADBE Opacity', params: [{ kind: 'number', value: 100 }] }, ...(o.motion ? [motionComponent()] : [])];
  const clipRecord = (item, start, end, extra = {}) => ({ id: newId('clip'), item, start, end, components: components(), ...extra });
  const seq = {
    guid: 'sequence-guid-1',
    name: 'Stream 01',
    ...o.frame,
    timebase: String(Math.round(TICKS / o.fps)),
    playhead: ticksOf(o.playhead),
    video: o.video.map((clips, i) => ({ locked: o.locked.includes(i), muted: o.muted.includes(i), clips: clips.map((c) => clipRecord(footageItem(c.name), ticksOf(c.start), ticksOf(c.end))) })),
    audio: o.audio.map((clips) => ({ locked: false, clips: clips.map((c) => clipRecord(footageItem(c.name), ticksOf(c.start), ticksOf(c.end))) })),
  };

  // ---- script objects ----
  const live = (handle) => {
    handle.__epoch = world.epoch;
    return handle;
  };
  const alive = (handle) => {
    if (handle.__epoch !== world.epoch) throw new Error(STALE);
  };
  const needLock = () => {
    if (world.lockDepth === 0) throw new Error('Actions must be created inside Project.lockedAccess().');
  };
  const action = (label, check, apply) => ({ __txn: world.txn ? world.txn.id : null, label, check, apply });

  class Guid {
    constructor(text) { this.text = text; }
    toString() { return this.text; }
  }
  class TickTime {
    constructor(ticks) { this.__ticks = ticks; }
    get ticks() { return String(this.__ticks); }
    get ticksNumber() { return this.__ticks; }
    get seconds() { return this.__ticks / TICKS; }
    static createWithTicks(text) {
      if (typeof text !== 'string') throw new Error('Illegal Parameter type');
      return new TickTime(Number(text));
    }
    static createWithSeconds(s) { return new TickTime(ticksOf(s)); }
  }
  class PointF {
    constructor(x = 0, y = 0) {
      this.x = x;
      this.y = y;
    }
    distanceTo(p) { return Math.hypot(p.x - this.x, p.y - this.y); }
  }
  class Keyframe {
    constructor(value) { this.__value = value; }
    get value() { return { value: this.__value instanceof PointF ? [this.__value.x, this.__value.y] : this.__value }; }
  }
  // A project item: what getItems() and getProjectItem() hand over. Casts give views without getId (mcp #801).
  class ProjectItem {
    constructor(record, { cast = false } = {}) {
      this.__record = record;
      this.__epoch = world.projectEpoch;
      if (o.itemsLackGetId && !cast) this.getId = undefined;
    }
    __alive() {
      if (o.staleProjectItems && this.__epoch !== world.projectEpoch) throw new Error(STALE);
    }
    get name() {
      this.__alive();
      return this.__record.name;
    }
    get type() {
      this.__alive();
      return this.__record.type;
    }
    getId() {
      this.__alive();
      return this.__record.id;
    }
  }
  class FolderItem {
    constructor(record) { this.__record = record; }
    get name() { return this.__record.name; }
    get type() { return this.__record.type; }
    async getItems() {
      tick();
      return this.__record.children.map((child) => new ProjectItem(child));
    }
    createBinAction(name, makeUnique) {
      needLock();
      const parent = this.__record;
      return action(`make the bin ${name}`, () => (o.binFails ? 'the bin could not be made' : null), () => {
        const taken = makeUnique && parent.children.some((c) => c.name === name);
        parent.children.push({ kind: 'bin', id: newId('bin'), name: taken ? `${name} 01` : name, type: TYPE.BIN, children: [] });
      });
    }
  }
  class ClipProjectItem {
    constructor(record) { this.__record = record; }
    get name() { return this.__record.name; }
    get type() { return this.__record.type; }
    async getMediaFilePath() {
      tick();
      return `${o.mediaPathPrefix}${this.__record.mediaPath}`;
    }
    async getInPoint(mediaType) {
      tick();
      if (mediaType !== Constants.MediaType.VIDEO) throw new Error('Illegal Parameter type');
      return new TickTime(o.lengthUnreadable ? 0 : this.__record.in);
    }
    async getOutPoint(mediaType) {
      tick();
      if (mediaType !== Constants.MediaType.VIDEO) throw new Error('Illegal Parameter type');
      return new TickTime(o.lengthUnreadable ? 0 : this.__record.out);
    }
  }
  const recordOf = (x) => x?.__record ?? null;

  class ComponentParam {
    constructor(record) {
      this.__record = record;
      live(this);
    }
    async getStartValue() {
      tick();
      alive(this);
      const { value } = this.__record;
      if (Array.isArray(value) && o.startValueShape === 'pointf') return { position: new TickTime(0), value: { value: new PointF(...value) } };
      return { position: new TickTime(0), value: { value: Array.isArray(value) ? [...value] : value } }; // (mcp #765)
    }
    createKeyframe(value) {
      alive(this);
      const ok = this.__record.kind === 'point' ? value instanceof PointF : typeof value === typeof this.__record.value;
      if (!ok) throw new Error('Illegal Parameter type');
      return new Keyframe(value);
    }
    createSetValueAction(keyframe) {
      alive(this);
      needLock();
      if (!(keyframe instanceof Keyframe)) throw new Error('Illegal Parameter type');
      const record = this.__record;
      return action('set a value', () => null, () => {
        const v = keyframe.__value;
        record.value = v instanceof PointF ? [Math.fround(v.x), Math.fround(v.y)] : typeof v === 'number' ? Math.fround(v) : v;
      });
    }
    isTimeVarying() { return false; }
  }
  class Component {
    constructor(record) {
      this.__record = record;
      live(this);
    }
    async getMatchName() {
      tick();
      alive(this);
      return this.__record.matchName;
    }
    getParamCount() {
      alive(this);
      return this.__record.params.length;
    }
    getParam(index = 0) {
      alive(this);
      if (!this.__record.params[index]) throw new Error('Illegal Parameter type');
      return new ComponentParam(this.__record.params[index]);
    }
  }
  class VideoComponentChain {
    constructor(clip) {
      this.__clip = clip;
      live(this);
    }
    getComponentCount() {
      alive(this);
      return this.__clip.components.length;
    }
    getComponentAtIndex(index) {
      alive(this);
      return new Component(this.__clip.components[index]);
    }
  }
  class VideoClipTrackItem {
    constructor(clip) {
      this.__clip = clip;
      live(this);
    }
    async getStartTime() {
      tick();
      alive(this);
      return new TickTime(this.__clip.start);
    }
    async getEndTime() {
      tick();
      alive(this);
      return new TickTime(this.__clip.end);
    }
    async getProjectItem() {
      tick();
      alive(this);
      if (o.placedProjectItemFails && this.__clip.placed) throw new Error('Illegal Parameter type');
      return new ProjectItem(this.__clip.item);
    }
    async getComponentChain() {
      tick();
      alive(this);
      return new VideoComponentChain(this.__clip);
    }
  }
  class VideoTrack {
    constructor(record) {
      this.__record = record;
      live(this);
    }
    getTrackItems(type) { // synchronous, as the premierepro module wraps it
      tick();
      alive(this);
      if (type !== Constants.TrackItemType.CLIP) return [];
      return [...this.__record.clips].sort((a, b) => a.start - b.start).map((clip) => new VideoClipTrackItem(clip));
    }
    async isMuted() {
      tick();
      alive(this);
      return Boolean(this.__record.muted);
    }
  }
  class Sequence {
    constructor() { live(this); }
    get guid() {
      alive(this);
      return new Guid(seq.guid);
    }
    get name() {
      alive(this);
      return seq.name;
    }
    async getPlayerPosition() {
      tick();
      alive(this);
      return new TickTime(seq.playhead);
    }
    async getFrameSize() {
      tick();
      alive(this);
      return { width: seq.width, height: seq.height };
    }
    async getTimebase() {
      tick();
      alive(this);
      return seq.timebase;
    }
    async getZeroPoint() {
      tick();
      alive(this);
      return new TickTime(ticksOf(o.zeroPoint));
    }
    async getSequenceVideoTimeDisplayFormat() {
      tick();
      alive(this);
      return { type: o.dropFrame ? Constants.VideoDisplayFormatType.FPS_29_97 : Constants.VideoDisplayFormatType.FPS_29_97_NON_DROP };
    }
    async getVideoTrackCount() {
      tick();
      alive(this);
      return seq.video.length;
    }
    async getAudioTrackCount() {
      tick();
      alive(this);
      return seq.audio.length;
    }
    async getVideoTrack(index) {
      tick();
      alive(this);
      if (!seq.video[index]) throw new Error('Illegal Parameter type');
      return new VideoTrack(seq.video[index]);
    }
  }

  // ---- edits ----
  const lengthOf = (item) => item.out - item.in;
  const placedClip = (item, start) => clipRecord(item, start, start + lengthOf(item), { placed: true });
  const trackProblem = (index, context, insert = false) => {
    if (index < seq.video.length) return seq.video[index].locked ? `V${index + 1} is locked` : null;
    if (!insert && !o.overwriteMakesTrack) return `there is no V${index + 1}`;
    if (index === seq.video.length && !context.newTrack) {
      context.newTrack = true; // (one new track per transaction)
      return null;
    }
    return `there is no V${index + 1}`;
  };
  const trackAt = (index) => {
    if (index === seq.video.length) seq.video.push({ locked: false, clips: [] });
    return seq.video[index];
  };
  /** Overwrite: cuts away whatever is under [start, end) on the track, keeping both sides. */
  const clear = (track, start, end) => {
    const kept = [];
    for (const c of track.clips) {
      if (c.end <= start || c.start >= end) kept.push(c);
      else {
        if (c.start < start) kept.push({ ...c, end: start });
        if (c.end > end) kept.push({ ...c, id: c.start < start ? newId('clip') : c.id, start: end });
      }
    }
    track.clips = kept;
  };
  /** Insert: everything at or after `at` moves on by `by` (a clip across `at` is split). */
  const shift = (track, at, by) => {
    const out = [];
    for (const c of track.clips) {
      if (c.end <= at) out.push(c);
      else if (c.start >= at) out.push({ ...c, start: c.start + by, end: c.end + by });
      else out.push({ ...c, end: at }, { ...c, id: newId('clip'), start: at + by, end: c.end + by });
    }
    track.clips = out;
  };
  const placing = (item, time, video, audio) => {
    if (!(item instanceof ProjectItem)) throw new Error('Invalid parameter.'); // (a cast clip is refused: CutDeck)
    item.__alive();
    if (!(time instanceof TickTime)) throw new Error('Illegal Parameter type');
    if (![video, audio].every((n) => Number.isInteger(n) && n >= 0)) throw new Error('Illegal Parameter type');
  };
  class SequenceEditor {
    constructor() { live(this); }
    createOverwriteItemAction(item, time, video, audio) {
      alive(this);
      needLock();
      placing(item, time, video, audio);
      const record = recordOf(item);
      return action(`overwrite on V${video + 1}`, (context) => trackProblem(video, context), () => {
        const track = trackAt(video);
        clear(track, time.ticksNumber, time.ticksNumber + lengthOf(record));
        track.clips.push(placedClip(record, time.ticksNumber));
      });
    }
    createInsertProjectItemAction(item, time, video, audio, limitShift) {
      alive(this);
      needLock();
      placing(item, time, video, audio);
      const next = video >= seq.video.length;
      if (next && o.insert === 'throws') throw new Error('Illegal Parameter type');
      const record = recordOf(item);
      const target = next && o.insert === 'clamp' ? seq.video.length - 1 : video;
      return action(`insert on V${target + 1}`, (context) => (next && o.insert === 'noop' ? null : trackProblem(target, context, true)), () => {
        if (next && o.insert === 'noop') return; // (success, and nothing on the timeline: CutDeck's SRT finding)
        const by = lengthOf(record);
        const track = trackAt(target);
        shift(track, time.ticksNumber, by);
        track.clips.push(placedClip(record, time.ticksNumber));
        if (!limitShift || o.rippleAll) {
          seq.video.forEach((t, i) => { if (i !== target) shift(t, time.ticksNumber, by); });
          seq.audio.forEach((t) => shift(t, time.ticksNumber, by));
        }
      });
    }
  }

  // ---- the project and the module ----
  const project = {
    get guid() { return new Guid('project-guid-1'); },
    get name() { return 'Stream Edit'; },
    get path() { return o.projectPath; },
    async getActiveSequence() {
      tick();
      return new Sequence();
    },
    getSequence(guid) {
      tick();
      const found = String(guid) === seq.guid ? new Sequence() : null;
      return o.getSequenceAsync ? Promise.resolve(found) : found;
    },
    async getRootItem() {
      tick();
      return new FolderItem(root);
    },
    async importFiles(paths, suppressUI, targetBin) {
      tick();
      o.hooks.onImport?.();
      if (!Array.isArray(paths)) throw new Error('Illegal Parameter type');
      if (paths.some((p) => !disk.get(key(p)) || disk.get(key(p)).folder)) return false;
      let bin = root;
      if (targetBin != null) {
        const record = recordOf(targetBin);
        if (!record || !['bin', 'root'].includes(record.kind)) throw new Error('Illegal Parameter type');
        bin = record;
      }
      world.imports.push({ paths: [...paths], bin: bin.name });
      later(o.importDelayMs, () => {
        for (const p of paths) {
          const name = plain(p).split('\\').pop();
          bin.children.push({ kind: 'clip', id: newId('item'), name, type: TYPE.CLIP, mediaPath: plain(p), in: 0, out: ticksOf(/\.mp4$/i.test(name) ? o.mp4Seconds : o.stillSeconds) });
        }
        if (o.importBumpsEpoch) world.epoch++;
      });
      return true;
    },
    lockedAccess(callback) {
      world.lockDepth++;
      try {
        callback();
      } finally {
        world.lockDepth--;
      }
    },
    executeTransaction(callback, label = 'Edit Project') {
      tick();
      const txn = { id: ++world.txnSeq, actions: [] };
      const outer = world.txn;
      world.txn = txn;
      const compound = {
        addAction(a) {
          if (!a || a.__txn !== txn.id) throw new Error(STALE); // (an action made outside the callback: CutDeck)
          txn.actions.push(a);
          return true;
        },
        get empty() { return txn.actions.length === 0; },
      };
      try {
        callback(compound);
      } finally {
        world.txn = outer;
      }
      const context = {};
      for (const a of txn.actions) {
        const problem = a.check(context);
        if (problem) {
          world.refused.push(`${label}: ${problem}`);
          return false;
        }
      }
      for (const a of txn.actions) a.apply();
      world.history.push(label);
      world.epoch++;
      world.projectEpoch++;
      return true;
    },
  };

  const ppro = {
    Constants,
    Project: {
      getActiveProject: async () => {
        tick();
        return project;
      },
      getProject: (guid) => (String(guid) === 'project-guid-1' ? project : null),
    },
    ProjectItem: { TYPE_CLIP: TYPE.CLIP, TYPE_BIN: TYPE.BIN, TYPE_ROOT: TYPE.ROOT, TYPE_FILE: TYPE.FILE, cast: (x) => (recordOf(x) ? new ProjectItem(recordOf(x), { cast: true }) : null) },
    FolderItem: { cast: (x) => (['bin', 'root'].includes(recordOf(x)?.kind) ? new FolderItem(recordOf(x)) : null) },
    ClipProjectItem: { cast: (x) => (recordOf(x)?.kind === 'clip' ? new ClipProjectItem(recordOf(x)) : null) },
    SequenceEditor: {
      getEditor: (sequence) => {
        alive(sequence);
        return new SequenceEditor();
      },
    },
    TickTime,
    PointF,
    Exporter: {
      async exportSequenceFrame(sequence, time, filename, folder, width, height) {
        tick();
        alive(sequence);
        if (!(time instanceof TickTime)) throw new Error('Illegal Parameter type');
        if (!/\.(png|jpe?g|bmp|gif|tga|tiff?|dpx|exr)$/i.test(filename)) throw new Error('File Format is not supported'); // (mcp #801)
        world.exports.push({ filename, folder, width, height, seconds: time.seconds });
        if (o.exportName === 'never') return true;
        const p = `${folder}\\${filename}${o.exportName === 'doubled' ? '.png' : ''}`;
        const bytes = pngBytes(width, height, 8192);
        // The file appears part-written, then grows every 50 ms until it is whole (after a pause, if asked).
        const first = 3000;
        const steps = Math.max(1, Math.ceil(o.exportWriteMs / 50));
        later(o.exportDelayMs, () => putFile(p, bytes, first));
        for (let i = 1; i <= steps; i++) {
          const visible = Math.round(first + ((bytes.length - first) * i) / steps);
          later(o.exportDelayMs + o.exportStallMs + i * 50, () => { const r = disk.get(key(p)); if (r) r.visible = visible; });
        }
        return true;
      },
    },
  };

  const motionOf = (clip) => {
    const motion = clip.components.find((c) => c.matchName === 'AE.ADBE Motion');
    return motion ? { position: [...motion.params[0].value], scale: motion.params[1].value } : null;
  };
  const describeBin = (bin) => ({ name: bin.name, items: bin.children.map((c) => (c.kind === 'bin' ? describeBin(c) : c.name)) });
  const snapshot = () => ({
    video: seq.video.map((t) => [...t.clips].sort((a, b) => a.start - b.start).map((c) => ({ id: c.id, name: c.item.name, start: seconds(c.start), end: seconds(c.end), motion: motionOf(c), placed: Boolean(c.placed) }))),
    audio: seq.audio.map((t) => [...t.clips].sort((a, b) => a.start - b.start).map((c) => ({ id: c.id, name: c.item.name, start: seconds(c.start), end: seconds(c.end) }))),
    project: describeBin(root),
    files: [...disk.values()].filter((r) => !r.folder).map((r) => r.path).sort(),
    history: [...world.history],
  });
  return { ppro, uxp, fs: fsModule, clock, world, snapshot, TEMP, pngBytes };
}

/**
 * Loads one of the plugin's files the way UXP does (CommonJS), with `modules` for what it requires by name and
 * `globals` in place of the global objects it uses; its own requires of './…' load the same way.
 */
function pluginLoader({ modules, globals }) {
  const cache = new Map();
  const load = (file) => {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    const names = Object.keys(globals);
    const run = vm.compileFunction(fs.readFileSync(file, 'utf8'), ['require', 'module', 'exports', '__filename', '__dirname', ...names], { filename: file });
    const require = (request) => {
      if (Object.hasOwn(modules, request)) return modules[request];
      if (request.startsWith('.')) return load(path.resolve(path.dirname(file), request));
      throw new Error(`${path.basename(file)} requires ${request}, which UXP doesn't have`);
    };
    run(require, module, module.exports, file, path.dirname(file), ...names.map((n) => globals[n]));
    return module.exports;
  };
  return load;
}

/** Timers on the stand-in's virtual clock: a wait passes at once and moves the clock on. */
const virtualTimers = (clock) => ({
  setTimeout: (fn, ms = 0, ...args) => {
    clock.now += Math.max(0, Number(ms) || 0);
    return setImmediate(() => fn(...args));
  },
  setInterval: () => 0,
});

/** premiere-plugin/lib/premiere.js running against `premiere` (createPremiere()), with what it logged. */
function loadPremiereJs(premiere) {
  const logged = [];
  const console = { log: (...parts) => logged.push(parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')), warn() {}, error() {} };
  const load = pluginLoader({
    modules: { premierepro: premiere.ppro, uxp: premiere.uxp, fs: premiere.fs },
    globals: { ...virtualTimers(premiere.clock), console },
  });
  return { api: load(path.join(PLUGIN, 'lib', 'premiere.js')), logged };
}

/** The clips that moved, changed or went between `before` and `after`, and the ones that are new. */
function compare(before, after) {
  const changed = [];
  const known = new Set();
  before.video.forEach((clips, i) => {
    for (const clip of clips) {
      known.add(clip.id);
      const now = after.video[i]?.find((c) => c.id === clip.id);
      if (!now) changed.push(`V${i + 1} ${clip.name} ${clip.start}-${clip.end} is gone`);
      else if (now.start !== clip.start || now.end !== clip.end) changed.push(`V${i + 1} ${clip.name} ${clip.start}-${clip.end} is now ${now.start}-${now.end}`);
      else if (JSON.stringify(now.motion) !== JSON.stringify(clip.motion)) changed.push(`V${i + 1} ${clip.name}'s Motion changed`);
    }
  });
  before.audio.forEach((clips, i) => {
    for (const clip of clips) {
      const now = after.audio[i]?.find((c) => c.id === clip.id);
      if (!now || now.start !== clip.start || now.end !== clip.end) changed.push(`A${i + 1} ${clip.name} ${clip.start}-${clip.end} moved`);
    }
  });
  const added = [];
  after.video.forEach((clips, i) => {
    for (const clip of clips) {
      if (known.has(clip.id)) continue;
      if (clip.placed) added.push({ track: i + 1, ...clip });
      else changed.push(`V${i + 1} ${clip.name} has a new piece at ${clip.start}-${clip.end}`);
    }
  });
  return { changed, added };
}

const FILE_NAME = 'comment-invented-viewer-20261011-153012.png';
const FOLDER = String.raw`C:\Users\Test\Videos\YouTube Chat Comments`;
// A 480 × 56 comment with its top-left at (1400, 700) of the 1920 × 1080 frame, at 1:1.
// Where Premiere Pro puts a new clip, and the size: the middle of the frame, at 100%.
const AS_PLACED = { position: [0.5, 0.5], scale: 100 };

/** Grabs the frame, then places a PNG (or an MP4) with `premiere.js` against a stand-in made with `options`. */
async function place(options = {}, { kind = 'png', fileName = FILE_NAME, duration } = {}) {
  const premiere = createPremiere(options);
  const { api, logged } = loadPremiereJs(premiere);
  const grab = await api.grabFrame();
  const before = premiere.snapshot();
  const bytes = kind === 'png' ? pngBytes(480, 56).buffer : new TextEncoder().encode('\0\0\0\x18ftypisom-and-the-rest').buffer;
  let result = null;
  let error = null;
  try {
    result = await api.place(grab, { bytes, kind, fileName, duration }); // (duration: as the app reports an MP4's)
  } catch (e) {
    error = e;
  }
  const after = premiere.snapshot();
  return { premiere, grab, before, after, result, error, logged, ...compare(before, after) };
}

/** What a run of place() left behind, for a failure's message. */
const describeRun = (run) => JSON.stringify({
  error: run.error?.message ?? null,
  result: run.result,
  placed: run.added.map((c) => `V${c.track} ${c.start}-${Number(c.end.toFixed(3))} ${JSON.stringify(c.motion)}`),
  changed: run.changed,
  imported: run.premiere.world.imports.map((i) => `${i.paths.map((p) => path.win32.basename(p)).join()} into ${i.bin}`),
  undo: run.after.history,
  refused: run.premiere.world.refused,
}, null, 1);

// ---- grabbing the frame -------------------------------------------------------------------------------------

test('the frame comes from the sequence at the playhead, at its size, once the file is all there', async () => {
  const premiere = createPremiere({ exportName: 'doubled' }); // (some versions write frame-….png.png)
  const { api } = loadPremiereJs(premiere);
  const grab = await api.grabFrame();
  assert.deepEqual(premiere.world.exports.map(({ width, height, seconds: s }) => ({ width, height, s })), [{ width: 1920, height: 1080, s: 125.5 }]);
  assert.match(premiere.world.exports[0].filename, /^frame-\d+\.png$/);
  assert.ok(grab.file.endsWith('.png.png'), grab.file);
  assert.equal(grab.bytes.byteLength, 8192, 'the whole file, not the part written when the export resolved');
  assert.ok(endsLikePng(grab.bytes));
  assert.deepEqual(
    { ticks: grab.ticks, seconds: grab.seconds, size: grab.size, fps: grab.fps, name: grab.name, start: grab.start, dropFrame: grab.dropFrame },
    { ticks: String(ticksOf(125.5)), seconds: 125.5, size: { width: 1920, height: 1080 }, fps: 30, name: 'Stream 01', start: 0, dropFrame: false },
  );
  const temp = premiere.snapshot().files.filter((f) => f.startsWith(premiere.TEMP)).map((f) => path.win32.basename(f));
  assert.deepEqual(temp.sort(), [path.win32.basename(grab.file), 'notes.txt'].sort(), 'earlier frames are removed, nothing else');
});

test("an export that never appears is reported after Premiere's wait, not forever", async () => {
  const premiere = createPremiere({ exportName: 'never' });
  const { api } = loadPremiereJs(premiere);
  await assert.rejects(api.grabFrame(), /didn't appear/);
  assert.ok(premiere.clock.now >= 15_000 && premiere.clock.now < 20_000, `gave up after ${premiere.clock.now} ms`);
});

test('a frame whose file stops growing for a moment is not taken half-written', async () => {
  const premiere = createPremiere({ exportStallMs: 400 });
  const { api } = loadPremiereJs(premiere);
  const grab = await api.grabFrame();
  assert.ok(endsLikePng(grab.bytes), `the panel took ${grab.bytes.byteLength} of 8192 bytes`);
});

// ---- putting the comment on the timeline ------------------------------------------------------------------------

test('on an empty V2 above V1: the file beside the project, its bin, the clip at the frame’s time at its own size', async () => {
  const run = await place();
  assert.equal(run.error, null, run.error?.stack);
  assert.deepEqual(run.result, { path: `${FOLDER}\\${FILE_NAME}`, track: 2, rescaled: false });
  assert.ok(run.after.files.includes(`${FOLDER}\\${FILE_NAME}`), 'written beside the project (without the \\\\?\\ prefix)');
  assert.deepEqual(run.after.project.items.at(-1), { name: BIN, items: [FILE_NAME] }, 'imported into its bin');
  assert.deepEqual(run.changed, [], 'nothing else moved');
  assert.equal(run.added.length, 1);
  const [clip] = run.added;
  assert.deepEqual({ track: clip.track, name: clip.name, start: clip.start, end: clip.end }, { track: 2, name: FILE_NAME, start: 125.5, end: 130.5 });
  assert.deepEqual(clip.motion, AS_PLACED, 'left where Premiere Pro puts it, at 100%');
  assert.deepEqual(run.after.history, [`Add the ${BIN} bin`, 'Add YouTube chat comment']);
  assert.equal(run.after.video.length, 2, 'no new track');
});

test('a second comment goes into the same bin, on the next free track', async () => {
  const premiere = createPremiere();
  const { api } = loadPremiereJs(premiere);
  const grab = await api.grabFrame();
  await api.place(grab, { bytes: pngBytes(480, 56).buffer, kind: 'png', fileName: FILE_NAME });
  const second = await api.place(grab, { bytes: pngBytes(480, 56).buffer, kind: 'png', fileName: 'comment-other-viewer-20261011-153100.png' });
  assert.equal(second.track, 3);
  const after = premiere.snapshot();
  assert.deepEqual(after.project.items.filter((i) => i.name === BIN), [{ name: BIN, items: [FILE_NAME, 'comment-other-viewer-20261011-153100.png'] }]);
});

test('every track busy at the playhead: a new track on top, nothing shifted', async () => {
  const run = await place({ video: [[{ name: 'stream.mp4', start: 0, end: 600 }], [{ name: 'webcam.mov', start: 100, end: 200 }], [{ name: 'title.png', start: 120, end: 130 }]] });
  assert.equal(run.error, null, run.error?.stack);
  assert.equal(run.result.track, 4);
  assert.deepEqual(run.changed, []);
  assert.deepEqual(run.added.map((c) => [c.track, c.start, c.end]), [[4, 125.5, 130.5]]);
});

test('an empty-looking V2 with a clip later in the comment’s 5 s is left alone', async () => {
  const run = await place({ video: [[{ name: 'stream.mp4', start: 0, end: 600 }], [{ name: 'sticker.png', start: 128, end: 140 }]] });
  assert.equal(run.error, null, run.error?.stack);
  assert.equal(run.result.track, 3);
  assert.deepEqual(run.changed, []);
});

test('a clip that ends just before the playhead (or at it) leaves its track free', async () => {
  for (const end of [125.5 - 1 / 30, 125.5]) {
    const run = await place({ video: [[{ name: 'stream.mp4', start: 0, end: 600 }], [{ name: 'earlier.png', start: 100, end }]] });
    assert.equal(run.error, null, run.error?.stack);
    assert.equal(run.result.track, 2, `ending at ${end}`);
    assert.deepEqual(run.changed, [], `ending at ${end}`);
  }
});

test('a locked V2: refused there, so a new V3', async () => {
  const run = await place({ locked: [1] });
  assert.equal(run.error, null, run.error?.stack);
  assert.equal(run.result.track, 3);
  assert.deepEqual(run.changed, []);
  assert.deepEqual(run.premiere.world.refused, ['Add YouTube chat comment: V2 is locked']);
});

test('when the bin can’t be made, the item is found in the root and placed', async () => {
  const run = await place({ binFails: true });
  assert.equal(run.error, null, run.error?.stack);
  assert.equal(run.result.track, 2);
  assert.ok(run.after.project.items.includes(FILE_NAME), 'in the root');
});

test('an unsaved project: told to save it, and nothing written, imported or placed', async () => {
  const run = await place({ projectPath: '' });
  assert.match(String(run.error?.message), /Save the project first/);
  assert.deepEqual(run.after.files, run.before.files);
  assert.deepEqual(run.premiere.world.imports, []);
  assert.deepEqual(run.after.video, run.before.video);
});

test('a project on a network share (\\\\?\\UNC\\…) keeps the comment beside it', async () => {
  const run = await place({ projectPath: String.raw`\\?\UNC\nas\shows\Stream Edit.prproj` });
  assert.equal(run.error, null, describeRun(run));
  assert.equal(run.result?.path, `${String.raw`\\nas\shows\YouTube Chat Comments`}\\${FILE_NAME}`);
});

test('a media path that comes back with \\\\?\\ still matches the file', async () => {
  const run = await place({ mediaPathPrefix: '\\\\?\\' });
  assert.equal(run.error, null, describeRun(run));
  assert.equal(run.result.track, 2);
});

test('a clip without Motion is placed as it is', async () => {
  const run = await place({ motion: false });
  assert.equal(run.error, null, run.error?.stack);
  assert.deepEqual({ track: run.result.track, rescaled: run.result.rescaled }, { track: 2, rescaled: false });
  assert.deepEqual(run.after.history.slice(-1), ['Add YouTube chat comment']);
});

test('a still Premiere scaled to the frame on import gets its own size back, and stays where it was put', async () => {
  const run = await place({ startScale: 25 }); // (Default Media Scaling: Set to Frame Size)
  assert.equal(run.error, null, run.error?.stack);
  assert.deepEqual(run.added[0].motion, AS_PLACED);
  assert.equal(run.result.rescaled, true);
  assert.deepEqual(run.after.history.slice(-1), ['Show YouTube chat comment at its own size']);
});

test("a typing video is placed for its whole length, past a clip that starts inside it", async () => {
  const run = await place(
    { mp4Seconds: 15.8, video: [[{ name: 'stream.mp4', start: 0, end: 600 }], [{ name: 'sticker.png', start: 137, end: 150 }]] },
    { kind: 'mp4', fileName: 'comment-invented-viewer-20261011-153012.mp4', duration: 15.8 },
  );
  assert.equal(run.error, null, run.error?.stack);
  assert.equal(run.result.track, 3);
  assert.deepEqual(run.changed, []);
  assert.deepEqual(run.added.map((c) => [c.track, c.start, Number(c.end.toFixed(3))]), [[3, 125.5, 141.3]]);
});

test("when an overwrite can't make the next track, an insert there does, shifting nothing", async () => {
  const busy = [[{ name: 'stream.mp4', start: 0, end: 600 }], [{ name: 'webcam.mov', start: 100, end: 200 }]];
  const run = await place({ video: busy, overwriteMakesTrack: false });
  assert.equal(run.error, null, describeRun(run));
  assert.equal(run.result.track, 3);
  assert.deepEqual(run.changed, []);
  assert.equal(run.added.length, 1);
});

test('an insert that makes no track falls back to an overwrite on the next track', async () => {
  const busy = [[{ name: 'stream.mp4', start: 0, end: 600 }], [{ name: 'webcam.mov', start: 100, end: 200 }]];
  const run = await place({ video: busy, insert: 'noop' });
  assert.equal(run.error, null, describeRun(run));
  assert.equal(run.result.track, 3);
  assert.deepEqual(run.changed, []);
  assert.equal(run.added.length, 1);
});

test('an insert that throws at the next track index still falls back to the overwrite there', async () => {
  const busy = [[{ name: 'stream.mp4', start: 0, end: 600 }], [{ name: 'webcam.mov', start: 100, end: 200 }]];
  const run = await place({ video: busy, insert: 'throws' });
  assert.equal(run.error, null, describeRun(run));
  assert.equal(run.result?.track, 3);
});

test('an insert that lands on the top track instead of a new one moves nothing else', async () => {
  const busy = [[{ name: 'stream.mp4', start: 0, end: 600 }], [{ name: 'webcam.mov', start: 100, end: 200 }, { name: 'outro.mov', start: 500, end: 560 }]];
  const run = await place({ video: busy, insert: 'clamp' });
  assert.equal(run.error, null, describeRun(run));
  assert.deepEqual(run.changed, [], `nothing else moved: ${describeRun(run)}`);
  assert.equal(run.added.length, 1, `one copy of the comment, not ${run.added.length}`);
});

test("an insert that ripples every track (sync lock) is noticed, not reported as a success", async () => {
  const busy = [[{ name: 'stream.mp4', start: 0, end: 600 }], [{ name: 'webcam.mov', start: 100, end: 200 }]];
  const run = await place({ video: busy, rippleAll: true });
  assert.deepEqual(run.changed, [], `nothing else moved: ${describeRun(run)}`);
});

test("a typing video's length comes from the file when Premiere can't tell it yet", async () => {
  // A 15.8 s video (a long comment); V2 holds a clip from 137 s, inside the video but past a 10 s guess.
  const run = await place(
    { mp4Seconds: 15.8, lengthUnreadable: true, video: [[{ name: 'stream.mp4', start: 0, end: 600 }], [{ name: 'sticker.png', start: 137, end: 150 }]] },
    { kind: 'mp4', fileName: 'comment-invented-viewer-20261011-153012.mp4', duration: 15.8 },
  );
  assert.equal(run.error, null, describeRun(run));
  assert.deepEqual(run.changed, [], `nothing cut: ${describeRun(run)}`);
});

test('Premiere 27.0 (Project.getSequence() returns a promise) still places the comment', async () => {
  const run = await place({ getSequenceAsync: true });
  assert.equal(run.error, null, describeRun(run));
  assert.equal(run.result?.track, 2);
});

test('project items that go stale after a transaction too', async () => {
  const run = await place({ staleProjectItems: true });
  assert.equal(run.error, null, describeRun(run));
  assert.equal(run.result?.track, 2);
});

test('items handed over without getId() (until ProjectItem.cast, as mcp #801 found) still work', async () => {
  const run = await place({ itemsLackGetId: true });
  assert.equal(run.error, null, describeRun(run));
  assert.equal(run.result?.track, 2);
});

test('a placed clip that the panel cannot confirm is not placed again elsewhere', async () => {
  const run = await place({ placedProjectItemFails: true });
  assert.ok(run.added.length <= 1, describeRun(run));
});

test("a still whose length Premiere can't tell yet goes on a new track, never over what might be under it", async () => {
  const run = await place({ lengthUnreadable: true });
  assert.equal(run.error, null, describeRun(run));
  assert.equal(run.result.track, 3, 'a new V3, though V2 looks empty');
  assert.deepEqual(run.changed, []);
});

test('a track whose output is switched off is passed over: the comment would not show there', async () => {
  const run = await place({ muted: [1] });
  assert.equal(run.error, null, describeRun(run));
  assert.equal(run.result.track, 3);
  assert.deepEqual(run.changed, []);
});

test('an insert that lands on the top track instead of a new one is reported, with how to undo it', async () => {
  const busy = [[{ name: 'stream.mp4', start: 0, end: 600 }], [{ name: 'webcam.mov', start: 100, end: 200 }, { name: 'outro.mov', start: 500, end: 560 }]];
  const run = await place({ video: busy, overwriteMakesTrack: false, insert: 'clamp' });
  assert.match(String(run.error?.message), /also changed V2.*Ctrl\+Z/, describeRun(run));
  assert.ok(run.added.length <= 1, `one copy at most: ${describeRun(run)}`);
});

test('an insert that ripples every track (sync lock) is reported, not taken for a success', async () => {
  const busy = [[{ name: 'stream.mp4', start: 0, end: 600 }], [{ name: 'webcam.mov', start: 100, end: 200 }]];
  const run = await place({ video: busy, overwriteMakesTrack: false, rippleAll: true });
  assert.match(String(run.error?.message), /also changed V1, V2/, describeRun(run));
});

test('a sequence that starts at 01:00:00:00 and counts drop-frame gets the Timeline’s own timecode', async () => {
  const premiere = createPremiere({ fps: 30000 / 1001, zeroPoint: 3600, dropFrame: true });
  const { api } = loadPremiereJs(premiere);
  const grab = await api.grabFrame();
  assert.deepEqual({ start: grab.start, dropFrame: grab.dropFrame }, { start: 3600, dropFrame: true });
  const { timecode } = createRequire(import.meta.url)(path.join(PLUGIN, 'lib', 'geometry.js'));
  // 3725.5 s at 30000/1001 fps is frame 111653, shown as 01:02:05;15 once the dropped numbers are skipped.
  assert.equal(timecode(grab.seconds, grab.fps, grab), '01:02:05;15');
});

// ---- the panel (panel.js) with the app's real side of the link ------------------------------------------------

/** Just enough DOM for panel.js: elements by id, their attributes, styles, text and listeners. */
function createDom() {
  class Element {
    constructor(id) {
      this.id = id;
      this.style = { display: '' };
      this.attributes = new Map();
      this.listeners = new Map();
      this.texts = [];
      this._text = '';
      this.className = '';
      this.checked = false;
      this.disabled = false;
      this.src = '';
    }
    get textContent() { return this._text; }
    set textContent(text) {
      this._text = String(text);
      this.texts.push(this._text);
    }
    addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
    fire(type, event = {}) { return (this.listeners.get(type) ?? []).map((fn) => fn({ type, target: this, ...event })); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    removeAttribute(name) { this.attributes.delete(name); }
    hasAttribute(name) { return this.attributes.has(name); }
    getBoundingClientRect() { return { left: 0, top: 0, width: 400, height: 225, right: 400, bottom: 225 }; }
    setPointerCapture() {}
  }
  const elements = new Map(['connection', 'grab', 'zoom', 'whole', 'stage', 'frame', 'box', 'hint', 'read', 'cancel', 'status'].map((id) => [id, new Element(id)]));
  elements.get('stage').clientWidth = 400;
  const windowListeners = new Map();
  return {
    $: (id) => elements.get(id),
    document: { getElementById: (id) => elements.get(id) ?? null },
    window: {
      addEventListener: (type, fn) => windowListeners.set(type, [...(windowListeners.get(type) ?? []), fn]),
      listeners: windowListeners,
    },
  };
}

const waitFor = async (read, what, ms = 10_000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/**
 * panel.js running against `premiere` and the app's real bridge on a free port, which the panel reaches as it
 * would on 47811. Resolves to { dom, app, jobs, placed, cancelled, close }.
 */
async function startPanel(premiere) {
  const jobs = [];
  const placed = [];
  const cancelled = [];
  const app = await startPremiereBridge({ ports: [0], version: 'test', onJob: (job) => jobs.push(job), onPlaced: (id, message) => placed.push({ id, message }), onCancel: (id) => cancelled.push(id) });
  const dom = createDom();
  const logged = [];
  const load = pluginLoader({
    modules: { premierepro: premiere.ppro, uxp: premiere.uxp, fs: premiere.fs },
    globals: {
      ...virtualTimers(premiere.clock),
      console: { log: (...parts) => logged.push(parts.join(' ')), warn() {}, error() {} },
      document: dom.document,
      window: dom.window,
      fetch: (url, options) => fetch(String(url).replace(/^http:\/\/localhost:4781[123]\//, `http://localhost:${app.port}/`), options),
      URL: { createObjectURL: () => 'blob:frame', revokeObjectURL() {} },
      Blob,
    },
  });
  load(path.join(PLUGIN, 'panel.js'));
  await waitFor(() => /Connected/.test(dom.$('connection').textContent), 'the panel to find the app');
  return { dom, app, jobs, placed, cancelled, logged, close: () => app.close() };
}

/** Drags from frame point `a` to `b` on the panel's view of `view` (the whole frame unless zoomed), 400 CSS px wide. */
function drag(dom, a, b, view = { x: 0, y: 0, width: 1920, height: 1080 }) {
  const k = 400 / view.width;
  const at = (p) => ({ clientX: (p.x - view.x) * k, clientY: (p.y - view.y) * k, pointerId: 1 });
  const stage = dom.$('stage');
  stage.fire('pointerdown', at(a));
  stage.fire('pointermove', at(b));
  stage.fire('pointerup', at(b));
}

async function panelRun({ options = {}, cancelWhilePlacing = false, drawBox = (dom) => drag(dom, { x: 1392, y: 693 }, { x: 1886, y: 763 }) } = {}) {
  const hooks = {};
  const premiere = createPremiere({ ...options, hooks });
  const panel = await startPanel(premiere);
  const { dom, app, jobs } = panel;
  const status = dom.$('status');
  const ended = () => / (ok|error)$/.test(status.className); // (the panel says it placed it, or why not)
  try {
    dom.$('grab').fire('click');
    await waitFor(() => /Stream 01 at 00:02:05:15/.test(status.textContent), 'the frame');
    drawBox(dom);
    assert.equal(dom.$('read').hasAttribute('disabled'), false, 'Read comment is enabled once a box is drawn');
    dom.$('read').fire('click');
    const job = await waitFor(() => jobs[0] ?? (status.className.includes('error') && 'refused'), 'the frame to reach the app');
    if (job !== 'refused') {
      app.update(job.id, 'review', 'Check the comment.');
      await waitFor(() => /Check the comment in the YouTube Chat Comment app/.test(status.textContent), 'the review');
      // (Cancel at the moment the panel imports the file: it is putting it on the timeline by then.)
      if (cancelWhilePlacing) hooks.onImport = () => dom.$('cancel').fire('click');
      app.deliver(job.id, { kind: 'png', bytes: pngBytes(480, 56), width: 480, height: 56, name: 'Invented Viewer' });
      await waitFor(ended, 'the end').catch((error) => {
        throw new Error(`${error.message}; the panel said ${JSON.stringify(status.texts.slice(-3))} and logged ${JSON.stringify(panel.logged.slice(-3))}`);
      });
    }
    await waitFor(() => dom.$('cancel').style.display === 'none', 'the job to end', 3000).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { premiere, panel, job: job === 'refused' ? null : job, after: premiere.snapshot(), status: status.texts, statusClass: status.className };
  } finally {
    await panel.close();
  }
}

test('the panel, start to end: grab, box, read, review in the app, placed at its own size', async () => {
  const run = await panelRun();
  assert.deepEqual(run.job.rect, { x: 1392, y: 693, width: 494, height: 70 }, 'the box drawn, in frame pixels');
  const placedClip = run.after.video[1][0];
  assert.equal(placedClip.start, 125.5);
  assert.match(placedClip.name, /^comment-invented-viewer-\d{8}-\d{6}\.png$/);
  assert.deepEqual(placedClip.motion, AS_PLACED, 'not moved or scaled to the comment in the video');
  assert.equal(run.status.at(-1), 'Placed the image (480 × 56 px) on V2 at 00:02:05:15.');
  assert.deepEqual(run.panel.placed.map((p) => p.message), ['Placed the image (480 × 56 px) on V2 at 00:02:05:15.']);
});

test('the panel, zoomed in to draw the box closely: the box still in frame pixels', async () => {
  const { zoomTo } = createRequire(import.meta.url)(path.join(PLUGIN, 'lib', 'geometry.js'));
  const rough = { x: 1300, y: 640, width: 620, height: 180 };
  const run = await panelRun({
    drawBox: (dom) => {
      drag(dom, { x: rough.x, y: rough.y }, { x: rough.x + rough.width, y: rough.y + rough.height });
      dom.$('zoom').fire('click');
      assert.equal(dom.$('whole').hasAttribute('disabled'), false, 'Whole frame is offered once zoomed');
      drag(dom, { x: 1392, y: 693 }, { x: 1886, y: 763 }, zoomTo(rough, { width: 1920, height: 1080 }));
    },
  });
  assert.deepEqual(run.job.rect, { x: 1392, y: 693, width: 494, height: 70 });
  assert.deepEqual(run.after.video[1][0].motion, AS_PLACED);
});

test('Cancel while the comment is being put on the timeline does not claim to have cancelled it', async () => {
  const run = await panelRun({ cancelWhilePlacing: true });
  const placedClips = run.after.video.flat().filter((c) => c.name.startsWith('comment-'));
  const said = run.status.slice(run.status.indexOf('Putting it on the timeline…'));
  assert.ok(placedClips.length === 0 || !said.includes('Cancelled.'), `placed ${placedClips.length}; the panel said ${JSON.stringify(said)}`);
});

test('an unsaved project is caught before the app is asked to read the comment', async () => {
  const run = await panelRun({ options: { projectPath: '' } });
  assert.equal(run.panel.jobs.length, 0, `the app read and rendered the comment first; the panel then said ${JSON.stringify(run.status.at(-1))}`);
});
