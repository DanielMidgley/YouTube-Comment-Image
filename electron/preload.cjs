// The editor's only bridge to the main process (window.ytComment). CommonJS because sandboxed preloads
// cannot be ES modules. Exposes narrow, purpose-built calls rather than ipcRenderer itself.
const { contextBridge, ipcRenderer } = require('electron');

/** Subscribes `callback` to a main→renderer channel; returns an unsubscribe function. */
function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('Expected a callback function.');
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('ytComment', {
  /** Captures the comment, asks where to save it and writes the PNG → { canceled, filePath, width, height }. */
  save: (props, opts) => ipcRenderer.invoke('comment:save', props, opts),
  /** Captures the comment onto the clipboard → { width, height }. */
  copy: (props, opts) => ipcRenderer.invoke('comment:copy', props, opts),
  /** Captures the comment and returns the PNG (a frame of a typing video) → { png, width, height }. */
  capture: (props, opts) => ipcRenderer.invoke('comment:capture', props, opts),
  /** Asks where to save the MP4 and writes it → { canceled, filePath }. */
  saveVideo: (bytes, info) => ipcRenderer.invoke('comment:save-video', bytes, info),
  /** Asks for a screenshot to read a comment from → { canceled, name, bytes }. */
  openScreenshot: () => ipcRenderer.invoke('screenshot:open'),
  /** Scale factor of the display the editor window is on. */
  getDisplayScale: () => ipcRenderer.invoke('display:get-scale'),
  onDisplayScaleChange: (callback) => subscribe('display:scale-changed', callback),
  /** 'save' | 'copy' | 'video' | 'read-screenshot', from the application menu and its shortcuts. */
  onMenuCommand: (callback) => subscribe('menu:command', callback),
  /** A frame from the Premiere Pro panel to read: { id, label, image } (the PNG of the box drawn in it). */
  onPremiereJob: (callback) => subscribe('premiere:job', callback),
  /** The panel's side of a job: { id, state: 'cancelled' } or { id, state: 'placed', message }. */
  onPremiereUpdate: (callback) => subscribe('premiere:update', callback),
  /** Tells the panel how its job is going ('review', 'rendering', 'failed', 'cancelled') → false if it moved on. */
  premiereStatus: (id, state, message) => ipcRenderer.invoke('premiere:status', id, state, message),
  /** Hands the panel the finished file: { kind: 'png' | 'mp4', bytes, width, height, duration?, name }. */
  premiereDeliver: (id, file) => ipcRenderer.invoke('premiere:deliver', id, file),
});
