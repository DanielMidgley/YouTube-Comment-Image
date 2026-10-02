// Builds the HTML of one <yt-live-chat-text-message-renderer> row, mirroring the DOM YouTube's live chat
// produces (same elements, ids, classes, attributes and U+200B separators), so YouTube's CSS lays it out
// identically. Pure string building, so it runs in Node tests and in the browser alike.
import { splitEmoji, emojiUrl } from './emoji.js';
import { badgeHtml } from './badges.js';
import { escapeHtml } from './html.js';

export { escapeHtml };

export const ROLES = ['viewer', 'member', 'moderator', 'owner'];

const ZWSP = '\u200b';

const scoped = (host, extra = '') => `class="${extra}style-scope ${host}"`;
const ROW = 'yt-live-chat-text-message-renderer';
const CHIP = 'yt-live-chat-author-chip';

/** Chat messages are a single paragraph: line breaks become spaces (YouTube keeps other whitespace as typed). */
export const normalizeMessage = (message) => String(message).replace(/\r\n?|\n/g, ' ');

export function messageHtml(message, { emojiOverrides } = {}) {
  let emojiCount = -1;
  return splitEmoji(normalizeMessage(message))
    .map((run) => {
      if (run.type === 'text') return escapeHtml(run.text);
      const src = emojiOverrides?.[run.emoji] ?? emojiUrl(run.emoji);
      return `<img ${scoped(ROW, 'small-emoji emoji yt-formatted-string ')} src="${escapeHtml(src)}" alt="${escapeHtml(run.emoji)}" id="emoji-${++emojiCount}">`;
    })
    .join('');
}

export function rowHtml(props) {
  const role = ROLES.includes(props.role) ? props.role : 'viewer';
  const authorType = role === 'viewer' ? '' : role;
  const { chip: chipBadges, chat: chatBadges } = badgeHtml({
    role,
    verified: Boolean(props.verified),
    memberBadgeSrc: props.memberBadgeSrc ?? null,
  });
  const chipAttrs = [
    'enable-new-moderator-text-color=""',
    'enable-improved-visibility-style=""',
    role === 'owner' ? 'is-highlighted=""' : '',
    props.verified ? 'is-verified=""' : '',
  ].filter(Boolean).join(' ');

  return (
    `<${ROW} ${scoped('yt-live-chat-item-list-renderer')} modern="" enable-improved-visibility-style="" enable-banner-update="" author-type="${authorType}"${role === 'owner' ? ' author-is-owner=""' : ''}>` +
    `<yt-img-shadow id="author-photo" ${scoped(ROW, 'no-transition ')} height="24" width="24" style="background-color: transparent;" loaded="">` +
    `<img id="img" draggable="false" ${scoped('yt-img-shadow')} alt="" height="24" width="24" src="${escapeHtml(props.avatarSrc ?? '')}">` +
    `</yt-img-shadow>` +
    `<div id="content" ${scoped(ROW)}>` +
    `<span id="timestamp" ${scoped(ROW)}>${escapeHtml(props.timestamp ?? '')}</span>` +
    `<${CHIP} ${scoped(ROW)} ${chipAttrs}>` +
    `<span id="prepend-chat-badges" ${scoped(CHIP)}></span>` +
    `<span id="author-name" dir="auto" class="${authorType ? `${authorType} ` : ' '}style-scope ${CHIP} style-scope ${CHIP}">` +
    `${escapeHtml(props.name ?? '')}<span id="chip-badges" ${scoped(CHIP)}>${chipBadges}</span></span>` +
    `<span id="chat-badges" ${scoped(CHIP)}>${chatBadges}</span>` +
    `</${CHIP}>${ZWSP}` +
    `<div id="before-content-buttons" ${scoped(ROW)}></div>${ZWSP}` +
    `<span id="message-container" ${scoped(ROW)}>` +
    `<span id="message-prefix-icon-container" ${scoped(ROW)}></span>` +
    `<span id="message" dir="auto" ${scoped(ROW)}>${messageHtml(props.message ?? '', props)}</span>` +
    `</span>` +
    `<span id="hover-message" dir="auto" ${scoped(ROW)}></span>` +
    `<span id="deleted-state" ${scoped(ROW)}></span>` +
    `<a id="show-original" ${scoped(ROW)}></a>` +
    `</div>` +
    // #menu and #inline-action-button-container are omitted: YouTube only reveals them on hover.
    `</${ROW}>`
  );
}
