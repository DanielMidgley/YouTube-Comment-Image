// Functions that run inside the stage page (src/stage/stage.html), sent through executeJavaScript as source
// text: each must be self-contained (no imports, no outer variables). They reach the app's own modules by
// dynamic import, so every corpus image is drawn by exactly the code the app exports with.

/** YouTube's default letter avatar as the app draws it (src/comment/avatar.js), as a PNG data URL. */
export async function letterAvatar(name, color, size) {
  const { makeDefaultAvatar } = await import('/src/comment/avatar.js');
  return makeDefaultAvatar({ name, color, size });
}

/**
 * Renders the rows of one case. The first goes through window.stage.render, which also sets the theme, row
 * width, margin, timestamp visibility and avatar crop of the whole chat; the others are appended to the same
 * list, as YouTube's chat appends rows, so they abut exactly as they do on YouTube. Resolves to
 * { box, warnings }: the capture box of all rows (CSS px) and the stage's warnings.
 */
export async function renderRows(propsList) {
  const first = await window.stage.render(propsList[0]);
  const warnings = new Set(first.warnings ?? []);
  if (propsList.length > 1) {
    const { rowHtml } = await import('/src/comment/render.js');
    const items = document.getElementById('items');
    const rows = propsList.slice(1).map((props) => {
      items.insertAdjacentHTML('beforeend', rowHtml(props));
      return items.lastElementChild;
    });
    const text = rows.map((row) => row.textContent).join(' ');
    await Promise.all(['400 14px Roboto', '500 14px Roboto', '400 11px Roboto'].map((font) => document.fonts.load(font, text)));
    await document.fonts.ready;
    // As the stage does for its own row: an emoji that cannot be downloaded is drawn as text instead.
    const hideAvatar = propsList[0].hideAvatar === true;
    const missing = new Set();
    await Promise.all(rows.flatMap((row) => [...row.querySelectorAll('img')]).map(async (img) => {
      if (hideAvatar && img.id === 'img') return;
      try {
        await Promise.race([img.decode(), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000))]);
      } catch {
        if (img.classList.contains('emoji')) {
          const fallback = document.createElement('span');
          fallback.className = 'emoji-fallback';
          fallback.textContent = img.alt;
          img.replaceWith(fallback);
          missing.add(img.alt);
        } else {
          warnings.add(img.id === 'img' ? 'An avatar image could not be loaded.' : 'A badge image could not be loaded.');
        }
      }
    }));
    if (missing.size) warnings.add(`Emoji ${[...missing].join(' ')} could not be downloaded, so they are drawn as text.`);
    for (let i = 0; i < 2; i++) await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }
  const box = window.stage.measure();
  return { box: { x: box.x, y: box.y, width: box.width, height: box.height }, warnings: [...warnings] };
}

/** The stage's capture box as laid out now (CSS px), without rendering again. */
export function measureBox() {
  const box = window.stage.measure();
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}

/**
 * The geometry of every row on the stage, in CSS px from the document's top-left: the boxes of the row,
 * avatar, timestamp, name chip, name text, badges and message, each rendered line of the message with the
 * text shown on it, and each emoji. Text boxes come from DOM Ranges, i.e. advance width × the font's
 * ascent + descent, the boxes Chromium lays the glyphs out in.
 */
export function collectGeometry() {
  const plain = (r) => ({ x: r.left, y: r.top, width: r.width, height: r.height });
  const rectOf = (element) => plain(element.getBoundingClientRect());
  const union = (boxes) => {
    const left = Math.min(...boxes.map((b) => b.x));
    const top = Math.min(...boxes.map((b) => b.y));
    const right = Math.max(...boxes.map((b) => b.x + b.width));
    const bottom = Math.max(...boxes.map((b) => b.y + b.height));
    return { x: left, y: top, width: right - left, height: bottom - top };
  };
  const textBoxes = (node, start, end) => {
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    return [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0).map(plain);
  };
  const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const avatarHidden = document.documentElement.hasAttribute('data-hide-avatar');

  return [...document.querySelectorAll('#items > yt-live-chat-text-message-renderer')].map((row) => {
    const timestamp = row.querySelector('#timestamp');
    const name = row.querySelector('#author-name');
    const nameNode = name.firstChild?.nodeType === Node.TEXT_NODE && name.firstChild.data ? name.firstChild : null;
    const nameBoxes = nameNode ? textBoxes(nameNode, 0, nameNode.data.length) : [];

    // The message's characters and emoji in reading order, each with the box it is drawn in. Spaces get no
    // box: the one at a line wrap hangs past the line's end and must not stretch the line's box.
    const items = [];
    for (const node of row.querySelector('#message').childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        for (const { segment, index } of graphemes.segment(node.data)) {
          const boxes = /^\s+$/.test(segment) ? [] : textBoxes(node, index, index + segment.length);
          items.push({ text: segment, box: boxes.length ? union(boxes) : null });
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const emoji = node.matches('img.emoji, .emoji-fallback');
        items.push({
          text: node.tagName === 'IMG' ? node.alt : node.textContent,
          box: rectOf(node),
          emoji,
          fallback: node.classList.contains('emoji-fallback'),
        });
      }
    }
    // Reading order goes line by line: an item starts a new line when it sits lower than the current line's
    // first item. Lines are at least 20px apart; the items of one line are centred within a pixel of each
    // other (text and middle-aligned emoji alike).
    const lines = [];
    items.forEach((item, index) => {
      if (!item.box) return;
      const middle = item.box.y + item.box.height / 2;
      const line = lines.at(-1);
      if (!line || middle > line.middle + 8) {
        lines.push({ middle, first: index, last: index, boxes: [item.box] });
      } else {
        line.last = index;
        line.boxes.push(item.box);
      }
    });

    return {
      row: rectOf(row),
      avatar: avatarHidden ? null : rectOf(row.querySelector('#author-photo')),
      timestamp: getComputedStyle(timestamp).display === 'none' ? null : rectOf(timestamp),
      nameChip: rectOf(name),
      nameText: nameBoxes.length ? union(nameBoxes) : null,
      nameLines: new Set(nameBoxes.map((b) => Math.round(b.y))).size,
      badges: [...row.querySelectorAll('yt-live-chat-author-badge-renderer')].map((badge) => ({
        type: badge.getAttribute('type'),
        box: rectOf(badge.querySelector('yt-icon, img') ?? badge),
      })),
      message: rectOf(row.querySelector('#message')),
      lines: lines.map((line) => ({
        box: union(line.boxes),
        // CSS collapses runs of spaces; the space a line wraps at belongs to neither line.
        text: items.slice(line.first, line.last + 1).map((item) => item.text).join('').replace(/[ \t\n\r\f]+/g, ' ').trim(),
      })),
      emoji: items.filter((item) => item.emoji).map((item) => ({ box: item.box, emoji: item.text, fallback: item.fallback })),
    };
  });
}
