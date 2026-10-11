// Invented author names, chat messages and timestamps for the screenshot corpus. Everything is made up:
// handles and display names are assembled from generic words and syllables, messages from generic
// live-chat phrases about a music stream. The mix aims at what makes reading a screenshot hard: letters OCR
// mixes up (l I 1, 0 O o, rn m, vv w), mixed case, digits, punctuation, curly quotes, emoji anywhere, and
// messages long enough to wrap.
import { YOUTUBE_EMOJI_CODES } from '../../src/comment/youtube-emoji.js';
import { isEmoji } from '../../src/comment/emoji.js';
import { capText } from '../../src/comment/limits.js';

const NARROW_NBSP = '\u202f'; // YouTube's clock times put U+202F before AM/PM ('h:mm a')
const RIGHT_QUOTE = '\u2019';
const LEFT_DOUBLE = '\u201c';
const RIGHT_DOUBLE = '\u201d';
const ELLIPSIS = '\u2026';
export const MAX_MESSAGE = 200; // YouTube's chat input limit

// ---- Names ----------------------------------------------------------------------------------------------

const ADJECTIVES = [
  'quiet', 'lazy', 'neon', 'tiny', 'cosmic', 'salty', 'frosty', 'rusty', 'sleepy', 'lucky', 'hidden', 'golden',
  'wild', 'silent', 'crispy', 'fuzzy', 'mellow', 'swift', 'pixel', 'retro', 'velvet', 'hollow', 'lunar', 'solar',
  'atomic', 'paper', 'iron', 'copper', 'minty', 'spicy', 'soggy', 'turbo', 'mega', 'nano', 'dusty', 'misty',
  'stormy', 'odd', 'brave', 'grumpy', 'little', 'mild', 'loud', 'wobbly',
];
const NOUNS = [
  'otter', 'badger', 'toast', 'lantern', 'pickle', 'falcon', 'noodle', 'cactus', 'walrus', 'comet', 'ember',
  'pebble', 'waffle', 'gecko', 'raven', 'moose', 'turnip', 'bagel', 'marble', 'sprout', 'kettle', 'yeti', 'squid',
  'pigeon', 'muffin', 'biscuit', 'panda', 'orbit', 'beacon', 'harbor', 'meadow', 'glacier', 'canyon', 'circuit',
  'gadget', 'riff', 'chord', 'tempo', 'vinyl', 'echo', 'synth', 'groove', 'llama', 'lemon', 'mammoth', 'window',
  'willow', 'hammer', 'mirror', 'molly', 'mallow', 'minnow', 'wombat', 'mole',
];
const SYLLABLES = ['ka', 'vo', 'ri', 'zel', 'mor', 'tha', 'lin', 'dra', 'ny', 'kes', 'pim', 'bru', 'gal', 'sel', 'wy',
  'fen', 'ox', 'ul', 'ith', 'mo', 'lo', 'mi', 'wu', 'ro', 'na', 'il', 'ol', 'vim', 'rul'];
const HANDLE_TAGS = ['yt', 'tv', 'plays', 'music', 'live', 'xd', 'hq', 'gg', 'irl', 'fm', 'og', 'official'];
const ACCENTED_WORDS = ['josé', 'zoë', 'renée', 'ñandú', 'brännvik', 'søren', 'françois', 'åsa', 'mélodie', 'würfel',
  'café', 'piñata', 'crème', 'jökull', 'łódka', 'čaj'];

// Letters that OCR (and people) confuse: l I 1 | 0 O o | rn m | vv w | cl d.
const CONFUSABLE_CHUNKS = ['Il1', 'lI1', '1lI', 'IlI', 'll1', 'O0o', '0Oo', 'o0O', '00O', 'rn', 'rnm', 'mrn', 'vv',
  'vvw', 'wvv', 'nn', 'cl', 'Il', 'lI', 'II', 'll', 'l1', 'O0'];
const CONFUSABLE_SWAPS = [['l', 'I'], ['l', '1'], ['I', 'l'], ['i', 'l'], ['o', '0'], ['o', 'O'], ['O', '0'],
  ['m', 'rn'], ['w', 'vv'], ['d', 'cl'], ['n', 'rn']];

const FIRST_NAMES = ['Maya', 'Tomas', 'Priya', 'Jonah', 'Elena', 'Marcus', 'Aiko', 'Diego', 'Hannah', 'Kofi', 'Lena',
  'Ravi', 'Sofia', 'Oscar', 'Nadia', 'Felix', 'Ingrid', 'Mateo', 'Yara', 'Ollie', 'Wren', 'Milo', 'Iris', 'Lillian',
  'William', 'Molly', 'Emmett', 'Willa', 'Liam', 'Isla', 'Camille', 'Malik', 'Noor', 'Ilse', 'Olli'];
const ACCENTED_FIRST_NAMES = ['Zoë', 'Inès', 'Søren', 'Björn', 'Renée', 'José', 'Chloé', 'Lucía', 'Łucja', 'Dagný',
  'Thérèse', 'Íñigo', 'Mónica', 'François', 'Jürgen', 'Åsa', 'Noémie', 'Žofia', 'Ana Lucía', 'Ömer'];
const SURNAME_STARTS = ['Ash', 'Bram', 'Cor', 'Dun', 'El', 'Fen', 'Gal', 'Hol', 'Kel', 'Lind', 'Mor', 'Nor', 'Orm',
  'Pell', 'Quin', 'Rav', 'Sel', 'Thorn', 'Wex', 'Yar', 'Mill', 'Will', 'Moll', 'Ill', 'Wim', 'Lom'];
const SURNAME_ENDS = ['wick', 'brook', 'ford', 'ley', 'mere', 'stead', 'ton', 'vale', 'croft', 'holm', 'ridge', 'well',
  'by', 'dale', 'worth', 'mont', 'lin', 'man'];
const ACCENTED_SURNAME_ENDS = ['ström', 'gård', 'ière', 'ández', 'ović', 'ský', 'mün', 'ão'];

// Long names: YouTube allows handles of up to 30 characters (and longer display names), and in a narrow chat
// a long name moves the name chip below the timestamp, wraps a display name or the verified badge onto a
// second line and starts the message on a line of its own.
const LONG_HANDLE = { min: 21, max: 30, chance: 0.06 };
const LONG_DISPLAY_NAME = { min: 24, max: 40, chance: 0.2 };
// What overflows its row is clipped (overflow: hidden), and the image would no longer show the whole name. A
// 340px row (the narrowest planned) leaves 276px right of the avatar, less the owner chip's padding and two
// badges; a handle has nowhere to wrap but after a hyphen, so a long one stays within 230px (by nameWidth).
const MAX_HANDLE_WIDTH = 230;

/**
 * A name's advance width in 14px Roboto Medium (CSS px), estimated high from rough letter classes: at or
 * above Chromium's own width for every name the corpus measured.
 */
function nameWidth(text) {
  let width = 0;
  for (const c of text) {
    if (/[iljI.,'!|:;]/.test(c)) width += 4;
    else if (/[frt()-]/.test(c)) width += 6;
    else if (/[mwMW@]/.test(c)) width += 13.5;
    else if (/[A-Z0-9]/.test(c)) width += 10;
    else width += 8.5;
  }
  return width;
}

const capitalize = (word) => word.charAt(0).toUpperCase() + word.slice(1);

function syllableWord(rng) {
  let word = '';
  for (let n = rng.int(2, 4); n > 0; n--) word += rng.pick(SYLLABLES);
  return word;
}

function handleWords(rng, accented) {
  const words = (() => {
    switch (rng.weighted([['adj-noun', 5], ['noun-noun', 2], ['noun', 2], ['syllables', 2]])) {
      case 'adj-noun': return [rng.pick(ADJECTIVES), rng.pick(NOUNS)];
      case 'noun-noun': return [rng.pick(NOUNS), rng.pick(NOUNS)];
      case 'noun': return [rng.pick(NOUNS)];
      default: return [syllableWord(rng)];
    }
  })();
  if (accented) words[rng.int(0, words.length - 1)] = rng.pick(ACCENTED_WORDS);
  switch (rng.weighted([['lower', 4], ['camel', 4], ['capital', 1], ['upper', 0.6], ['mixed', 0.6]])) {
    case 'lower': return words;
    case 'camel': return words.map(capitalize);
    case 'capital': return words.map((word, i) => (i === 0 ? capitalize(word) : word));
    case 'upper': return words.map((word) => word.toUpperCase());
    default: return words.map((word) => [...word].map((c) => (rng.chance(0.5) ? c.toUpperCase() : c)).join(''));
  }
}

function digits(rng, length) {
  let text = '';
  for (let i = 0; i < length; i++) text += String(rng.int(0, 9));
  return text;
}

/** Swaps a letter for a look-alike, or puts a run of look-alikes in. */
function confuse(rng, text) {
  const swaps = CONFUSABLE_SWAPS.filter(([from]) => text.includes(from));
  if (swaps.length && rng.chance(0.55)) {
    let result = text;
    for (let n = rng.int(1, 2); n > 0; n--) {
      const [from, to] = rng.pick(swaps);
      const positions = [...result.matchAll(new RegExp(from, 'g'))].map((m) => m.index);
      if (!positions.length) continue;
      const at = rng.pick(positions);
      result = result.slice(0, at) + to + result.slice(at + from.length);
    }
    return result;
  }
  const chunk = rng.pick(CONFUSABLE_CHUNKS);
  switch (rng.pick(['start', 'end', 'middle'])) {
    case 'start': return chunk + text;
    case 'end': return text + chunk;
    default: {
      const at = rng.int(1, Math.max(1, text.length - 1));
      return text.slice(0, at) + chunk + text.slice(at);
    }
  }
}

const HANDLE_CHARS = /[^\p{L}\p{N}_.-]/gu;

/** An invented @handle: 3–30 characters after the @ (letters, digits, _ - .), YouTube's rules. */
export function makeHandle(rng, { accented = false, confusable = false } = {}) {
  let body;
  if (confusable && rng.chance(0.2)) {
    // Nothing but look-alikes and digits: the hardest case for OCR.
    body = '';
    for (let n = rng.int(2, 4); n > 0; n--) body += rng.pick(CONFUSABLE_CHUNKS);
    if (rng.chance(0.5)) body = `${rng.pick(['x', 'X', 'Mr', 'the'])}${body}`;
  } else {
    const separator = rng.weighted([['', 5], ['_', 2], ['.', 1], ['-', 1]]);
    body = handleWords(rng, accented).join(separator);
    if (confusable) body = confuse(rng, body);
  }
  switch (rng.weighted([['none', 4], ['digits', 4], ['tag', 1.5], ['year', 1]])) {
    case 'digits': body += digits(rng, rng.int(1, 4)); break;
    case 'tag': body += rng.pick(['', '_', '.']) + rng.pick(HANDLE_TAGS); break;
    case 'year': body += String(rng.int(1985, 2012)); break;
    default: break;
  }
  body = body.replace(HANDLE_CHARS, '').replace(/([_.-])[_.-]+/g, '$1');
  body = [...body].slice(0, 30).join('').replace(/^[_.-]+|[_.-]+$/g, '');
  while ([...body].length < 3) body += digits(rng, 1);
  return `@${body}`;
}

function surname(rng, accented) {
  const end = accented && rng.chance(0.5) ? rng.pick(ACCENTED_SURNAME_ENDS) : rng.pick(SURNAME_ENDS);
  return rng.pick(SURNAME_STARTS) + end;
}

/** An older account's display name (no @, may contain spaces). */
export function makeDisplayName(rng, { accented = false } = {}) {
  const first = accented && rng.chance(0.7) ? rng.pick(ACCENTED_FIRST_NAMES) : rng.pick(FIRST_NAMES);
  switch (rng.weighted([['full', 5], ['initial', 1], ['lower', 1], ['double', 0.5], ['adj-noun', 2], ['club', 1], ['the', 1], ['fan', 0.7]])) {
    case 'full': return `${first} ${surname(rng, accented)}`;
    case 'initial': return `${first} ${rng.pick(SURNAME_STARTS).charAt(0)}.`;
    case 'lower': return `${first} ${surname(rng, accented)}`.toLowerCase();
    case 'double': return `${first} ${surname(rng, accented)}-${surname(rng, false)}`;
    case 'adj-noun': return `${capitalize(rng.pick(ADJECTIVES))} ${capitalize(rng.pick(NOUNS))}`;
    case 'club': return `The ${capitalize(rng.pick(NOUNS))} ${rng.pick(['Club', 'Gang', 'Crew', 'Society'])}`;
    case 'the': return `${first} the ${capitalize(rng.pick(NOUNS))}`;
    default: return `${capitalize(rng.pick(NOUNS))} Fan ${rng.int(1, 99)}`;
  }
}

/** `handle` grown to 21–30 characters with more words or digits in its own style, as wide as a row allows. */
function lengthenHandle(rng, handle) {
  const style = handle === handle.toUpperCase() ? 'upper' : /[a-z][A-Z]/.test(handle) ? 'camel' : 'lower';
  const separator = handle.slice(1).match(/[_.-]/)?.[0] ?? '';
  const target = rng.int(LONG_HANDLE.min, LONG_HANDLE.max);
  const trim = (text) => text.replace(/[_.-]+$/, '');
  const original = [...handle].length;
  let long = handle;
  while ([...long].length - 1 < target) {
    const word = rng.chance(0.25) ? digits(rng, rng.int(2, 4)) : rng.pick(rng.chance(0.5) ? NOUNS : ADJECTIVES);
    long += (rng.chance(0.5) ? separator : '') + (style === 'upper' ? word.toUpperCase() : style === 'camel' ? capitalize(word) : word);
  }
  long = trim([...long].slice(0, target + 1).join(''));
  while (nameWidth(long) > MAX_HANDLE_WIDTH && [...long].length > original) long = trim([...long].slice(0, -1).join(''));
  return long;
}

/** `name` with more words, to 24–40 characters: it wraps inside the name chip where the chat is narrow. */
function lengthenDisplayName(rng, name) {
  const target = rng.int(LONG_DISPLAY_NAME.min, LONG_DISPLAY_NAME.max);
  let result = name;
  while ([...result].length < target) {
    result += ` ${rng.chance(0.5) ? capitalize(rng.pick(NOUNS)) : rng.pick(SURNAME_STARTS) + rng.pick(SURNAME_ENDS)}`;
  }
  return result;
}

/** A name for a chat row: mostly @handles, some display names (older accounts), a few of them long. */
export function makeName(rng) {
  const kind = rng.weighted([['handle', 85], ['display', 15]]);
  const accented = rng.chance(kind === 'display' ? 0.3 : 0.04);
  const confusable = kind === 'handle' && rng.chance(0.35);
  let name = kind === 'handle' ? makeHandle(rng, { accented, confusable }) : makeDisplayName(rng, { accented });
  // From a stream of its own (named after the name), so lengthening a name leaves the rest of the row as it was.
  const long = rng.fork(`long:${name}`);
  if (kind === 'handle' ? long.chance(LONG_HANDLE.chance) : long.chance(LONG_DISPLAY_NAME.chance)) {
    name = kind === 'handle' ? lengthenHandle(long, name) : lengthenDisplayName(long, name);
  }
  return { name, kind, accented: /[^\x20-\x7e]/.test(name), confusable };
}

// ---- Messages ----------------------------------------------------------------------------------------------

const REACTIONS = [
  'W', 'L', 'lol', 'lmao', 'LOL', 'LMAO', '?', '??', '!!!', 'LETS GOOO', 'lets goooo', 'gg', 'GG', 'W stream',
  'hi chat', 'hello', 'hey everyone', 'first', 'F', 'o7', 'no way', 'bruh', 'yesss', 'nooo', 'omg', 'wow', 'sheesh',
  'true', 'real', 'facts', 'same', '+1', 'hype', 'wait what', 'HUH', 'clean', 'sick', 'banger', 'insane', 'ayy',
  'oof', 'rip', 'hahaha', 'ty', 'thx', 'gn chat', 'gm', 'hiii', 'yo', 'nice', 'NICE', 'peak', 'cooking', 'bro what',
  'chat is this real', 'lmaooo', 'ez', 'big W', 'massive L', 'so good', 'goosebumps', 'chills', 'encore!',
  'ONE MORE', 'again!', 'w song', 'hi from the back row', 'lurking', 'back', 'brb', 'AAAA', '11/10', 'ok', 'k',
  'mhm', 'yup', 'nah', 'agreed', 'this.', 'yes.', 'xD', 'XD', ':)', ':D', '<3', 'o/', '\\o/',
];
const EMOTICONS = [':)', ':D', ':(', ';)', ':P', 'xD', 'XD', '<3', '^^', ':/', ':O', '=)', ':3', 'o7', ':)))', ';-)',
  ':-D', 'D:', '>:('];
const QUESTIONS = [
  'what song is this?', 'what guitar is that?', 'when is the next stream?', 'is this live or a premiere?',
  'how long have you been playing {instrument}?', 'what time is it there?', 'can you play {song} next?',
  'did anyone else lose connection for a sec?', 'wait is that a new {thing}?', 'how do you get that {thing} sound?',
  "what's the song called?", 'any tips for a beginner?', 'who else is watching from {place}?',
  'is the merch still {price}?', 'what settings do you use?', 'when does the second half start??',
  'how much was the {thing}?', 'can we get a {thing} tour?', 'is the {thing} tuned to drop C?',
  'are you going to upload the VOD?', 'what amp sim is that?', "how's the weather in {place}?",
  'is chat lagging or is it just me?', 'did you change the mic?', 'how many takes was that??',
  'what was the name of that plugin again?', 'is it {n} or {n2} bpm?', 'can you say hi to my sister? :)',
  'part {n} when?', "what's the {thing} for?", 'is this the new album?', 'why is the audio so quiet?',
  'does anyone know the tuning?', 'wait, did they just skip the bridge?', 'how is this free??',
  'can someone clip that?', 'is {song} on the setlist tonight?', 'where can I buy the {thing}?',
  'what does the "{word}" knob do?', 'who is on bass today?', 'is it too late to join?',
  'are tickets for {place} out yet?', 'do you ever sleep? lol', 'how old is that {thing}?!',
];
const STATEMENTS = [
  'this riff is so good', 'the mix sounds amazing tonight', 'been waiting all week for this', 'greetings from {place}!',
  'love the new {thing}', 'that was clean', 'my cat is watching too', "can't believe it's been {n} years",
  'the tone on that {thing} is unreal', 'just got here, what did I miss?', 'happy birthday to the drummer!',
  'chat is moving so fast nobody will notice I like {food}', 'audio is a bit out of sync for me',
  'that solo (at {time}) was insane', 'rock & roll will never die', 'drums + bass = perfect', "*chef's kiss*",
  '~vibes~', 'note to self: practice more', 'the {thing} costs like {price} now', '{n}% of chat is lurking',
  'saw them live in {place}, best night ever', 'this is my favorite part', 'the bass is so heavy on this one',
  'okay but the harmonies though', 'turn the vocals up a bit pls', 'that transition was smooth',
  'the lighting looks great today', 'my headphones are not ready for this', 'first time catching one of these live',
  'shoutout to everyone in the {place} timezone', "I've had this on repeat all week", 'the intro gave me chills',
  'hello from my lunch break', 'can confirm, the {thing} sounds better live', 'studying with this on in the background',
  'he said "one more song" {n} songs ago', 'chat: "is this live?" me: yes', 'the "short" break was {n} minutes',
  'that ending though...', 'wait; did the {thing} just break?', 'the drop at {time} - wow', 'shoutout to whoever mixed this (and the lights/camera crew)',
  'good morning from {place} :)', 'my dog started howling at the high note', 'okay that was actually perfect',
  'can we get an F for the snapped string', 'volume is fine for me (headphones)', 'my neighbour just knocked lol',
  'best live version so far', 'this channel deserves way more subs', 'this is going in my playlist',
];
const RANT_SENTENCES = [
  'honestly this is the best stream all month', 'I have been listening to this band since high school and they never miss',
  'the way the drums come in after the quiet part gives me chills every single time',
  "people in chat saying it's too loud need to turn their speakers down", 'can we talk about how good the vocals sound without any effects',
  'I drove 3 hours to see them last year and it was worth every minute', 'my neighbours are definitely going to complain but I do not care',
  'whoever is mixing this deserves a raise', 'this is exactly what I needed after a long day at work',
  'I keep telling my friends about this channel and none of them listen', 'the second verse hits completely different live',
  'also the camera work today is so much better than last week', "I can't stop replaying the bridge",
  'the guitar tone sounds like it was made in a cave in the best way possible', 'chat please stop asking about the tuning, it is in the description',
  'the merch store crashed twice before I could get a hoodie', 'if they play {song} I am going to lose it',
  'the last time I heard this song live was in {place} and it rained the whole time',
  'the crowd noise in the background makes it feel like a real show', 'I missed the start because of my bus but the recording will be up later right?',
  'every time I think it cannot get heavier, it gets heavier', 'this is the {n}th time I have said this but the drummer is a machine',
  'I would pay {price} just for a multitrack of this session', 'my headphones were not built for this much bass',
  "it's {time} here and I should be asleep", 'the solo was so fast my video froze for a second',
  'nobody talks about how good the backing vocals are', 'the setlist tonight is unbelievable from start to finish',
];
const MENTION_REPLIES = ['agreed', 'same here', 'no way lol', 'thank you!', 'it was {song}', 'check the description',
  "it's on the setlist", "it's {time} for me", 'welcome back!', 'yes, at the end', 'that was last week',
  'happy birthday!!', 'lol true', '+1', "it's the {thing}", 'i think so?', 'nope, live', 'same, from {place}',
  'you were right about the bridge', 'ty for the clip'];
const NUMBER_TEMPLATES = ['10/10', 'rated {n}/10', '{n}/10 would listen again', 'it was {price} on sale', '#1 fan right here',
  'day {n} of asking for {song}', 'the solo at {time} though', '100% agree', '24/7 stream when', '{n} hours in and still going',
  '1v1 me', 'top {n} songs of all time', 'only {big} subs?? underrated', '{price} says they play {song} next',
  '{n}x better than the studio version', 'tickets were {price} each', 'that took {n} takes?? no way',
  'setlist: {n} songs + encore', '2nd time watching today', '{n}k views by tomorrow', 'stream #{n} for me!',
  'it went from {n} to {big} viewers in 5 minutes', 'up {n}% from last stream'];
const HASHTAGS = ['#teamtabs', '#1fan', '#encore', '#drumcam', '#nospoilers', '#stream100', '#bassgang', '#latenightjam',
  '#firsttimehere', '#vinylclub', '#day47'];

const SLOTS = {
  place: ['Portugal', 'Ohio', 'Brazil', 'Norway', 'the UK', 'Manila', 'Toronto', 'Poland', 'Texas', 'Japan', 'Chile',
    'New Zealand', 'Kenya', 'Iceland', 'the Netherlands', 'Quebec', 'Bavaria', 'Lagos', 'Perth'],
  thing: ['guitar', 'amp', 'pedal', 'mic', 'headset', 'setup', 'keyboard', 'drum kit', 'interface', 'synth', 'capo',
    'plugin', 'cable', 'hoodie', 'poster', 'tuner', 'snare'],
  instrument: ['guitar', 'drums', 'bass', 'piano', 'violin', 'the ukulele', 'cello'],
  song: ['Paper Lanterns', 'Copper Sky', 'Hollow Tide', 'Neon Orchard', 'The Long Way Down', 'Glass Harbor',
    'Midnight Static', 'Velvet Engine', 'Northbound', 'Salt & Ember', 'Quiet Machines', 'Willow Lane'],
  food: ['pineapple pizza', 'cold noodles', 'pickles', 'cereal at 3am', 'tacos', 'olives'],
  word: ['drive', 'mojo', 'presence', 'bite', 'air'],
};

function price(rng) {
  const amount = rng.chance(0.25) ? `${rng.int(1, 49)}.${rng.pick(['99', '50', '00'])}` : String(rng.int(2, 120));
  return rng.weighted([[`$${amount}`, 4], [`${amount}$`, 3], [`€${amount}`, 1], [`${amount}€`, 1], [`£${amount}`, 1]]);
}

function clockText(rng) {
  return rng.chance(0.5) ? `${rng.int(0, 59)}:${String(rng.int(0, 59)).padStart(2, '0')}` : `${rng.int(1, 3)}:${String(rng.int(0, 59)).padStart(2, '0')}:${String(rng.int(0, 59)).padStart(2, '0')}`;
}

function fill(rng, template) {
  return template.replace(/\{(\w+)\}/g, (_, slot) => {
    switch (slot) {
      case 'n': return String(rng.weighted([[rng.int(1, 12), 3], [rng.int(13, 99), 2]]));
      case 'n2': return String(rng.int(60, 200));
      case 'big': return rng.pick(['1,500', '2,300', '12k', '900', '4,096', '10,000']);
      case 'price': return price(rng);
      case 'time': return clockText(rng);
      default: return rng.pick(SLOTS[slot]);
    }
  });
}

// YouTube's own emoji set, weighted towards what chat actually uses. ❤ comes both with and without its
// U+FE0F (YouTube drops the selector before matching, so both render as the same image).
const COMMON_EMOJI = [
  ['\u{1F602}', 10], ['\u{1F525}', 9], ['\u2764\uFE0F', 5], ['\u2764', 3], ['\u{1F62D}', 7], ['\u{1F44D}', 6],
  ['\u{1F64F}', 5], ['\u{1F480}', 6], ['\u{1F606}', 4], ['\u{1F923}', 6], ['\u2728', 4], ['\u{1F4AF}', 3],
  ['\u{1F44F}', 3], ['\u{1F60D}', 3], ['\u{1F970}', 2], ['\u{1F60E}', 2], ['\u{1F914}', 2], ['\u{1F389}', 2],
  ['\u{1F64C}', 2], ['\u{1F4AA}', 2], ['\u{1F440}', 3], ['\u{1F3B8}', 2], ['\u{1F941}', 1], ['\u{1F3A4}', 1],
  ['\u{1F3B6}', 2], ['\u{1F605}', 2], ['\u{1F633}', 2], ['\u{1FAE1}', 1], ['\u{1F918}', 2], ['\u{1F49C}', 1],
  ['\u{1F44B}', 2], ['\u{1F62E}', 1], ['\u{1F44D}\u{1F3FB}', 1], ['\u{1F64F}\u{1F3FD}', 1],
];
const ALL_EMOJI = YOUTUBE_EMOJI_CODES.trim().split(/\s+/)
  .map((code) => String.fromCodePoint(...code.split('_').map((hex) => parseInt(hex, 16))));
for (const [emoji] of COMMON_EMOJI) {
  if (!isEmoji(emoji)) throw new Error(`vocabulary: ${JSON.stringify(emoji)} is not in YouTube's emoji set.`);
}

function pickEmoji(rng) {
  return rng.chance(0.7) ? rng.weighted(COMMON_EMOJI) : rng.pick(ALL_EMOJI);
}

function emojiRun(rng, length) {
  const first = pickEmoji(rng);
  let run = first;
  for (let i = 1; i < length; i++) run += rng.chance(0.6) ? first : pickEmoji(rng);
  return run;
}

/** Stretches a word the way chat does ('so' → 'sooooo'). */
function stretch(rng, text) {
  const candidates = [...text.matchAll(/[A-Za-z]{2,}/g)];
  if (!candidates.length) return text;
  const { 0: word, index } = rng.pick(candidates);
  const last = word.at(-1);
  return text.slice(0, index) + word + last.repeat(rng.int(2, 6)) + text.slice(index + word.length);
}

const words = (text) => text.split(' ');

/** Cuts `text` to at most `max` code points, at a word boundary when there is one nearby. */
function fitLength(text, max) {
  if ([...text].length <= max) return text;
  const cut = capText(text, max);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:-]+$/, '');
}

/** Sentences strung together up to a length drawn from 90–200 characters: two to five lines of chat. */
function rant(rng) {
  const target = rng.int(90, MAX_MESSAGE);
  const sentences = rng.shuffle(RANT_SENTENCES);
  let text = '';
  while (sentences.length && [...text].length < target * 0.8) {
    let sentence = fill(rng, sentences.pop());
    if (rng.chance(0.3)) sentence = capitalize(sentence);
    const end = rng.weighted([['.', 3], ['', 2], ['!', 1], ['!!', 0.5], ['...', 0.5], [',', 1]]);
    const longer = (text ? `${text} ` : '') + sentence + end;
    if (text && [...longer].length > target) break;
    text = longer;
  }
  return fitLength(text, MAX_MESSAGE);
}

/** A statement and a question (or two statements) in one message. */
function combo(rng) {
  const first = fill(rng, rng.pick(STATEMENTS));
  const second = fill(rng, rng.pick(rng.chance(0.6) ? QUESTIONS : STATEMENTS));
  return `${first}${rng.pick([',', '.', '!', ' -', ' and', ' but', ' lol'])} ${second}`;
}

/** One message: { text, kind, emoji: false|'start'|'middle'|'end'|'pair'|'only' }. 1–200 characters. */
export function makeMessage(rng, { emojiChance = 0.3 } = {}) {
  const kind = rng.weighted([['reaction', 20], ['question', 16], ['statement', 22], ['combo', 10], ['rant', 14], ['mention', 8], ['hashtag', 4], ['numbers', 6]]);
  let text;
  switch (kind) {
    case 'reaction': text = rng.pick(REACTIONS); break;
    case 'question': text = fill(rng, rng.pick(QUESTIONS)); break;
    case 'statement': text = fill(rng, rng.pick(STATEMENTS)); break;
    case 'combo': text = combo(rng); break;
    case 'rant': text = rant(rng); break;
    case 'mention': {
      const reply = fill(rng, rng.pick(MENTION_REPLIES));
      text = rng.chance(0.8) ? `${makeHandle(rng, { confusable: rng.chance(0.3) })} ${reply}` : `${reply} ${makeHandle(rng)}`;
      break;
    }
    case 'hashtag': {
      const tag = rng.pick(HASHTAGS);
      const statement = fill(rng, rng.pick(STATEMENTS));
      text = rng.chance(0.5) ? `${statement} ${tag}` : `${tag} ${statement}`;
      break;
    }
    default: text = fill(rng, rng.pick(NUMBER_TEMPLATES)); break;
  }

  // Chat typography.
  if (kind !== 'rant' && rng.chance(0.1)) text = stretch(rng, text);
  if (rng.chance(0.25)) text = text.replaceAll("'", RIGHT_QUOTE);
  if (text.includes('"') && rng.chance(0.5)) text = text.replace(/"([^"]*)"/g, `${LEFT_DOUBLE}$1${RIGHT_DOUBLE}`);
  if (kind !== 'rant') {
    const style = rng.weighted([['as-is', 14], ['lower', 3], ['caps', 1.5], ['capital', 3]]);
    if (style === 'lower') text = text.toLowerCase();
    else if (style === 'caps') text = text.toUpperCase();
    else if (style === 'capital') text = capitalize(text);
    const tail = rng.weighted([['', 20], ['!', 2], ['!!!', 1], ['?!', 0.4], ['...', 1], [ELLIPSIS, 0.8], ['emoticon', 2]]);
    if (tail === 'emoticon') text += ` ${rng.pick(EMOTICONS)}`;
    else if (!/[!?.]$/.test(text)) text += tail;
  }

  let emoji = false;
  if (rng.chance(emojiChance)) {
    emoji = rng.weighted([['end', 40], ['start', 15], ['middle', 15], ['pair', 15], ['only', 15]]);
    const gap = () => (rng.chance(0.85) ? ' ' : '');
    switch (emoji) {
      case 'only': {
        const run = emojiRun(rng, rng.int(1, 6));
        text = rng.chance(0.2) ? [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(run)].map((s) => s.segment).join(' ') : run;
        break;
      }
      case 'start': text = emojiRun(rng, rng.int(1, 2)) + gap() + text; break;
      case 'end': text = text + gap() + emojiRun(rng, rng.int(1, 3)); break;
      case 'pair': {
        const pair = pickEmoji(rng) + pickEmoji(rng);
        const parts = words(text);
        if (parts.length > 2 && rng.chance(0.5)) {
          const at = rng.int(1, parts.length - 1);
          text = [...parts.slice(0, at), pair, ...parts.slice(at)].join(' ');
        } else {
          text = `${text} ${pair}`;
        }
        break;
      }
      default: {
        const parts = words(text);
        if (parts.length < 2) {
          text = `${text} ${emojiRun(rng, 1)} ${fill(rng, rng.pick(['so good', 'lol', 'again', 'yes', 'W']))}`;
        } else {
          const at = rng.int(1, parts.length - 1);
          const run = emojiRun(rng, rng.int(1, 2));
          text = rng.chance(0.85)
            ? [...parts.slice(0, at), run, ...parts.slice(at)].join(' ')
            : `${parts.slice(0, at).join(' ')}${run}${parts.slice(at).join(' ')}`;
        }
      }
    }
  }
  text = fitLength(text.replace(/ {2,}/g, ' ').trim(), MAX_MESSAGE);
  return { text, kind, emoji };
}

// ---- Timestamps ---------------------------------------------------------------------------------------------

export const TIMESTAMP_STYLES = ['clock', 'clock-12', 'elapsed', 'elapsed-hours'];

/**
 * `count` consecutive timestamps of one style, as YouTube shows them: 'clock' '2:41 PM' (U+202F before
 * AM/PM), 'clock-12' '12:03 AM', 'elapsed' '31:55' and 'elapsed-hours' '1:02:33' (replay chat).
 */
export function makeTimestamps(rng, style, count = 1) {
  const pad2 = (value) => String(value).padStart(2, '0');
  const times = [];
  if (style === 'clock' || style === 'clock-12') {
    const hour24 = style === 'clock-12' ? rng.pick([0, 12]) : rng.pick([...Array(24).keys()].filter((h) => h % 12 !== 0));
    let minutes = hour24 * 60 + rng.int(0, 59);
    for (let i = 0; i < count; i++) {
      const hour = Math.floor(minutes / 60) % 24;
      times.push(`${hour % 12 || 12}:${pad2(minutes % 60)}${NARROW_NBSP}${hour < 12 ? 'AM' : 'PM'}`);
      minutes += rng.int(0, 1);
    }
  } else {
    let seconds = style === 'elapsed' ? rng.weighted([[rng.int(0, 59), 1], [rng.int(60, 3500), 6]]) : rng.int(3600, 5 * 3600);
    for (let i = 0; i < count; i++) {
      const h = Math.floor(seconds / 3600);
      const m = Math.floor(seconds / 60) % 60;
      const s = seconds % 60;
      times.push(style === 'elapsed' ? `${m}:${pad2(s)}` : `${h}:${pad2(m)}:${pad2(s)}`);
      seconds = Math.min(seconds + rng.int(1, 15), style === 'elapsed' ? 3599 : 9 * 3600);
    }
  }
  return times;
}
