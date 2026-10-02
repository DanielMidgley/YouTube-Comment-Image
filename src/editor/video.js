// Encodes a typing animation to an MP4 (H.264) file in the editor, with WebCodecs through Mediabunny. The
// frames are PNG captures of each typing state, made by the main process exactly like Save/Copy, so every
// frame is the pixel-exact comment; this module only lays them out in time and encodes them.
import {
  BufferTarget, CanvasSource, Mp4OutputFormat, Output, QUALITY_VERY_HIGH,
} from '../../node_modules/mediabunny/dist/bundles/mediabunny.min.mjs';

/**
 * Encodes `frames` (typingFrames(): characters shown in each frame) at `fps`, where `states` maps each of
 * those character counts to its capture ({ png, width, height }). Every frame has the size of the largest
 * capture (the finished comment, rounded up to even numbers for H.264); a shorter, earlier state sits at the
 * top-left on the chat background, so the row grows downwards as the text wraps, like a growing chat row.
 * Resolves to { bytes, width, height, duration }.
 */
export async function encodeTypingVideo({ states, frames, fps, onProgress, signal }) {
  const captures = [...states.values()];
  const width = even(Math.max(...captures.map((c) => c.width)));
  const height = even(Math.max(...captures.map((c) => c.height)));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false });
  const background = await cornerColour(states.get(frames.at(-1)).png); // the row's top-left is padding

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const source = new CanvasSource(canvas, { codec: 'avc', bitrate: QUALITY_VERY_HIGH, keyFrameInterval: 2, latencyMode: 'quality' });
  output.addVideoTrack(source, { frameRate: fps });
  await output.start();
  try {
    let shown = -1;
    for (let i = 0; i < frames.length; i++) {
      signal?.throwIfAborted();
      if (frames[i] !== shown) {
        shown = frames[i];
        const bitmap = await decode(states.get(shown).png);
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
      }
      await source.add(i / fps, 1 / fps);
      onProgress?.(i + 1, frames.length);
    }
    await output.finalize();
  } catch (error) {
    await output.cancel().catch(() => {});
    throw error;
  }
  return { bytes: new Uint8Array(output.target.buffer), width, height, duration: frames.length / fps };
}

const even = (n) => n + (n % 2);

const decode = (png) => createImageBitmap(new Blob([png], { type: 'image/png' }));

async function cornerColour(png) {
  const bitmap = await decode(png);
  const probe = new OffscreenCanvas(1, 1).getContext('2d');
  probe.drawImage(bitmap, 0, 0, 1, 1, 0, 0, 1, 1);
  bitmap.close();
  const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}
