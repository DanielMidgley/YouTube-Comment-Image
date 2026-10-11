// Plans corpus cases: which rows an image shows, at which scale, theme and width, through which transforms.
// Plans are plain data (rendered by make-corpus.js), drawn from a seeded random stream: every case from its
// own fork, so a case depends only on the seed and its index. The curated fixtures are written out by hand.
import { DEFAULT_AVATAR_COLORS } from '../../src/comment/avatar.js';
import { AVATAR_STYLES } from './avatars.js';
import { createRng } from './random.js';
import { makeMessage, makeName, makeTimestamps } from './vocabulary.js';

export const SCALES = [1, 1.25, 1.5, 1.75, 2, 2.5, 3];
export const THEMES = ['dark', 'light'];
/** The four roles, with members with and without a badge image and both moderator badges. */
export const ROLE_VARIANTS = ['viewer', 'member-badge', 'member', 'moderator-shield', 'moderator-wrench', 'owner'];
export const REAL_SCALES = [1, 1.25, 1.5, 2];

// Weights for cases beyond the strata (and for the rows around a stack's main row).
const SCALE_WEIGHTS = [[1, 20], [1.25, 20], [1.5, 20], [1.75, 8], [2, 16], [2.5, 8], [3, 8]];
const THEME_WEIGHTS = [['dark', 60], ['light', 40]];
const VARIANT_WEIGHTS = [['viewer', 50], ['member-badge', 12], ['member', 6], ['moderator-shield', 12], ['moderator-wrench', 6], ['owner', 14]];
const OTHER_ROW_VARIANTS = [['viewer', 75], ['member-badge', 8], ['member', 4], ['moderator-shield', 7], ['moderator-wrench', 2], ['owner', 4]];
const ROW_WIDTH_WEIGHTS = [[340, 10], [385, 30], [400, 35], [415, 15], [500, 10]];
const MARGIN_WEIGHTS = [[0, 85], [4, 10], [12, 5]];
const TIMESTAMP_WEIGHTS = [[null, 60], ['clock', 20], ['clock-12', 6], ['elapsed', 8], ['elapsed-hours', 6]];

function roleOf(variant) {
  switch (variant) {
    case 'member-badge': return { role: 'member', memberBadge: true, moderatorBadge: 'shield' };
    case 'member': return { role: 'member', memberBadge: false, moderatorBadge: 'shield' };
    case 'moderator-shield': return { role: 'moderator', memberBadge: false, moderatorBadge: 'shield' };
    case 'moderator-wrench': return { role: 'moderator', memberBadge: false, moderatorBadge: 'wrench' };
    default: return { role: variant, memberBadge: false, moderatorBadge: 'shield' };
  }
}

/** An avatar for a row: YouTube's letter avatar (usually in the colour its name hashes to) or a picture. */
function planAvatar(rng, kind) {
  if (kind === 'letter') return { kind, color: rng.chance(0.85) ? null : rng.pick(DEFAULT_AVATAR_COLORS) };
  return { kind: 'image', style: rng.pick(AVATAR_STYLES), seed: rng.int(0, 999_999_999) };
}

function resampleFactor(rng) {
  for (;;) {
    const factor = Math.round(rng.float(0.8, 1.35) * 1000) / 1000;
    if (Math.abs(factor - 1) >= 0.04) return factor;
  }
}

/**
 * Transforms, each drawn independently (so some combine): JPEG ~19 %, pad ~19 %, stack ~13 %, avatar cut
 * ~7 % (of cases with an avatar), resample ~7 %, leaving about half the cases as the app's exact export. Cuts
 * are fractions of the cut row's height and the avatar's width; make-corpus.js turns them into device px
 * once the rows are measured.
 */
function planTransform(rng) {
  const jpegQuality = rng.chance(0.19) ? rng.int(60, 95) : null;
  const pad = rng.chance(0.19) ? { left: rng.int(2, 30), top: rng.int(2, 30), right: rng.int(2, 30), bottom: rng.int(2, 30) } : null;
  const resample = rng.chance(0.07) ? resampleFactor(rng) : null;
  let stack = null;
  if (rng.chance(0.13)) {
    const count = rng.int(2, 4);
    const cutTop = rng.chance(0.5) ? Math.round(rng.float(0.3, 0.7) * 100) / 100 : 0;
    let cutBottom = rng.chance(0.4) ? Math.round(rng.float(0.3, 0.7) * 100) / 100 : 0;
    if (count === 2 && cutTop) cutBottom = 0; // keep one whole row to read
    stack = { count, cutTop, cutBottom };
  }
  const avatarCut = rng.chance(0.07) ? Math.round(rng.float(0.15, 0.85) * 100) / 100 : null;
  return { jpegQuality, pad, resample, stack, avatarCut };
}

/**
 * Settles everything about a case except its rows' content, which `makeRows` supplies:
 * makeRows({ rng, count, focus, focusVariant, timestampStyle }) → rows (without `avatar`: planned here).
 * `focus` is the row the case is about (its theme × role × scale stratum): the first whole row.
 */
function planCase(rng, { id, theme, scale, focusVariant, makeRows }) {
  const transform = planTransform(rng);
  const avatarKind = rng.weighted([['letter', 50], ['image', 30], ['none', 20]]);
  const hideAvatar = avatarKind === 'none';
  if (hideAvatar) transform.avatarCut = null; // nothing left to cut through
  const rowWidth = rng.weighted(ROW_WIDTH_WEIGHTS);
  const margin = transform.stack ? 0 : rng.weighted(MARGIN_WEIGHTS);
  const timestampStyle = rng.weighted(TIMESTAMP_WEIGHTS);
  const count = transform.stack?.count ?? 1;
  const focus = transform.stack?.cutTop ? 1 : 0;
  // A loose snip shows plain chat background only where there is some: not left of an avatar the snip
  // leaves out or cuts through, and not above or below a row it cuts through.
  if (transform.pad) {
    if (hideAvatar || transform.avatarCut) transform.pad.left = 0;
    if (transform.stack?.cutTop) transform.pad.top = 0;
    if (transform.stack?.cutBottom) transform.pad.bottom = 0;
  }
  const rows = makeRows({ rng: rng.fork('rows'), count, focus, focusVariant, timestampStyle }).map((row, i) => ({
    ...row,
    avatar: hideAvatar ? { kind: 'none' } : planAvatar(rng.fork(`avatar-${i}`), i === focus ? avatarKind : rng.weighted([['letter', 60], ['image', 40]])),
  }));
  return { id, theme, scale, rowWidth, margin, hideAvatar, timestampStyle, focus, rows, transform };
}

function syntheticRows({ rng, count, focus, focusVariant, timestampStyle }) {
  const timestamps = timestampStyle ? makeTimestamps(rng, timestampStyle, count) : Array(count).fill(null);
  return timestamps.map((timestamp, i) => {
    const rowRng = rng.fork(`row-${i}`);
    const variant = i === focus ? focusVariant : rowRng.weighted(OTHER_ROW_VARIANTS);
    const name = makeName(rowRng);
    const message = makeMessage(rowRng);
    const { role, memberBadge, moderatorBadge } = roleOf(variant);
    return {
      name: name.name,
      message: message.text,
      role,
      verified: rowRng.chance(role === 'owner' ? 0.5 : 0.2),
      moderatorBadge,
      memberBadge,
      timestamp,
      meta: { nameKind: name.kind, accented: name.accented, confusable: name.confusable, messageKind: message.kind, emoji: message.emoji },
    };
  });
}

/**
 * `count` synthetic cases. The first 84 cover every theme × role variant × scale combination once (in a
 * seeded order); the rest draw them by weight.
 */
export function planCorpus({ count, seed }) {
  const root = createRng(seed);
  const strata = root.fork('strata').shuffle(
    THEMES.flatMap((theme) => ROLE_VARIANTS.flatMap((variant) => SCALES.map((scale) => ({ theme, variant, scale })))),
  );
  return Array.from({ length: count }, (_, index) => {
    const rng = root.fork(`case-${index}`);
    const stratum = strata[index]
      ?? { theme: rng.weighted(THEME_WEIGHTS), variant: rng.weighted(VARIANT_WEIGHTS), scale: rng.weighted(SCALE_WEIGHTS) };
    return planCase(rng, {
      id: `c${String(index + 1).padStart(4, '0')}`,
      theme: stratum.theme,
      scale: stratum.scale,
      focusVariant: stratum.variant,
      makeRows: syntheticRows,
    });
  });
}

/**
 * Cases from real chat rows (see real-rows.js): every row at each of REAL_SCALES, with the same random
 * presentation and transforms as synthetic cases. A stack shows the row with its neighbours in chat order.
 */
export function planReal(realRows, { seed }) {
  const root = createRng(`${seed}/real`);
  const plans = [];
  realRows.forEach((_, index) => {
    for (const scale of REAL_SCALES) {
      const rng = root.fork(`row-${index}@${scale}`);
      plans.push(planCase(rng, {
        id: `r${String(index + 1).padStart(3, '0')}-${String(scale).replace('.', '_')}x`,
        theme: rng.weighted(THEME_WEIGHTS),
        scale,
        focusVariant: null,
        makeRows: ({ count, focus, timestampStyle }) => {
          // The window of `count` consecutive rows with this one at `focus`, kept inside the chat.
          const start = Math.max(0, Math.min(index - focus, realRows.length - count));
          return realRows.slice(start, start + count).map((row) => ({
            name: row.name,
            message: row.message,
            role: row.role,
            verified: row.verified,
            moderatorBadge: row.moderatorBadge,
            memberBadge: row.memberBadge,
            timestamp: timestampStyle && row.timestamp ? row.timestamp : null,
            meta: { nameKind: row.name.startsWith('@') ? 'handle' : 'display', customEmoji: row.customEmoji ?? 0 },
          }));
        },
      }));
    }
  });
  // A real row's own timestamp replaces the planned style; if a row has none, its chat shows none.
  for (const plan of plans) {
    if (plan.rows.some((row) => !row.timestamp)) {
      plan.timestampStyle = null;
      for (const row of plan.rows) row.timestamp = null;
    } else if (plan.timestampStyle) {
      plan.timestampStyle = 'real';
    }
  }
  return plans;
}

// ---- Fixtures --------------------------------------------------------------------------------------------

const NARROW_NBSP = String.fromCharCode(0x202f); // YouTube's clock times put it before AM/PM
const NONE = { kind: 'none' };
const image = (style, seed) => ({ kind: 'image', style, seed });

function row(name, message, extra = {}) {
  return {
    name,
    message,
    role: 'viewer',
    verified: false,
    moderatorBadge: 'shield',
    memberBadge: false,
    timestamp: null,
    avatar: { kind: 'letter', color: null },
    meta: { nameKind: name.startsWith('@') ? 'handle' : 'display' },
    ...extra,
  };
}

function fixture(id, { theme, scale, rowWidth = 400, hideAvatar = false, timestampStyle = null, transform = {} }, rows) {
  return {
    id,
    theme,
    scale,
    rowWidth,
    margin: 0,
    hideAvatar,
    timestampStyle,
    focus: transform.stack?.cutTop ? 1 : 0,
    rows,
    transform: { jpegQuality: null, pad: null, resample: null, stack: null, avatarCut: null, ...transform },
  };
}

/**
 * The curated set committed in test/fixtures/screenshots/ for fast unit tests: small images covering both
 * themes, every role, verified, each timestamp style, each avatar kind, scales 1–2, a multi-line message,
 * emoji at the start, middle and end (and alone), a display name, a stack with a cut row, JPEG, a loose
 * snip, a snip through the avatar and a handle made of look-alike letters.
 */
export function planFixtures() {
  return [
    fixture('dark-viewer-letter-1x', { theme: 'dark', scale: 1 }, [row('@quietotter42', 'what song is this?')]),
    fixture('light-viewer-image-clock-1_25x', { theme: 'light', scale: 1.25, timestampStyle: 'clock' },
      [row('@PixelGecko', 'greetings from Portugal!', { avatar: image('portrait', 11), timestamp: `2:41${NARROW_NBSP}PM` })]),
    fixture('dark-member-badge-1_5x', { theme: 'dark', scale: 1.5 },
      [row('@vinyl_moose', 'been a member for 2 years now, best 5$ I spend every month', { role: 'member', memberBadge: true })]),
    fixture('light-member-no-badge-2x', { theme: 'light', scale: 2 },
      [row('@lunar.biscuit', 'happy birthday to the drummer!', { role: 'member' })]),
    fixture('dark-moderator-verified-1x', { theme: 'dark', scale: 1 },
      [row('@IronLlama_Mod', 'please keep chat friendly :)', { role: 'moderator', verified: true })]),
    fixture('light-moderator-wrench-clock12-1_25x', { theme: 'light', scale: 1.25, timestampStyle: 'clock-12' },
      [row('@sleepy_kettle', 'reminder: no spoilers in chat', { role: 'moderator', moderatorBadge: 'wrench', timestamp: `12:03${NARROW_NBSP}AM` })]),
    fixture('dark-owner-elapsed-1_5x', { theme: 'dark', scale: 1.5, timestampStyle: 'elapsed' },
      [row('@CopperOrbitMusic', 'thanks for hanging out everyone!!', { role: 'owner', timestamp: '31:55' })]),
    fixture('light-owner-verified-hours-2x', { theme: 'light', scale: 2, timestampStyle: 'elapsed-hours' },
      [row('@NeonOrchard', 'new single drops Friday', { role: 'owner', verified: true, timestamp: '1:02:33', avatar: image('logo', 5) })]),
    fixture('dark-verified-no-avatar-1x', { theme: 'dark', scale: 1, hideAvatar: true },
      [row('@HollowTideTV', 'that transition was smooth', { verified: true, avatar: NONE })]),
    fixture('dark-multiline-1_25x', { theme: 'dark', scale: 1.25, rowWidth: 385 },
      [row('@rustywalrus', 'I have been listening to this band since high school and they never miss. The way the drums come in after the quiet part gives me chills every single time, honestly the best stream all month!')]),
    fixture('light-emoji-start-1x', { theme: 'light', scale: 1 }, [row('@ember_sprout', '\u{1F525}\u{1F525} this riff is so good')]),
    fixture('dark-emoji-middle-1_5x', { theme: 'dark', scale: 1.5 }, [row('@Marble.Raven', 'okay \u{1F602}\u{1F602} that was clean')]),
    fixture('light-emoji-end-2x', { theme: 'light', scale: 2 }, [row('@turnip_tempo', `love this part ${String.fromCodePoint(0x2764, 0xfe0f)}`)]),
    fixture('dark-display-name-1x', { theme: 'dark', scale: 1 },
      [row('Zoë Ashbrook', 'saw them live in Oslo, best night ever', { avatar: image('landscape', 7) })]),
    fixture('dark-stack3-cut-top-1_25x', { theme: 'dark', scale: 1.25, transform: { stack: { count: 3, cutTop: 0.5, cutBottom: 0 } } }, [
      row('@glacier_moth', 'first time catching one of these live'),
      row('@Willow.Comet', 'is the merch still $25?', { avatar: image('blobs', 3) }),
      row('@sel_mor', 'this channel deserves way more subs', { role: 'moderator' }),
    ]),
    fixture('dark-jpeg-1_5x', { theme: 'dark', scale: 1.5, transform: { jpegQuality: 80 } },
      [row('@MarbleRaven7', 'the bass is so heavy on this one', { avatar: image('gradient', 9) })]),
    fixture('light-pad-1x', { theme: 'light', scale: 1, transform: { pad: { left: 12, top: 8, right: 20, bottom: 6 } } },
      [row('@turbo-pigeon', 'audio is a bit out of sync for me (headphones)')]),
    fixture('light-confusable-1x', { theme: 'light', scale: 1 }, [row('@Il1lO0o_rnvvm', 'W')]),
    fixture('dark-emoji-only-1_25x', { theme: 'dark', scale: 1.25 }, [row('@sleepymammoth', '\u{1F602}\u{1F602}\u{1F44D}\u{1F3FD}')]),
    fixture('light-avatar-cut-1_5x', { theme: 'light', scale: 1.5, transform: { avatarCut: 0.5 } },
      [row('@lazy_lantern', '10/10 would listen again', { avatar: image('portrait', 21) })]),
  ];
}
