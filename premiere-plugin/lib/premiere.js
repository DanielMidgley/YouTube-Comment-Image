// @ts-check
// What the panel asks of Premiere Pro, through its UXP API (the premierepro module; Adobe types it in the
// @adobe/premierepro package): the frame at the playhead, and the file the app made of its comment put on the
// timeline at that time, at the file's own size. Every edit's action is made inside project.lockedAccess() and its transaction, as Premiere 26.3
// and later require, and each transaction is one step of Undo. Script objects can go stale once a
// transaction (or an import) has run, so the project, sequence, tracks and the imported item are looked up
// afresh for each step. test/unit/premiere-panel.test.js runs all of this against a stand-in for Premiere.

/** @typedef {import('premierepro').Project} Project */
/** @typedef {import('premierepro').Sequence} Sequence */
/** @typedef {import('premierepro').TickTime} TickTime */
/** @typedef {import('premierepro').ProjectItem} ProjectItem */
/** @typedef {import('premierepro').FolderItem} FolderItem */
/** @typedef {import('premierepro').VideoTrack} VideoTrack */
/** @typedef {import('premierepro').VideoClipTrackItem} VideoClipTrackItem */

const ppro = require('premierepro');
const uxp = require('uxp');
const fs = require('fs');
const { framesPerSecond } = require('./geometry.js');

const BIN = 'YouTube Chat Comments'; // the project's bin for them, and the folder beside the project file
const MOTION = 'AE.ADBE Motion';
const EXPORT_WAIT_MS = 15_000; // the export's promise can resolve some time before the file is written
const IMPORT_WAIT_MS = 5000; // and an import's before the item shows in its bin
const POLL_MS = 100;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const reason = (error) => String(error?.message ?? error);

/** console.log with the panel's name: UXP's log file (see the README) doesn't say which plugin wrote a line. */
function log(...parts) {
  console.log('[YouTube Chat Comment]', ...parts);
}

/** An edit as one step of Undo: `make` creates the actions inside the lock. True when Premiere Pro did it. */
function edit(project, label, make) {
  let done = false;
  project.lockedAccess(() => {
    done = project.executeTransaction((compound) => {
      for (const action of make()) compound.addAction(action);
    }, label) === true;
  });
  return done;
}

/** A Windows path without the \\?\ prefix for long paths (\\?\UNC\server\share is \\server\share). */
function plainPath(p) {
  return String(p ?? '').replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
}

/**
 * The active project and sequence; an Error with a message for the user when there is none.
 * @returns {Promise<{ project: Project, sequence: Sequence }>}
 */
async function activeSequence() {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error('Open a project first.');
  const sequence = await project.getActiveSequence();
  if (!sequence) throw new Error('Open a sequence first: the frame comes from the one in the Timeline.');
  return { project, sequence };
}

/**
 * The active sequence's frame at the playhead, exported as a PNG at the sequence's size into the plugin's
 * temporary folder, where it stays for the panel to show (until the next frame). Resolves to
 * { projectGuid, sequenceGuid, ticks, seconds, size: { width, height }, bytes, file (its path), fps, start, name }
 * where start is the sequence's start time (its zero point) in seconds, for timecodes.
 */
async function grabFrame() {
  const { project, sequence } = await activeSequence();
  const time = await sequence.getPlayerPosition();
  const frameSize = await sequence.getFrameSize();
  const size = { width: Math.round(frameSize.width), height: Math.round(frameSize.height) };
  if (!(size.width > 0 && size.height > 0)) throw new Error("Couldn't tell the sequence's frame size.");
  const folder = await /** @type {any} */ (uxp.storage).localFileSystem.getTemporaryFolder();
  const name = `frame-${Date.now()}.png`;
  log('exporting the frame at', time.seconds, 's,', size.width, 'x', size.height, 'into', folder.nativePath);
  if (!(await ppro.Exporter.exportSequenceFrame(sequence, time, name, folder.nativePath, size.width, size.height))) {
    throw new Error("Premiere Pro couldn't export the frame at the playhead.");
  }
  const { file, bytes } = await exported(folder, name);
  await forgetFrames(folder, file.name);
  return {
    projectGuid: project.guid, sequenceGuid: sequence.guid, ticks: time.ticks, seconds: time.seconds, size, bytes,
    file: file.nativePath, fps: framesPerSecond(await sequence.getTimebase()), name: sequence.name, ...(await timecodeOf(sequence)),
  };
}

/**
 * How the sequence counts its timecode, for labels that match the Timeline: { start (its zero point, s),
 * dropFrame }. Plain counting from zero where Premiere doesn't say.
 */
async function timecodeOf(sequence) {
  let start = 0;
  let dropFrame = false;
  try {
    if (typeof sequence.getZeroPoint === 'function') start = (await sequence.getZeroPoint()).seconds || 0;
    const display = typeof sequence.getSequenceVideoTimeDisplayFormat === 'function' ? await sequence.getSequenceVideoTimeDisplayFormat() : null;
    const dropType = ppro.Constants.VideoDisplayFormatType?.FPS_29_97;
    dropFrame = display != null && dropType !== undefined && display.type === dropType;
  } catch (error) {
    log("couldn't read the sequence's timecode format:", reason(error));
  }
  return { start, dropFrame };
}

/**
 * The exported frame and its bytes, once it is all there: the export's promise can resolve before the file
 * exists, some versions add the format to the name ('frame.png.png'), and a file can stop growing for a moment
 * part-written. A whole PNG ends with its IEND chunk.
 */
async function exported(folder, name) {
  const sizes = new Map();
  for (let waited = 0; waited < EXPORT_WAIT_MS; waited += POLL_MS) {
    for (const candidate of [name, `${name}.png`]) {
      const entry = await folder.getEntry(candidate).catch(() => null);
      if (!entry) continue;
      const size = (await entry.getMetadata().catch(() => null))?.size ?? 0;
      if (size > 0 && size === sizes.get(candidate)) {
        const bytes = await entry.read({ format: uxp.storage.formats.binary });
        if (endsAsPng(bytes)) return { file: entry, bytes };
      }
      sizes.set(candidate, size);
    }
    await sleep(POLL_MS);
  }
  throw new Error("Premiere Pro said it exported the frame, but the file didn't appear.");
}

/** Whether `bytes` end as every PNG does: with an empty IEND chunk (its length, its name, its CRC). */
function endsAsPng(bytes) {
  const b = new Uint8Array(bytes);
  const at = b.length - 8;
  return at > 8 && b[at] === 0x49 && b[at + 1] === 0x45 && b[at + 2] === 0x4e && b[at + 3] === 0x44;
}

/** Removes earlier frames from the temporary folder (all but `keep`). */
async function forgetFrames(folder, keep) {
  for (const entry of await folder.getEntries().catch(() => [])) {
    if (entry.isFile && /^frame-\d+\.png/.test(entry.name) && entry.name !== keep) await entry.delete().catch(() => {});
  }
}

/**
 * The project and sequence the frame came from, as they are now; an Error for the user when either is gone.
 * (Project.getSequence() answers at once in 26.5 and with a promise from 27.0: awaiting covers both.)
 */
async function whereFrom(grab) {
  let project = null;
  let sequence = null;
  try {
    project = ppro.Project.getProject(grab.projectGuid);
    sequence = project ? await project.getSequence(grab.sequenceGuid) : null;
  } catch (error) {
    log('looking up the frame\'s sequence failed:', reason(error));
  }
  if (!project) throw new Error('The project the frame came from is closed.');
  if (!sequence) throw new Error(`The sequence "${grab.name}" the frame came from is gone.`);
  return { project, sequence };
}

/** The folder beside the project file for the comments' files, or '' when the project has never been saved. */
function folderFor(project) {
  const projectPath = plainPath(project.path);
  return projectPath ? `${projectPath.replace(/[\\/][^\\/]*$/, '')}\\${BIN}` : '';
}

/**
 * Throws, with a message for the user, when a comment couldn't go on the timeline the frame came from: asked
 * before the app reads and renders it, so nobody checks a comment for nothing.
 */
async function checkPlace(grab) {
  const { project } = await whereFrom(grab);
  if (!folderFor(project)) throw new Error('Save the project first: the comment is kept in a folder beside it.');
}

/** The comments' folder beside the project file (made if need be). */
async function commentsFolder(project) {
  const folder = folderFor(project);
  if (!folder) throw new Error('Save the project first: the comment is kept in a folder beside it.');
  await fs.mkdir(folder, { recursive: true }).catch((error) => {
    if (!/exist/i.test(reason(error))) throw error;
  });
  return folder;
}

/**
 * The project's bin for comments (made if need be), as the project item it is; null if it can't be made.
 * @param {Project} project
 * @returns {Promise<ProjectItem | null>}
 */
async function commentsBin(project) {
  const find = async () => (await (await project.getRootItem()).getItems())
    .find((item) => item.name === BIN && item.type === ppro.ProjectItem.TYPE_BIN) ?? null;
  try {
    const bin = await find();
    if (bin) return bin;
    const root = await project.getRootItem();
    edit(project, `Add the ${BIN} bin`, () => [root.createBinAction(BIN, false)]);
    return await find();
  } catch (error) {
    log('making the bin failed:', reason(error));
    return null;
  }
}

/**
 * The clip in `folder()` (or a bin inside it) whose media is the file at `path`: Windows paths, so letter case,
 * slashes and the \\?\ prefix aside. An import can take a moment to show.
 * @param {() => Promise<FolderItem>} folder
 * @param {string} path
 * @param {number} [waitMs]
 * @returns {Promise<ProjectItem | null>}
 */
async function itemFor(folder, path, waitMs = IMPORT_WAIT_MS) {
  const same = (/** @type {string} */ a, /** @type {string} */ b) => plainPath(a).replace(/\//g, '\\').toLowerCase()
    === plainPath(b).replace(/\//g, '\\').toLowerCase();
  /** @param {FolderItem} bin @returns {Promise<ProjectItem | null>} */
  const search = async (bin) => {
    for (const item of await bin.getItems()) {
      if (item.type === ppro.ProjectItem.TYPE_BIN) {
        const inside = await search(ppro.FolderItem.cast(item));
        if (inside) return inside;
        continue;
      }
      const clip = ppro.ClipProjectItem.cast(item);
      const media = clip ? await clip.getMediaFilePath().catch(() => '') : '';
      if (media && same(media, path)) return item;
    }
    return null;
  };
  for (let waited = 0; ; waited += POLL_MS) {
    const found = await search(await folder()).catch((error) => {
      log('looking for the imported file failed:', reason(error));
      return null;
    });
    if (found || waited >= waitMs) return found;
    await sleep(POLL_MS);
  }
}

/**
 * How long the clip will be, in seconds: the app's own figure for a video, else the project item's In to Out (a
 * still's is Premiere's preference, 5 s unless changed); null when neither is known.
 * @param {ProjectItem} item
 * @param {number | undefined} duration
 */
async function lengthOf(item, duration) {
  let seconds = 0;
  try {
    const clip = ppro.ClipProjectItem.cast(item);
    const inPoint = await clip.getInPoint(ppro.Constants.MediaType.VIDEO);
    const outPoint = await clip.getOutPoint(ppro.Constants.MediaType.VIDEO);
    seconds = outPoint.seconds - inPoint.seconds;
  } catch (error) {
    log("couldn't read the clip's length:", reason(error));
  }
  const known = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const longest = Math.max(seconds > 0 ? seconds : 0, known);
  return longest > 0 ? longest : null;
}

/**
 * The video track's clips as { start, end } (seconds); the track hidden (its output switched off) or not.
 * @param {VideoTrack} track
 */
async function clipsOn(track) {
  const clips = [];
  for (const item of track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)) {
    clips.push({ start: (await item.getStartTime()).seconds, end: (await item.getEndTime()).seconds });
  }
  const hidden = typeof track.isMuted === 'function' ? await track.isMuted().catch(() => false) : false;
  return { clips, hidden };
}

/** Every video track's clips (see clipsOn), for choosing a track and for seeing what an edit changed. */
async function tracksOf(sequence) {
  const count = await sequence.getVideoTrackCount();
  const tracks = [];
  for (let i = 0; i < count; i++) tracks.push(await clipsOn(await sequence.getVideoTrack(i)));
  return tracks;
}

/**
 * The video tracks a clip from `from` to `to` seconds can go on: every one above the highest with a clip at
 * `from` that is shown and empty over that time, lowest first; none when the length is unknown (null), since
 * an overwrite cuts away whatever it covers. A frame to spare at the end.
 */
function freeTracks(tracks, from, to, fps) {
  const margin = 1 / Math.max(1, fps);
  let top = -1;
  tracks.forEach(({ clips }, i) => { if (clips.some((c) => c.start <= from + 1e-6 && c.end > from + 1e-6)) top = i; });
  if (to === null) return [];
  const free = [];
  for (let i = top + 1; i < tracks.length; i++) {
    const { clips, hidden } = tracks[i];
    if (!hidden && !clips.some((c) => c.start < to + margin - 1e-6 && c.end > from + 1e-6)) free.push(i);
  }
  return free;
}

/** What differs between two tracksOf() results apart from the clip placed (at `at` s on track `on`). */
function damage(before, after, on, at) {
  const key = (c) => `${c.start.toFixed(4)}-${c.end.toFixed(4)}`;
  const changes = [];
  before.forEach((track, i) => {
    const now = after[i]?.clips.map(key) ?? [];
    const was = track.clips.map(key);
    const kept = now.filter((k) => !(i === on && k.startsWith(at.toFixed(4))));
    if (kept.length !== was.length || kept.some((k, j) => k !== was[j])) changes.push(`V${i + 1}`);
  });
  return changes;
}

/**
 * Puts the file (bytes of a PNG or an MP4, `kind`) on the timeline of `grab` (grabFrame()'s result) at the
 * time of its frame, on the first free video track above the picture there (or a new one on top), at the file's
 * own size (see nativeSize). `duration` is the video's length in seconds, as the app tells it. Resolves to
 * { path, track (1-based, as the Timeline names it: V2…), rescaled (true when Premiere Pro had scaled it on
 * import and the panel put it back to 100%) }.
 */
async function place(grab, { bytes, kind, fileName, duration }) {
  let { project, sequence } = await whereFrom(grab);
  const time = ppro.TickTime.createWithTicks(grab.ticks);
  const folder = await commentsFolder(project);
  const path = `${folder}\\${fileName}`;
  await fs.writeFile(path, new Uint8Array(bytes));
  log('wrote', path);
  const bin = await commentsBin(project);
  if (!(await project.importFiles([path], true, bin ?? undefined, false))) throw new Error(`Premiere Pro couldn't import ${fileName}.`);
  // (In its bin; without one, wherever Premiere Pro put it.)
  const where = async () => (bin ? ppro.FolderItem.cast(bin) : project.getRootItem());
  const imported = await itemFor(where, path);
  if (!imported) throw new Error(`Imported ${fileName}, but couldn't find it in the project.`);

  ({ project, sequence } = await whereFrom(grab));
  const length = await lengthOf(imported, kind === 'mp4' ? duration : undefined);
  const before = await tracksOf(sequence);
  const free = freeTracks(before, time.seconds, length === null ? null : time.seconds + length, grab.fps);
  log('length', length, 's; free tracks', free, 'of', before.length);
  // An empty track takes it as an overwrite (the file has no sound, so no audio track is touched). Otherwise an
  // overwrite on the next track index, which makes that track (as found in 26.5); failing that, an insert there,
  // which Adobe documents as making one, limited to the tracks it targets and aimed past the last audio track.
  // Whatever an attempt does besides adding the clip is looked for, and reported rather than built on.
  const attempts = [...free.map((index) => ({ index, insert: false })), { index: before.length, insert: false }, { index: before.length, insert: true }];
  let last = null;
  for (const { index, insert } of attempts) {
    try {
      ({ project, sequence } = await whereFrom(grab));
      const item = (await itemFor(where, path, 0)) ?? imported; // (a fresh one: objects can go stale)
      const was = await tracksOf(sequence);
      const editor = ppro.SequenceEditor.getEditor(sequence);
      const audioPast = await sequence.getAudioTrackCount();
      const done = edit(project, 'Add YouTube chat comment', () => [insert
        ? editor.createInsertProjectItemAction(item, time, index, audioPast, true)
        : editor.createOverwriteItemAction(item, time, index, 0)]);
      log(insert ? 'insert' : 'overwrite', 'on', index, '→', done);
      if (!done) continue;
      ({ project, sequence } = await whereFrom(grab));
      const now = await tracksOf(sequence);
      const clip = await clipAt(grab, index, time, was[index]?.clips ?? []);
      const changed = damage(was, now, clip ? index : -1, time.seconds);
      if (changed.length) {
        throw Object.assign(new Error(`Premiere Pro also changed ${changed.join(', ')} when adding the comment: press Ctrl+Z in Premiere Pro to undo that, then try again.`), { final: true });
      }
      // (A transaction can succeed and place nothing: only the clip itself says it worked.)
      if (!clip) continue;
      const rescaled = await nativeSize(grab, clip);
      return { path, track: index + 1, rescaled };
    } catch (error) {
      if (error?.final) throw error;
      last = error;
      log(insert ? 'insert' : 'overwrite', 'on', index, 'failed:', reason(error));
    }
  }
  throw new Error(`Premiere Pro wouldn't put the comment on the timeline${last ? ` (${reason(last)})` : ' (are the tracks locked?)'}.`);
}

/**
 * The clip just placed at `time` on video track `index`: one starting there that wasn't on the track before
 * the edit (`was`: its clips then). Null if there is none.
 * @param {TickTime} time
 */
async function clipAt(grab, index, time, was) {
  const existed = new Set(was.map((c) => c.start.toFixed(4)));
  for (let waited = 0; waited < 2000; waited += POLL_MS) {
    const { sequence } = await whereFrom(grab);
    if (index < (await sequence.getVideoTrackCount())) {
      for (const clip of (await sequence.getVideoTrack(index)).getTrackItems(ppro.Constants.TrackItemType.CLIP, false)) {
        const start = (await clip.getStartTime()).seconds;
        if (Math.abs(start - time.seconds) <= 0.02 && !existed.has(start.toFixed(4))) return clip;
      }
    }
    await sleep(POLL_MS);
  }
  return null;
}

/** A number parameter's value, wrapped or not ({ value: { value: 100 } } as Premiere hands it over). */
function numberOf(value) {
  let v = value;
  for (let depth = 0; v && typeof v === 'object' && 'value' in v && depth < 3; depth++) v = v.value;
  return typeof v === 'number' ? v : NaN;
}

/**
 * Keeps the clip at the size the app rendered it: Premiere Pro leaves a new clip's Motion at Scale 100% and
 * Position in the middle of the frame, unless its Default Media Scaling preference scaled the still to the frame
 * on import. Then Scale (Motion's second parameter) goes back to 100%. Resolves to true when it had to; the
 * position is left as Premiere Pro put it.
 */
async function nativeSize(grab, clip) {
  try {
    const chain = await clip.getComponentChain();
    let component = null;
    for (let i = 0; i < chain.getComponentCount() && !component; i++) {
      const candidate = chain.getComponentAtIndex(i);
      if ((await candidate.getMatchName()) === MOTION) component = candidate;
    }
    if (!component) return false;
    const scale = component.getParam(1);
    const start = numberOf(await scale.getStartValue());
    if (!Number.isFinite(start) || Math.abs(start - 100) < 1e-3) return false;
    log('Premiere Pro scaled the clip to', start, '%: back to 100%');
    const { project } = await whereFrom(grab);
    return edit(project, 'Show YouTube chat comment at its own size', () => [scale.createSetValueAction(scale.createKeyframe(100), true)]);
  } catch (error) {
    log('checking the clip\'s scale failed:', reason(error));
    return false;
  }
}

module.exports = { checkPlace, grabFrame, log, place };
