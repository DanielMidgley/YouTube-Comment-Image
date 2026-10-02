import assert from 'node:assert/strict';
import { test } from 'node:test';
import { escapeHtml, messageHtml, normalizeMessage, rowHtml } from '../../src/comment/render.js';

const base = { name: '@Someone', message: 'Hello chat', role: 'viewer', verified: false, avatarSrc: 'data:image/png;base64,AA==', timestamp: null };
const between = (html, start, end) => {
  const from = html.indexOf(start) + start.length;
  return html.slice(from, html.indexOf(end, from));
};

test('escapes user text everywhere it is inserted', () => {
  const html = rowHtml({ ...base, name: '<img src=x onerror=alert(1)>', message: '"><script>alert(1)</script>', timestamp: '<b>', avatarSrc: '" onload="x' });
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('<b>'));
  assert.ok(!html.includes('" onload="x'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
});

test('mirrors YouTube\'s row structure, including the zero-width spaces', () => {
  const html = rowHtml(base);
  assert.ok(html.startsWith('<yt-live-chat-text-message-renderer class="style-scope yt-live-chat-item-list-renderer" modern="" enable-improved-visibility-style="" enable-banner-update="" author-type="">'));
  assert.ok(html.includes('</yt-live-chat-author-chip>\u200b<div id="before-content-buttons"'));
  assert.ok(html.includes('</div>\u200b<span id="message-container"'));
  assert.equal(between(html, 'id="author-name" dir="auto" class="', '"'), ' style-scope yt-live-chat-author-chip style-scope yt-live-chat-author-chip');
  assert.ok(!/>\s+</.test(html.replaceAll('\u200b', '')), 'no whitespace between tags (it would render as spaces)');
});

test('roles set author-type, the name class and badges like YouTube', () => {
  const moderator = rowHtml({ ...base, role: 'moderator' });
  assert.ok(moderator.includes('author-type="moderator"'));
  assert.ok(moderator.includes('class="moderator style-scope yt-live-chat-author-chip'));
  assert.ok(between(moderator, '<span id="chat-badges"', '</span></yt-live-chat-author-chip>').includes('type="moderator"'));

  const owner = rowHtml({ ...base, role: 'owner' });
  assert.ok(owner.includes('author-type="owner" author-is-owner=""'));
  assert.ok(owner.includes('is-highlighted=""'));
  assert.ok(!owner.includes('yt-live-chat-author-badge-renderer'), 'owners have no badge');

  const verified = rowHtml({ ...base, verified: true });
  assert.ok(verified.includes('is-verified=""'));
  assert.ok(between(verified, '<span id="chip-badges"', '<span id="chat-badges"').includes('type="verified"'), 'verified badge sits inside the name chip');

  const member = rowHtml({ ...base, role: 'member', memberBadgeSrc: 'data:image/png;base64,BB==' });
  assert.ok(member.includes('class="member style-scope'));
  assert.ok(member.includes('type="member"') && member.includes('src="data:image/png;base64,BB=="'));
  assert.ok(!rowHtml({ ...base, role: 'member' }).includes('<yt-live-chat-author-badge-renderer'), 'no member badge without an image');

  assert.ok(rowHtml({ ...base, role: 'nonsense' }).includes('author-type=""'), 'unknown roles fall back to viewer');
});

test("moderator badge: the current shield, or YouTube's classic wrench with the classic colours", () => {
  const current = rowHtml({ ...base, role: 'moderator' });
  assert.ok(current.includes('enable-new-moderator-text-color=""') && current.includes('enable-new-moderator-badge=""'));
  assert.ok(current.includes('viewBox="0 0 24 24"') && current.includes('d="M3 4.998v9.857'));

  const classic = rowHtml({ ...base, role: 'moderator', moderatorBadge: 'wrench' });
  assert.ok(!classic.includes('enable-new-moderator-text-color'), 'the chip loses the new moderator colour');
  assert.ok(!classic.includes('enable-new-moderator-badge'), 'the badge loses the new moderator colour');
  assert.ok(classic.includes('viewBox="0 0 16 16" preserveAspectRatio="xMidYMid meet"') && classic.includes('d="M9.64589146,7.05569719'));

  assert.ok(rowHtml({ ...base, role: 'moderator', moderatorBadge: 'bogus' }).includes('d="M3 4.998v9.857'), 'unknown values fall back to the shield');
});

test('messages: emoji become YouTube emoji images, line breaks become spaces', () => {
  const html = messageHtml('hi 😆 & bye');
  assert.ok(html.startsWith('hi <img class="small-emoji emoji yt-formatted-string style-scope yt-live-chat-text-message-renderer" src="https://fonts.gstatic.com/s/e/notoemoji/15.1/1f606/72.png" alt="😆" id="emoji-0">'));
  assert.ok(html.endsWith(' &amp; bye'));
  assert.equal(messageHtml('😆', { emojiOverrides: { '😆': 'app://local/x.png' } }).match(/src="([^"]+)"/)[1], 'app://local/x.png');
  assert.equal(normalizeMessage('a\r\nb\nc\rd'), 'a b c d');
  assert.equal(normalizeMessage('  kept  '), '  kept  ');
  const nbsp = String.fromCharCode(0xa0); // YouTube's chat input turns these into plain spaces
  assert.equal(normalizeMessage(`wait${nbsp}${nbsp}what`), 'wait  what');
});

test('timestamp text is always present (CSS decides whether it shows)', () => {
  assert.ok(rowHtml({ ...base, timestamp: '2:41 PM' }).includes('<span id="timestamp" class="style-scope yt-live-chat-text-message-renderer">2:41 PM</span>'));
});
