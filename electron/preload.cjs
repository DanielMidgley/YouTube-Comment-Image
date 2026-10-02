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
  /** Scale factor of the display the editor window is on. */
  getDisplayScale: () => ipcRenderer.invoke('display:get-scale'),
  onDisplayScaleChange: (callback) => subscribe('display:scale-changed', callback),
  /** 'save' | 'copy', from the application menu and its shortcuts. */
  onMenuCommand: (callback) => subscribe('menu:command', callback),
});
