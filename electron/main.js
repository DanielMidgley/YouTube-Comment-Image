// Main process: app lifecycle, the editor window, the menu, the security policy for every web contents, and
// the IPC that turns the editor's RenderProps into a saved or copied PNG (via capture.js).
import { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, nativeImage, screen, session } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { appUrl, handleAppScheme, registerAppScheme } from './protocol.js';
import { MAX_SCALE, MIN_SCALE, captureComment, disposeCapture } from './capture.js';
import { LIMITS as TEXT_LIMITS, capText } from '../src/comment/limits.js';

registerAppScheme();

const EDITOR_URL = appUrl('src/editor/index.html');
const EDITOR_PREFIX = appUrl('src/editor/');
const APP_PREFIX = appUrl('');
const BACKGROUND = '#15171b'; // --app-bg in src/editor/editor.css, so there is no flash before the page paints
// Set by test/smoke/app.js: run the real app with the editor window kept hidden.
const HIDDEN = process.env.YT_COMMENT_HIDDEN === '1';

// Text limits are shared with the editor, so its preview always shows exactly what gets exported.
const LIMITS = { ...TEXT_LIMITS, url: 2048, dataUrl: 5 * 1024 * 1024 };
const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;
const THEMES = ['dark', 'light'];
const ROLES = ['viewer', 'member', 'moderator', 'owner'];
const MODERATOR_BADGES = ['shield', 'wrench'];

let editorWindow = null;
let lastSaveDir = null;
let lastScale = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!editorWindow) return;
    if (editorWindow.isMinimized()) editorWindow.restore();
    editorWindow.show();
    editorWindow.focus();
  });
  app.on('web-contents-created', (_event, contents) => secureContents(contents));
  // The hidden capture window is disposed of when the editor closes, so this follows the editor.
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => disposeCapture());
  app.whenReady().then(start);
}

function start() {
  handleAppScheme(session.defaultSession);
  // Nothing in the app needs a permission (camera, notifications, …); refuse them all.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  registerIpc();
  Menu.setApplicationMenu(buildMenu());
  createEditorWindow();
  for (const event of ['display-metrics-changed', 'display-added', 'display-removed']) screen.on(event, emitScaleIfChanged);
}

function createEditorWindow() {
  // Never larger than the work area: on small high-DPI screens the export bar must stay above the taskbar.
  const { workAreaSize: area } = screen.getPrimaryDisplay();
  editorWindow = new BrowserWindow({
    width: Math.min(1280, area.width),
    height: Math.min(860, area.height),
    minWidth: Math.min(960, area.width),
    minHeight: Math.min(520, area.height),
    title: 'YouTube Chat Comment',
    show: false,
    backgroundColor: BACKGROUND,
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  const win = editorWindow;
  win.once('ready-to-show', () => { if (!HIDDEN) win.show(); });
  // 'moved'/'resized' only fire at the end of a mouse drag; keyboard snaps and programmatic moves only
  // send 'move'/'resize', so follow those too (debounced).
  let scaleTimer = null;
  const scaleSoon = () => {
    clearTimeout(scaleTimer);
    scaleTimer = setTimeout(emitScaleIfChanged, 150);
  };
  for (const event of ['moved', 'resized', 'move', 'resize']) win.on(event, scaleSoon);
  win.on('closed', () => {
    editorWindow = null;
    disposeCapture();
  });
  // The preview shows the comment at 1 CSS px : 1 CSS px. Page zoom is remembered per host, so undo any
  // zoom left over from earlier sessions (the app itself offers no zoom).
  win.webContents.on('dom-ready', () => win.webContents.setZoomFactor(1));
  win.webContents.on('context-menu', (_event, params) => showContextMenu(win, params));

  lastScale = currentDisplayScale();
  win.loadURL(EDITOR_URL);
}

/** Spelling suggestions and clipboard actions for the editor's text fields. */
function showContextMenu(win, params) {
  const template = [];
  if (params.misspelledWord) {
    for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
      template.push({ label: suggestion, click: () => win.webContents.replaceMisspelling(suggestion) });
    }
    if (!params.dictionarySuggestions.length) template.push({ label: 'No suggestions', enabled: false });
    template.push(
      { label: 'Add to dictionary', click: () => win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord) },
      { type: 'separator' },
    );
  }
  if (params.isEditable) {
    template.push(
      { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll' },
    );
  } else if (params.selectionText) {
    template.push({ role: 'copy' });
  }
  if (template.length) Menu.buildFromTemplate(template).popup({ window: win });
}

function buildMenu() {
  // Save and Copy run in the editor (it knows the current props), so the menu just asks it to.
  const command = (name) => () => {
    if (editorWindow && !editorWindow.isDestroyed()) editorWindow.webContents.send('menu:command', name);
  };
  return Menu.buildFromTemplate([
    {
      label: '&File',
      submenu: [
        { id: 'save', label: 'Save PNG…', accelerator: 'CmdOrCtrl+S', click: command('save') },
        { id: 'copy', label: 'Copy Image', accelerator: 'CmdOrCtrl+Shift+C', click: command('copy') },
        { id: 'video', label: 'Save Typing Video…', accelerator: 'CmdOrCtrl+Shift+S', click: command('video') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: '&Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'delete' }, { type: 'separator' },
        { role: 'selectAll' },
      ],
    },
    {
      // No zoom items: zoom would break the preview's 1:1 scale (and is remembered per host).
      label: '&View',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }],
    },
  ]);
}

// ---- Security ---------------------------------------------------------------------------------------------

function secureContents(contents) {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Pages never navigate away (e.g. a dropped file or link); loadURL() from here is not affected.
  contents.on('will-navigate', (event) => {
    if (event.url !== contents.getURL()) event.preventDefault();
  });
  // Frames (the editor's preview) may only show the app's own pages.
  contents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame && !event.url.startsWith(APP_PREFIX)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

/** Only the editor's own top-level page may use the IPC API. */
function assertFromEditor(event) {
  const frame = event.senderFrame;
  if (!frame || frame.parent || !frame.url.startsWith(EDITOR_PREFIX)) {
    throw new Error('Request refused: it did not come from the editor.');
  }
}

// ---- IPC --------------------------------------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('comment:save', async (event, rawProps, rawOptions) => {
    assertFromEditor(event);
    const props = sanitizeProps(rawProps);
    const { scale } = sanitizeOptions(rawOptions);
    // Capture first: errors show up before a dialog is opened, and the image is what was asked for.
    const { png, width, height, warnings } = await captureComment(props, { scale });

    const owner = BrowserWindow.fromWebContents(event.sender) ?? editorWindow;
    const { canceled, filePath } = await dialog.showSaveDialog(owner, {
      title: 'Save comment image',
      defaultPath: path.join(lastSaveDir ?? defaultSaveDir(), `youtube-comment-${slug(props.name)}.png`),
      filters: [{ name: 'PNG image', extensions: ['png'] }],
      properties: ['showOverwriteConfirmation', 'createDirectory'],
    });
    if (canceled || !filePath) return { canceled: true, filePath: null, width, height, warnings };

    const target = await withExtension(owner, filePath, 'png');
    if (!target) return { canceled: true, filePath: null, width, height, warnings };
    await fs.writeFile(target, png);
    lastSaveDir = path.dirname(target);
    return { canceled: false, filePath: target, width, height, warnings };
  });

  // One frame of a typing video: the same capture as Save/Copy, handed back to the editor to encode.
  ipcMain.handle('comment:capture', async (event, rawProps, rawOptions) => {
    assertFromEditor(event);
    const props = sanitizeProps(rawProps);
    const { scale } = sanitizeOptions(rawOptions);
    const { png, width, height, warnings } = await captureComment(props, { scale });
    return { png, width, height, warnings };
  });

  ipcMain.handle('comment:save-video', async (event, bytes, info) => {
    assertFromEditor(event);
    if (!(bytes instanceof Uint8Array) || bytes.length < 16 || bytes.length > MAX_VIDEO_BYTES
      || Buffer.from(bytes.buffer, bytes.byteOffset + 4, 4).toString('latin1') !== 'ftyp') {
      throw new Error('Invalid video: expected an MP4 file of at most 1 GB.');
    }
    const name = isPlainObject(info) && typeof info.name === 'string' ? text(info.name, 'name', LIMITS.name) : '';
    const owner = BrowserWindow.fromWebContents(event.sender) ?? editorWindow;
    const { canceled, filePath } = await dialog.showSaveDialog(owner, {
      title: 'Save typing video',
      defaultPath: path.join(lastSaveDir ?? defaultSaveDir(), `youtube-comment-${slug(name)}.mp4`),
      filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
      properties: ['showOverwriteConfirmation', 'createDirectory'],
    });
    if (canceled || !filePath) return { canceled: true, filePath: null };
    const target = await withExtension(owner, filePath, 'mp4');
    if (!target) return { canceled: true, filePath: null };
    await fs.writeFile(target, bytes);
    lastSaveDir = path.dirname(target);
    return { canceled: false, filePath: target };
  });

  ipcMain.handle('comment:copy', async (event, rawProps, rawOptions) => {
    assertFromEditor(event);
    const props = sanitizeProps(rawProps);
    const { scale } = sanitizeOptions(rawOptions);
    const { png, width, height, warnings } = await captureComment(props, { scale });
    clipboard.writeImage(nativeImage.createFromBuffer(png));
    return { width, height, warnings };
  });

  ipcMain.handle('display:get-scale', (event) => {
    assertFromEditor(event);
    return currentDisplayScale();
  });
}

function currentDisplayScale() {
  const bounds = editorWindow && !editorWindow.isDestroyed() ? editorWindow.getBounds() : null;
  return (bounds ? screen.getDisplayMatching(bounds) : screen.getPrimaryDisplay()).scaleFactor;
}

function emitScaleIfChanged() {
  if (!editorWindow || editorWindow.isDestroyed()) return;
  const scale = currentDisplayScale();
  if (scale === lastScale) return;
  lastScale = scale;
  editorWindow.webContents.send('display:scale-changed', scale);
}

/**
 * `filePath` with `.ext` added when the name has no extension, or null when that file exists and the user
 * chooses not to replace it (the save dialog only confirmed overwriting the name as typed).
 */
async function withExtension(owner, filePath, ext) {
  if (path.extname(filePath)) return filePath;
  const target = `${filePath}.${ext}`;
  try {
    await fs.access(target);
  } catch {
    return target; // nothing there yet
  }
  const { response } = await dialog.showMessageBox(owner, {
    type: 'warning',
    buttons: ['Replace', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Replace file?',
    message: `${path.basename(target)} already exists.`,
    detail: 'Do you want to replace it?',
  });
  return response === 0 ? target : null;
}

function defaultSaveDir() {
  for (const name of ['pictures', 'documents', 'home']) {
    try {
      return app.getPath(name);
    } catch {
      // Not every folder exists on every system; try the next one.
    }
  }
  return process.cwd();
}

/** File-name-safe version of the author's name ('@Some Name!' → 'some-name'). */
function slug(name) {
  const text = String(name).normalize('NFKC').replace(/^\s*@+/u, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  return text.slice(0, 40).replace(/-+$/, '') || 'comment';
}

// ---- Validation of what the renderer sends -----------------------------------------------------------------

/** Rebuilds RenderProps from untrusted input: known keys only, strings capped, numbers clamped. */
function sanitizeProps(raw) {
  if (!isPlainObject(raw)) throw new Error('Invalid comment: expected an object.');
  // A cropped-out avatar (hideAvatar) needs no image.
  const hideAvatar = raw.hideAvatar === undefined ? false : boolean(raw.hideAvatar, 'hideAvatar');
  const props = {
    name: text(raw.name, 'name', LIMITS.name),
    message: text(raw.message, 'message', LIMITS.message),
    theme: oneOf(raw.theme, THEMES, 'theme'),
    role: oneOf(raw.role, ROLES, 'role'),
    verified: boolean(raw.verified, 'verified'),
    moderatorBadge: raw.moderatorBadge === undefined ? 'shield' : oneOf(raw.moderatorBadge, MODERATOR_BADGES, 'moderatorBadge'),
    hideAvatar,
    avatarSrc: hideAvatar && raw.avatarSrc == null ? null : imageUrl(raw.avatarSrc, 'avatarSrc'),
    memberBadgeSrc: raw.memberBadgeSrc == null ? null : imageUrl(raw.memberBadgeSrc, 'memberBadgeSrc'),
    timestamp: raw.timestamp == null ? null : text(raw.timestamp, 'timestamp', LIMITS.timestamp),
    rowWidth: clamp(raw.rowWidth, 200, 1200, 'rowWidth'),
    margin: clamp(raw.margin, 0, 200, 'margin'),
  };
  if (raw.emojiOverrides != null) props.emojiOverrides = emojiOverrides(raw.emojiOverrides);
  return props;
}

function sanitizeOptions(raw) {
  const scale = isPlainObject(raw) ? raw.scale : undefined;
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale < MIN_SCALE || scale > MAX_SCALE) {
    throw new Error(`Invalid export scale: expected a number from ${MIN_SCALE} to ${MAX_SCALE}.`);
  }
  return { scale };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function text(value, field, max) {
  if (typeof value !== 'string') throw new Error(`Invalid comment: ${field} must be text.`);
  return capText(value, max); // bounded work on any input; never splits an emoji
}

function oneOf(value, allowed, field) {
  if (!allowed.includes(value)) throw new Error(`Invalid comment: ${field} must be one of ${allowed.join(', ')}.`);
  return value;
}

function boolean(value, field) {
  if (typeof value !== 'boolean') throw new Error(`Invalid comment: ${field} must be true or false.`);
  return value;
}

function clamp(value, min, max, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid comment: ${field} must be a number.`);
  return Math.min(max, Math.max(min, value));
}

/** Images may come from the app itself (app:), the web (https:) or the editor's own canvas (data:image/…). */
function imageUrl(value, field) {
  if (typeof value !== 'string' || !value) throw new Error(`Invalid comment: ${field} must be an image URL.`);
  if (value.startsWith('data:')) {
    if (!/^data:image\/[\w.+-]+(;[\w=.+-]+)*(;base64)?,/i.test(value)) throw new Error(`Invalid comment: ${field} is not an image data URL.`);
    if (value.length > LIMITS.dataUrl) throw new Error(`Invalid comment: ${field} is larger than 5 MB.`);
    return value;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid comment: ${field} is not a valid URL.`);
  }
  if (value.length > LIMITS.url || !(url.protocol === 'https:' || url.href.startsWith(APP_PREFIX))) {
    throw new Error(`Invalid comment: ${field} must be a data:, app: or https: URL.`);
  }
  return url.href;
}

/** Test hook of RenderProps: { emoji: imageUrl }. */
function emojiOverrides(raw) {
  if (!isPlainObject(raw)) throw new Error('Invalid comment: emojiOverrides must be an object.');
  const entries = Object.entries(raw);
  if (entries.length > 64) throw new Error('Invalid comment: too many emojiOverrides.');
  return Object.fromEntries(entries.map(([emoji, src]) => {
    if (emoji.length > 32) throw new Error('Invalid comment: emojiOverrides key is too long.');
    return [emoji, imageUrl(src, 'emojiOverrides')];
  }));
}
