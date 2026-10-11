// Seeded pseudo-random numbers for the screenshot corpus. The same seed always plans the same cases, and
// fork(label) derives an independent stream, so what a case contains depends only on the seed and the
// case's own label: not on how many cases are planned, or in which order streams are drawn from.

/** cyrb128: a 128-bit hash of a string, as the four 32-bit words that seed sfc32. */
function cyrb128(text) {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < text.length; i++) {
    const k = text.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

/** sfc32: small and fast, with no bad seeds that matter for test data. */
function sfc32(a, b, c, d) {
  return () => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

/**
 * A random stream seeded by `seed` (any string or number). Every helper draws from the same stream:
 * next() in [0, 1), float(min, max), int(min, max) inclusive, chance(p), pick(items),
 * weighted([[value, weight], ...]), shuffle(items) (a new array), fork(label) (an independent stream).
 */
export function createRng(seed) {
  const seedText = String(seed);
  const next = sfc32(...cyrb128(seedText));
  // Discard the first outputs: sfc32 mixes its state over a few rounds.
  for (let i = 0; i < 12; i++) next();

  const rng = {
    seed: seedText,
    next,
    float: (min, max) => min + next() * (max - min),
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (probability) => next() < probability,
    pick: (items) => items[Math.floor(next() * items.length)],
    weighted(entries) {
      const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
      let point = next() * total;
      for (const [value, weight] of entries) {
        point -= weight;
        if (point < 0) return value;
      }
      return entries[entries.length - 1][0];
    },
    shuffle(items) {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy;
    },
    fork: (label) => createRng(`${seedText}/${label}`),
  };
  return rng;
}
