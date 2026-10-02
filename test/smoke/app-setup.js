// Imported by test/smoke/app.js before electron/main.js: runs the real app in a throwaway profile with the
// editor kept hidden, and swaps the OS side effects (save dialog, clipboard) for recorders.
import { app, clipboard, dialog } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP_ROOT } from '../../electron/protocol.js';

export const OUT_DIR = path.join(APP_ROOT, 'test', 'visual', 'out', 'smoke');
fs.mkdirSync(OUT_DIR, { recursive: true });
// A fresh profile per run: the app's single-instance lock is keyed by it, so concurrent runs can't collide.
// Chromium keeps a run's own profile locked until it exits, so each run removes earlier runs' leftovers.
const PROFILE_PREFIX = 'youtube-comment-smoke-';
for (const entry of fs.readdirSync(os.tmpdir())) {
  if (!entry.startsWith(PROFILE_PREFIX)) continue;
  const dir = path.join(os.tmpdir(), entry);
  try {
    if (Date.now() - fs.statSync(dir).mtimeMs > 10 * 60 * 1000) fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Still in use or already gone.
  }
}
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), PROFILE_PREFIX)));
process.env.YT_COMMENT_HIDDEN = '1';

export const recorded = {
  saveTo: path.join(OUT_DIR, 'app-save.png'),
  cancelNextSave: false,
  dialogs: [],
  clipboard: [],
  console: [],
};

dialog.showSaveDialog = async (_window, options) => {
  recorded.dialogs.push(options);
  if (recorded.cancelNextSave) {
    recorded.cancelNextSave = false;
    return { canceled: true, filePath: '' };
  }
  return { canceled: false, filePath: recorded.saveTo };
};

clipboard.writeImage = (image) => { recorded.clipboard.push(image); };

app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (details) => {
    recorded.console.push({
      page: contents.getURL(),
      level: details.level,
      message: details.message,
      source: `${details.sourceId}:${details.lineNumber}`,
    });
  });
});
