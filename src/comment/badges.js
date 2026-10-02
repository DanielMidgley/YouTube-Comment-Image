// Author badges as YouTube's live chat renders them. Icon badges are <yt-icon> SVGs from YouTube's 24px
// system icon set (yt-sys-icons): the moderator shield ('shield_empty') and the verified check
// ('check_circle_thick-filled'). Member badges are the channel's own image; YouTube has no stock one.
// Verified badges sit inside the name chip (#chip-badges); the others follow it (#chat-badges). Owners
// get no badge, only the highlighted name chip.
//
// The moderator badge can also be YouTube's classic wrench ('live-chat-badges:moderator', a 16-unit icon
// drawn through iron-iconset-svg), which YouTube shows when its new-shield flag is off. That one flag also
// drops the enable-new-moderator-badge attribute from badges (and render.js drops the chip's
// enable-new-moderator-text-color), so the name and badge take the classic moderator blue.
import { escapeHtml } from './html.js';

export const MODERATOR_BADGES = ['shield', 'wrench'];

const SHIELD = 'M3 4.998v9.857a6 6 0 003.365 5.39L12 23l5.635-2.755A6 6 0 0021 14.855V4.998a1 1 0 00-.656-.938L12 1 3.656 4.06A1 1 0 003 4.998Z';
const CHECK_CIRCLE = 'M12,2C6.5,2,2,6.5,2,12c0,5.5,4.5,10,10,10s10-4.5,10-10C22,6.5,17.5,2,12,2z M9.8,17.3l-4.2-4.1L7,11.8l2.8,2.7L17,7.4 l1.4,1.4L9.8,17.3z';

const WRENCH = 'M9.64589146,7.05569719 C9.83346524,6.562372 9.93617022,6.02722257 9.93617022,5.46808511 C9.93617022,3.00042984 7.93574038,1 5.46808511,1 C4.90894765,1 4.37379823,1.10270499 3.88047304,1.29027875 L6.95744681,4.36725249 L4.36725255,6.95744681 L1.29027875,3.88047305 C1.10270498,4.37379824 1,4.90894766 1,5.46808511 C1,7.93574038 3.00042984,9.93617022 5.46808511,9.93617022 C6.02722256,9.93617022 6.56237198,9.83346524 7.05569716,9.64589147 L12.4098057,15 L15,12.4098057 L9.64589146,7.05569719 Z';

const BADGE = 'yt-live-chat-author-badge-renderer';

const iconHtml = (path) =>
  `<yt-icon class="style-scope ${BADGE}"><span class="yt-icon-shape style-scope yt-icon ytSpecIconShapeHost">` +
  `<div style="width: 100%; height: 100%; display: block; fill: currentcolor;">` +
  `<svg xmlns="http://www.w3.org/2000/svg" height="24" viewBox="0 0 24 24" width="24" focusable="false" aria-hidden="true" style="pointer-events: none; display: inherit; width: 100%; height: 100%;">` +
  `<path d="${path}"></path></svg></div></span></yt-icon>`;

/** A classic iron-iconset icon, as iron-iconset-svg's _prepareSvgClone builds it inside the <yt-icon>. */
const classicIconHtml = (path, size) =>
  `<yt-icon class="style-scope ${BADGE}">` +
  `<svg viewBox="0 0 ${size} ${size}" preserveAspectRatio="xMidYMid meet" focusable="false" style="pointer-events: none; display: block; width: 100%; height: 100%;" class="style-scope yt-icon">` +
  `<g class="style-scope yt-icon"><path d="${path}" class="style-scope yt-icon"></path></g></svg></yt-icon>`;

const badgeHtml_ = (type, label, inner, newShield) =>
  `<${BADGE} class="style-scope yt-live-chat-author-chip"${newShield ? ' enable-new-moderator-badge=""' : ''} aria-label="${label}" type="${type}" shared-tooltip-text="${label}">` +
  `<div id="image" class="style-scope ${BADGE}">${inner}</div></${BADGE}>`;

/** Returns the markup for #chip-badges (`chip`) and #chat-badges (`chat`). */
export function badgeHtml({ role, verified, memberBadgeSrc, moderatorBadge = 'shield' }) {
  const newShield = moderatorBadge !== 'wrench';
  const chip = verified ? badgeHtml_('verified', 'Verified', iconHtml(CHECK_CIRCLE), newShield) : '';
  let chat = '';
  if (role === 'moderator') {
    chat = badgeHtml_('moderator', 'Moderator', newShield ? iconHtml(SHIELD) : classicIconHtml(WRENCH, 16), newShield);
  } else if (role === 'member' && memberBadgeSrc) {
    chat = badgeHtml_('member', 'Member', `<img src="${escapeHtml(memberBadgeSrc)}" class="style-scope ${BADGE}" alt="Member">`, newShield);
  }
  return { chip, chat };
}
