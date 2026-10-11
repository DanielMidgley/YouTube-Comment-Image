// Photo-like avatar pictures for the corpus, so readers meet more than YouTube's letter avatars: a head and
// shoulders, a landscape, gradients, soft blobs and flat logos. Pure JS, returning BGRA bytes (what
// nativeImage.createFromBitmap takes on Windows). Each is drawn at 4× and box-filtered down, so edges are
// soft like a downscaled photo, with a little noise like a compressed one.

export const AVATAR_STYLES = ['portrait', 'landscape', 'gradient', 'blobs', 'logo'];

const SUPERSAMPLE = 4;
const SKIN = [[241, 194, 167], [224, 172, 138], [198, 134, 99], [161, 102, 70], [120, 76, 52], [92, 58, 40]];
const HAIR = [[30, 24, 20], [70, 45, 28], [140, 92, 50], [215, 180, 120], [180, 70, 40], [90, 90, 95]];

const clamp01 = (value) => Math.min(1, Math.max(0, value));
const mix = (a, b, t) => [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t);
const smoothstep = (edge0, edge1, x) => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

function randomColor(rng, { min = 20, max = 235 } = {}) {
  return [rng.int(min, max), rng.int(min, max), rng.int(min, max)];
}

/** Coverage of a disc at (u, v): 1 inside, 0 outside, a soft edge `soft` wide. */
const disc = (u, v, cx, cy, r, soft = 0.01) => 1 - smoothstep(r - soft, r + soft, Math.hypot(u - cx, v - cy));

/** Builds the (u, v) → [r, g, b] function of one style from random parameters. */
function painter(rng, style) {
  switch (style) {
    case 'portrait': {
      const top = randomColor(rng, { min: 60, max: 220 });
      const bottom = mix(top, randomColor(rng), 0.5);
      const skin = rng.pick(SKIN);
      const hair = rng.pick(HAIR);
      const shirt = randomColor(rng);
      const cx = 0.5 + rng.float(-0.06, 0.06);
      const cy = rng.float(0.36, 0.44);
      const r = rng.float(0.17, 0.23);
      return (u, v) => {
        let color = mix(top, bottom, v);
        const shoulders = 1 - smoothstep(0.98, 1.02, Math.hypot((u - cx) / 0.42, (v - 1.08) / 0.4));
        color = mix(color, shirt, shoulders);
        const cap = disc(u, v, cx, cy - r * 0.12, r * 1.08) * smoothstep(cy + r * 0.1, cy - r * 0.3, v);
        color = mix(color, hair, cap);
        return mix(color, skin, disc(u, v, cx, cy, r) * (1 - cap * 0.9));
      };
    }
    case 'landscape': {
      const sky = randomColor(rng, { min: 90, max: 240 });
      const horizon = mix(sky, [250, 200, 150], rng.float(0.2, 0.7));
      const ground = randomColor(rng, { min: 20, max: 140 });
      const sun = [255, rng.int(200, 250), rng.int(120, 220)];
      const level = rng.float(0.55, 0.72);
      const wave = rng.float(0.02, 0.08);
      const sx = rng.float(0.25, 0.75);
      const sy = rng.float(0.2, 0.45);
      return (u, v) => {
        let color = mix(sky, horizon, clamp01(v / level));
        color = mix(color, sun, disc(u, v, sx, sy, 0.1, 0.02));
        const line = level + wave * Math.sin(u * 7 + sx * 10);
        return mix(color, mix(ground, [0, 0, 0], clamp01((v - line) * 1.5)), smoothstep(line - 0.01, line + 0.01, v));
      };
    }
    case 'gradient': {
      const a = randomColor(rng);
      const b = randomColor(rng);
      const angle = rng.float(0, Math.PI * 2);
      const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
      return (u, v) => mix(a, b, clamp01(0.5 + (u - 0.5) * cos + (v - 0.5) * sin));
    }
    case 'blobs': {
      const base = randomColor(rng);
      const blobs = Array.from({ length: rng.int(3, 6) }, () => ({
        x: rng.next(), y: rng.next(), r: rng.float(0.12, 0.35), color: randomColor(rng),
      }));
      return (u, v) => blobs.reduce((color, blob) => mix(color, blob.color, disc(u, v, blob.x, blob.y, blob.r, blob.r * 0.6)), base);
    }
    default: { // logo: a flat shape on a flat background
      const background = randomColor(rng);
      const foreground = background.map((c) => (c > 128 ? rng.int(0, 60) : rng.int(195, 255)));
      const shape = rng.pick(['ring', 'triangle', 'diamond', 'bars']);
      return (u, v) => {
        let cover;
        if (shape === 'ring') cover = disc(u, v, 0.5, 0.5, 0.32) - disc(u, v, 0.5, 0.5, 0.18);
        else if (shape === 'triangle') cover = v > 0.25 && v < 0.75 && Math.abs(u - 0.5) < (v - 0.25) * 0.6 ? 1 : 0;
        else if (shape === 'diamond') cover = Math.abs(u - 0.5) + Math.abs(v - 0.5) < 0.3 ? 1 : 0;
        else cover = u > 0.25 && u < 0.75 && Math.floor(v * 7) % 2 === 1 && v > 0.2 && v < 0.8 ? 1 : 0;
        return mix(background, foreground, cover);
      };
    }
  }
}

/** Deterministic per-pixel noise in [-1, 1]. */
function noise(x, y, seed) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (((h ^ (h >>> 16)) >>> 0) / 4294967295) * 2 - 1;
}

/** A size×size opaque avatar picture: { style, bgra }. */
export function makeImageAvatar(rng, size, style = rng.pick(AVATAR_STYLES)) {
  const paint = painter(rng, style);
  const amplitude = style === 'logo' ? 2 : rng.float(3, 10);
  const seed = rng.int(0, 0x7fffffff);
  const big = size * SUPERSAMPLE;
  const bgra = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sum = [0, 0, 0];
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const px = x * SUPERSAMPLE + sx;
          const py = y * SUPERSAMPLE + sy;
          const color = paint((px + 0.5) / big, (py + 0.5) / big);
          const grain = noise(px, py, seed) * amplitude;
          for (let i = 0; i < 3; i++) sum[i] += color[i] + grain;
        }
      }
      const n = SUPERSAMPLE * SUPERSAMPLE;
      const at = (y * size + x) * 4;
      const [r, g, b] = sum.map((total) => Math.round(Math.min(255, Math.max(0, total / n))));
      bgra[at] = b;
      bgra[at + 1] = g;
      bgra[at + 2] = r;
      bgra[at + 3] = 255;
    }
  }
  return { style, bgra };
}
