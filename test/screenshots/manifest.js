// The corpus manifest (DIR/cases.json): the text a reader should get from each comment, the tags results can
// be sliced by, and a JSON layout that keeps boxes and short lists on one line so the file stays readable.
import fs from 'node:fs';
import path from 'node:path';
import { splitEmoji } from '../../src/comment/emoji.js';
import { LIMITS, capText } from '../../src/comment/limits.js';
import { normalizeMessage } from '../../src/comment/render.js';

/** Texts as the app sends them to the stage (src/editor/editor.js buildProps; electron/main.js applies the same caps). */
export const appName = (name) => capText(name, LIMITS.name);
export const appMessage = (message) => capText(normalizeMessage(message), LIMITS.message);
export const appTimestamp = (timestamp) => (timestamp ? capText(timestamp, LIMITS.timestamp) : null);

/** CSS `white-space: normal`: a run of spaces shows as one space, and none shows at the start or end. */
const collapse = (text) => text.replace(/[ \t\n\r\f]+/g, ' ').trim();

/** A name or timestamp as the image shows it. */
export const shownText = (text) => (text == null ? null : collapse(text));
/**
 * The message as the image shows it: without U+FE0F (YouTube's chat drops every one before matching emoji,
 * src/comment/emoji.js), each emoji as the characters of its image's alt text.
 */
export const shownMessage = (message) => collapse(splitEmoji(message).map((run) => run.text ?? run.emoji).join(''));

/** Where emoji sit in a message: none, only, start, middle, end, adjacent (two with nothing between). */
export function emojiPlaces(message) {
  const all = splitEmoji(message);
  const runs = all.filter((run) => run.type === 'emoji' || run.text.trim());
  if (!runs.some((run) => run.type === 'emoji')) return ['none'];
  if (runs.every((run) => run.type === 'emoji')) return ['only'];
  const places = [];
  if (runs[0].type === 'emoji') places.push('start');
  if (runs.some((run, i) => run.type === 'emoji' && i > 0 && i < runs.length - 1)) places.push('middle');
  if (runs.at(-1).type === 'emoji') places.push('end');
  if (all.some((run, i) => run.type === 'emoji' && all[i + 1]?.type === 'emoji')) places.push('adjacent');
  return places;
}

/** 'key:value' tags of a finished case, from its target comment (planned as `row`) and its transforms. */
export function caseTags(plan, entry, row) {
  const comment = entry.comments[entry.target];
  const { truth } = comment;
  const variant = truth.role === 'member' ? (comment.props.memberBadgeSrc ? 'member-badge' : 'member')
    : truth.role === 'moderator' ? `moderator-${truth.moderatorBadge}` : truth.role;
  const lines = comment.geometry.lines.length;
  const transforms = Object.entries(entry.transform).filter(([, value]) => value != null).map(([key]) => ({
    jpegQuality: 'jpeg', pad: 'pad', resample: 'resample', stack: 'stack', avatarCut: 'avatar-cut',
  })[key]);
  if (entry.transform.stack && (entry.transform.stack.cutTop || entry.transform.stack.cutBottom)) transforms.push('stack-cut');
  const tags = [
    `theme:${truth.theme}`,
    `role:${variant}`,
    `scale:${entry.scale}`,
    `verified:${truth.verified ? 'yes' : 'no'}`,
    `timestamp:${plan.timestampStyle ?? 'none'}`,
    `avatar:${truth.avatar}`,
    `width:${comment.props.rowWidth}`,
    `margin:${comment.props.margin}`,
    ...(transforms.length ? transforms : ['none']).map((t) => `transform:${t}`),
    ...emojiPlaces(truth.message).map((place) => `emoji:${place}`),
    `lines:${lines >= 4 ? '4+' : lines}`,
    `name:${truth.name.startsWith('@') ? 'handle' : 'display'}`,
  ];
  if (/[^\x20-\x7e]/.test(truth.name)) tags.push('name:accented');
  if (row?.meta?.confusable) tags.push('name:confusable');
  if ([...truth.name].length > 20) tags.push('name:long');
  // What a long name does in a narrow chat: the chip drops below the timestamp, the name wraps, the message
  // starts on a line of its own. Compared by middles: a line's emoji reach up into the line above.
  const g = comment.geometry;
  const middle = (box) => box.y + box.height / 2;
  if (g.timestamp && middle(g.nameChip) > g.timestamp.y + g.timestamp.height) tags.push('layout:name-below-timestamp');
  if (g.nameText.height > 24 * entry.pixelScale) tags.push('layout:name-wraps');
  if (middle(g.lines[0].box) > g.nameChip.y + g.nameChip.height) tags.push('layout:message-below-name');
  if (row?.meta?.messageKind) tags.push(`message:${row.meta.messageKind}`);
  if (entry.comments.length > 1) tags.push(`rows:${entry.comments.length}`);
  return tags;
}

// ---- JSON layout ---------------------------------------------------------------------------------------------

const INVISIBLE = /[\u{a0}\u{2000}-\u{200f}\u{2028}-\u{202f}\u{205f}-\u{206f}\u{fe00}-\u{fe0f}\u{feff}]/gu;
/** JSON string with invisible characters (U+202F in clock times, U+FE0F, …) written as \u escapes. */
const quote = (text) => JSON.stringify(text).replace(INVISIBLE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

function oneLine(value) {
  if (Array.isArray(value)) return `[${value.map(oneLine).join(', ')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    return entries.length ? `{ ${entries.map(([k, v]) => `${quote(k)}: ${oneLine(v)}`).join(', ')} }` : '{}';
  }
  return typeof value === 'string' ? quote(value) : JSON.stringify(value);
}

/** Pretty JSON that puts any object or array fitting in `width` characters on one line. */
export function formatJson(value, indent = '', width = 110) {
  const flat = oneLine(value);
  if (flat.length + indent.length <= width || value === null || typeof value !== 'object') return flat;
  const inner = `${indent}  `;
  if (Array.isArray(value)) return `[\n${value.map((v) => inner + formatJson(v, inner, width)).join(',\n')}\n${indent}]`;
  return `{\n${Object.entries(value).map(([k, v]) => `${inner}${quote(k)}: ${formatJson(v, inner, width)}`).join(',\n')}\n${indent}}`;
}

export function writeManifest(dir, entries) {
  fs.writeFileSync(path.join(dir, 'cases.json'), `${formatJson(entries)}\n`);
}

/** Removes what an earlier run wrote to `dir`: cases.json and the images it lists. Nothing else is touched. */
export function removePreviousOutput(dir) {
  const manifest = path.join(dir, 'cases.json');
  if (!fs.existsSync(manifest)) return;
  let entries = [];
  try {
    entries = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  } catch {
    entries = [];
  }
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (typeof entry?.file === 'string' && /^[\w.-]+\.(png|jpg)$/.test(entry.file)) fs.rmSync(path.join(dir, entry.file), { force: true });
  }
  fs.rmSync(manifest, { force: true });
}

/** Removes the PNG overlays an earlier run drew into `dir`. */
export function removeOverlays(dir) {
  if (!fs.existsSync(dir)) return;
  for (const file of fs.readdirSync(dir)) if (/^[\w.-]+\.png$/.test(file)) fs.rmSync(path.join(dir, file), { force: true });
}
