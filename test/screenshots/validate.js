// Sanity checks for one corpus case: the manifest entry's shape, its boxes against each other and against the
// image, its text against its geometry and, given the decoded image, that the boxes sit on the pixels they
// claim: every text box holds ink and the chat background shows right of every line. Returns the problems.
import { splitEmoji } from '../../src/comment/emoji.js';
import { dominantColor, inkCount, pixel } from './bitmap.js';
import { contains, contentBoxes, insideImage, overlapsImage } from './geometry.js';

/** --yt-live-chat-background-color of each theme (src/styles/youtube-chat.css). */
export const BACKGROUND = { dark: [0x0f, 0x0f, 0x0f], light: [0xff, 0xff, 0xff] };

const TOLERANCE = 0.75; // device px: boxes are rounded to 0.01 px, and resampling stretches them
const isBox = (b) => Boolean(b) && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(b[k])) && b.width > 0 && b.height > 0;
const right = (b) => b.x + b.width;
const bottom = (b) => b.y + b.height;

/** Whether `lines` read as `message` when each wrap is either a space or nothing (a break inside a word). */
function linesSpell(message, lines) {
  let at = 0;
  for (const [i, text] of lines.entries()) {
    if (i > 0 && message[at] === ' ' && !message.startsWith(text, at)) at++;
    if (!text || !message.startsWith(text, at)) return false;
    at += text.length;
  }
  return at === message.length;
}

export function validateCase(entry, bitmap = null) {
  const problems = [];
  const fail = (message) => problems.push(message);
  const { width, height, pixelScale: s } = entry;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) fail(`bad image size ${width}×${height}`);
  if (!(s > 0)) fail(`bad pixelScale ${s}`);
  if (!Array.isArray(entry.comments) || !entry.comments.length) {
    fail('no comments');
    return problems;
  }
  const firstComplete = entry.comments.findIndex((c) => c.complete);
  if (firstComplete < 0 || entry.target !== firstComplete) fail(`target ${entry.target} is not the first complete comment (${firstComplete})`);

  const lossy = entry.transform.jpegQuality != null || entry.transform.resample != null;
  if (bitmap && (bitmap.width !== width || bitmap.height !== height)) fail(`file is ${bitmap.width}×${bitmap.height}, manifest says ${width}×${height}`);
  const pixels = bitmap && bitmap.width === width && bitmap.height === height ? bitmap : null;

  entry.comments.forEach((comment, i) => {
    const at = `comment ${i}`;
    const { truth, geometry: g } = comment;
    const named = [
      ['row', g.row], ['avatar', g.avatar], ['timestamp', g.timestamp], ['nameChip', g.nameChip], ['nameText', g.nameText],
      ['message', g.message], ...g.badges.map((b) => [`${b.type} badge`, b.box]), ...g.lines.map((l, n) => [`line ${n}`, l.box]),
      ...g.emoji.map((e, n) => [`emoji ${n}`, e.box]),
    ];
    const before = problems.length;
    for (const [name, box] of named) if (box !== null && !isBox(box)) fail(`${at}: ${name} is not a box: ${JSON.stringify(box)}`);
    for (const name of ['row', 'nameChip', 'nameText', 'message']) if (!g[name]) fail(`${at}: no ${name} box`);
    if (!g.lines.length) fail(`${at}: no message lines`);
    if (problems.length > before) return; // the checks below need well-formed boxes

    // Presence follows the truth.
    if ((g.avatar === null) !== (truth.avatar === 'none')) fail(`${at}: avatar box ${g.avatar ? 'present' : 'missing'} for avatar '${truth.avatar}'`);
    if ((g.timestamp === null) !== (truth.timestamp === null)) fail(`${at}: timestamp box does not match the truth`);
    const badgeTypes = g.badges.map((b) => b.type);
    if (badgeTypes.includes('verified') !== truth.verified) fail(`${at}: verified badge does not match the truth`);
    if (badgeTypes.includes('moderator') !== (truth.role === 'moderator')) fail(`${at}: moderator badge does not match the role`);
    if (badgeTypes.includes('member') && truth.role !== 'member') fail(`${at}: member badge on a ${truth.role}`);

    // Boxes nest as the row's layout does, and have the sizes YouTube's CSS gives them.
    if (!overlapsImage(g.row, width, height)) fail(`${at}: row is outside the image`);
    if (!contains(g.nameChip, g.nameText, TOLERANCE)) fail(`${at}: name text is outside the name chip`);
    for (const [name, box] of named) {
      if (box && name !== 'row' && !contains(g.row, box, TOLERANCE)) fail(`${at}: ${name} lies outside the row`);
    }
    for (const [n, item] of g.emoji.entries()) {
      if (!g.lines.some((line) => contains(line.box, item.box, TOLERANCE))) fail(`${at}: emoji ${n} is on no line`);
      if (!item.fallback && (Math.abs(item.box.width - 24 * s) > 1 || Math.abs(item.box.height - 24 * s) > 1)) fail(`${at}: emoji ${n} is not 24 CSS px`);
    }
    for (const badge of g.badges) {
      if (Math.abs(badge.box.width - 16 * s) > 1 || Math.abs(badge.box.height - 16 * s) > 1) fail(`${at}: ${badge.type} badge is not 16 CSS px`);
    }
    if (g.avatar && (Math.abs(g.avatar.width - 24 * s) > 1 || Math.abs(g.avatar.height - 24 * s) > 1)) fail(`${at}: avatar is not 24 CSS px`);
    for (let n = 1; n < g.lines.length; n++) {
      if (g.lines[n].box.y < bottom(g.lines[n - 1].box) - TOLERANCE) fail(`${at}: line ${n} overlaps the line above`);
    }
    if (i > 0) {
      const above = entry.comments[i - 1].geometry.row;
      if (Math.abs(bottom(above) - g.row.y) > 0.05) fail(`${at}: row does not abut the row above (${bottom(above)} vs ${g.row.y})`);
    }

    // The lines spell the message, and the emoji boxes are its emoji.
    if (!linesSpell(truth.message, g.lines.map((line) => line.text))) {
      fail(`${at}: lines ${JSON.stringify(g.lines.map((l) => l.text))} do not spell ${JSON.stringify(truth.message)}`);
    }
    const expectedEmoji = splitEmoji(truth.message).filter((run) => run.type === 'emoji').map((run) => run.emoji);
    if (g.emoji.map((e) => e.emoji).join('|') !== expectedEmoji.join('|')) fail(`${at}: emoji boxes do not match the message's emoji`);

    const whole = contentBoxes(g).every((box) => insideImage(box, width, height));
    if (comment.complete !== whole) fail(`${at}: complete is ${comment.complete} but its content is ${whole ? '' : 'not '}inside the image`);

    if (!pixels) return;
    const background = BACKGROUND[truth.theme];
    const threshold = lossy ? 90 : 30;
    const shown = (box) => insideImage(box, width, height);
    for (const [n, line] of g.lines.entries()) {
      if (!shown(line.box)) continue;
      if (inkCount(pixels, line.box, background, threshold) < 1) fail(`${at}: line ${n} has no ink`);
      if (lossy) continue;
      // Nothing is drawn right of a line's last glyph up to the row's right padding, except what other boxes
      // hold: an emoji makes its line reach up into the line above, where an owner's chip can be.
      const strip = { x: right(line.box) + 1 + 1.5 * s, y: line.box.y + 1, width: 0, height: line.box.height - 2 };
      strip.width = Math.min(right(g.row) - 2, width) - strip.x;
      const others = [g.nameChip, g.timestamp, ...g.badges.map((b) => b.box), ...g.lines.filter((l) => l !== line).map((l) => l.box)]
        .filter(Boolean).map((b) => ({ x: b.x - 1, y: b.y - 1, width: b.width + 2, height: b.height + 2 }));
      if (strip.width > 1 && inkCount(pixels, strip, background, threshold, { exclude: others }) > 0) {
        fail(`${at}: ink right of line ${n} (its box is too short)`);
      }
    }
    if (shown(g.nameText)) {
      const chip = dominantColor(pixels, g.nameText);
      if (inkCount(pixels, g.nameText, chip, threshold) < 2) fail(`${at}: name text has no ink`);
    }
    if (g.timestamp && shown(g.timestamp) && inkCount(pixels, g.timestamp, background, threshold) < 2) fail(`${at}: timestamp has no ink`);
    for (const [n, item] of g.emoji.entries()) {
      if (shown(item.box) && inkCount(pixels, item.box, background, threshold) < 1) fail(`${at}: emoji ${n} has no ink`);
    }
    if (i === 0) {
      // The top-right corner is chat background (a row's right padding, or added padding).
      const corner = pixel(pixels, width - 2, Math.min(1, height - 1));
      const diff = corner.reduce((sum, value, c) => sum + Math.abs(value - background[c]), 0);
      if (diff > (lossy ? 24 : 0)) fail(`top-right pixel rgb(${corner.join(',')}) is not the ${truth.theme} chat background`);
    }
  });
  return problems;
}
