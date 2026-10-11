// Rows of a real YouTube live chat, read from a page saved by a browser into yt_example_page/ (git-ignored;
// see README: Tests): each chat row's author name, message (emoji as their alt text), timestamp text, author
// type and badges. Only `make-corpus.js --real` uses them, and only to write into the git-ignored
// test/screenshots/corpus-real/: real people's comments must never reach a committed file.
import { BrowserWindow, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/** The saved chat document, found as test/visual/golden.js finds it: a saved_resource*.html with chat rows. */
export function findSavedChat(root) {
  if (!fs.existsSync(root)) return null;
  for (const folder of fs.readdirSync(root).filter((name) => name.endsWith('_files'))) {
    const dir = path.join(root, folder);
    for (const file of fs.readdirSync(dir).filter((name) => /^saved_resource.*\.html$/.test(name))) {
      const html = fs.readFileSync(path.join(dir, file), 'utf8');
      if (html.includes('<yt-live-chat-text-message-renderer')) return { file: path.join(dir, file), html };
    }
  }
  return null;
}

/** Page side: parses the saved HTML with DOMParser (which runs no script and loads nothing) and reads its rows. */
function readRows(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const textOf = (node) => [...node.childNodes].map((child) => {
    if (child.nodeType === Node.TEXT_NODE) return child.data;
    if (child.nodeType !== Node.ELEMENT_NODE) return '';
    return child.tagName === 'IMG' ? child.alt : textOf(child);
  }).join('');
  return [...doc.querySelectorAll('#items > yt-live-chat-text-message-renderer')].map((row) => {
    const name = row.querySelector('#author-name');
    const moderator = row.querySelector('#chat-badges yt-live-chat-author-badge-renderer[type=moderator]');
    const message = row.querySelector('#message');
    return {
      name: name?.firstChild?.nodeType === Node.TEXT_NODE ? name.firstChild.data : '',
      message: message ? textOf(message) : '',
      timestamp: row.querySelector('#timestamp')?.textContent ?? '',
      authorType: row.getAttribute('author-type') ?? '',
      verified: Boolean(row.querySelector('yt-live-chat-author-chip')?.hasAttribute('is-verified') || row.querySelector('#chip-badges [type=verified]')),
      newModeratorBadge: moderator ? moderator.hasAttribute('enable-new-moderator-badge') : null,
      memberBadge: Boolean(row.querySelector('#chat-badges [type=member]')),
      customEmoji: [...(message?.querySelectorAll('img') ?? [])].filter((img) => !/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(img.alt)).length,
    };
  });
}

/**
 * The saved chat's text rows as { name, message, timestamp, role, verified, moderatorBadge, memberBadge,
 * customEmoji }, in chat order; null when no saved chat is present. Member badges are replaced by the
 * corpus's own badge image when rendered, and avatars by invented ones.
 */
export async function loadRealRows(root) {
  const saved = findSavedChat(root);
  if (!saved) return null;
  const ses = session.fromPartition('screenshot-corpus-saved-chat');
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
  const win = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true, javascript: true } });
  try {
    await win.loadURL('about:blank');
    const rows = await win.webContents.executeJavaScript(`(${readRows})(${JSON.stringify(saved.html)})`);
    return {
      file: saved.file,
      rows: rows.filter((row) => row.name && row.message).map((row) => ({
        name: row.name.trim(),
        message: row.message,
        timestamp: row.timestamp.trim() || null,
        role: ['member', 'moderator', 'owner'].includes(row.authorType) ? row.authorType : 'viewer',
        verified: row.verified,
        moderatorBadge: row.newModeratorBadge === false ? 'wrench' : 'shield',
        memberBadge: row.memberBadge,
        customEmoji: row.customEmoji,
      })),
    };
  } finally {
    win.destroy();
  }
}
