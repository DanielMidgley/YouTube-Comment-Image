// Author badges as YouTube's live chat renders them. Icon badges are <yt-icon> SVGs from YouTube's 24px
// system icon set (yt-sys-icons): the moderator shield ('shield_empty') and the verified check
// ('check_circle_thick-filled'). Member badges are the channel's own image; YouTube has no stock one.
// Verified badges sit inside the name chip (#chip-badges); the others follow it (#chat-badges). Owners
// get no badge, only the highlighted name chip.
import { escapeHtml } from './html.js';

const SHIELD = 'M3 4.998v9.857a6 6 0 003.365 5.39L12 23l5.635-2.755A6 6 0 0021 14.855V4.998a1 1 0 00-.656-.938L12 1 3.656 4.06A1 1 0 003 4.998Z';
const CHECK_CIRCLE = 'M12,2C6.5,2,2,6.5,2,12c0,5.5,4.5,10,10,10s10-4.5,10-10C22,6.5,17.5,2,12,2z M9.8,17.3l-4.2-4.1L7,11.8l2.8,2.7L17,7.4 l1.4,1.4L9.8,17.3z';

const BADGE = 'yt-live-chat-author-badge-renderer';

const iconHtml = (path) =>
  `<yt-icon class="style-scope ${BADGE}"><span class="yt-icon-shape style-scope yt-icon ytSpecIconShapeHost">` +
  `<div style="width: 100%; height: 100%; display: block; fill: currentcolor;">` +
  `<svg xmlns="http://www.w3.org/2000/svg" height="24" viewBox="0 0 24 24" width="24" focusable="false" aria-hidden="true" style="pointer-events: none; display: inherit; width: 100%; height: 100%;">` +
  `<path d="${path}"></path></svg></div></span></yt-icon>`;

const badgeHtml_ = (type, label, inner) =>
  `<${BADGE} class="style-scope yt-live-chat-author-chip" enable-new-moderator-badge="" aria-label="${label}" type="${type}" shared-tooltip-text="${label}">` +
  `<div id="image" class="style-scope ${BADGE}">${inner}</div></${BADGE}>`;

/** Returns the markup for #chip-badges (`chip`) and #chat-badges (`chat`). */
export function badgeHtml({ role, verified, memberBadgeSrc }) {
  const chip = verified ? badgeHtml_('verified', 'Verified', iconHtml(CHECK_CIRCLE)) : '';
  let chat = '';
  if (role === 'moderator') {
    chat = badgeHtml_('moderator', 'Moderator', iconHtml(SHIELD));
  } else if (role === 'member' && memberBadgeSrc) {
    chat = badgeHtml_('member', 'Member', `<img src="${escapeHtml(memberBadgeSrc)}" class="style-scope ${BADGE}" alt="Member">`);
  }
  return { chip, chat };
}
