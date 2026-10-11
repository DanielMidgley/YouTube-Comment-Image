// The transforms that turn the app's exact export into the screenshots people actually share: a snip of a
// few rows whose edges cut through the first or last one, a snip that starts inside the avatar, a loose snip
// with extra chat background around it, a rescaled copy and JPEG compression. Each moves the comment
// geometry exactly as it moves the pixels.
import { crop, pad } from './bitmap.js';
import { mapBoxes, shift, stretch } from './geometry.js';

/**
 * Applies plan.transform to the rendered `bitmap` and the `geometries` of its rows (device px of that
 * bitmap), in the order a screenshot goes through them: snip (stack cuts, avatar cut, padding), rescale,
 * then JPEG (only recorded here; the caller encodes). `resize(bitmap, width, height)` does the resampling.
 * Returns { bitmap, geometries, transform, resampleX }; `transform` is what the manifest records, in device
 * px of the render: stack.cutTop/cutBottom rows removed, avatarCut columns removed from the left.
 */
export function applyTransforms(bitmap, geometries, plan, { background, resize }) {
  const planned = plan.transform;
  const transform = { jpegQuality: planned.jpegQuality ?? null, pad: null, resample: null, stack: null, avatarCut: null };
  let image = bitmap;
  let boxes = geometries;
  const move = (fn) => { boxes = boxes.map((geometry) => mapBoxes(geometry, fn)); };

  if (planned.stack) {
    // Cut fractions of the first and last rows' heights, on whole device pixels.
    const first = boxes[0].row;
    const last = boxes.at(-1).row;
    const top = planned.stack.cutTop ? Math.round(first.y + first.height * planned.stack.cutTop) : 0;
    const bottom = planned.stack.cutBottom ? Math.round(last.y + last.height * (1 - planned.stack.cutBottom)) : image.height;
    transform.stack = { count: geometries.length, cutTop: top, cutBottom: image.height - bottom };
    image = crop(image, { x: 0, y: top, width: image.width, height: bottom - top });
    move(shift(0, -top));
  }

  if (planned.avatarCut != null) {
    // Every row's avatar sits at the same x; the snip starts that fraction of the way across it.
    const avatar = boxes.find((geometry) => geometry.avatar)?.avatar;
    if (!avatar) throw new Error(`${plan.id}: an avatar cut needs a visible avatar.`);
    const left = Math.round(avatar.x + avatar.width * planned.avatarCut);
    transform.avatarCut = left;
    image = crop(image, { x: left, y: 0, width: image.width - left, height: image.height });
    move(shift(-left, 0));
  }

  if (planned.pad) {
    transform.pad = { ...planned.pad };
    image = pad(image, planned.pad, background);
    move(shift(planned.pad.left, planned.pad.top));
  }

  let resampleX = 1;
  if (planned.resample) {
    const width = Math.round(image.width * planned.resample);
    const height = Math.round(image.height * planned.resample);
    resampleX = width / image.width;
    move(stretch(resampleX, height / image.height));
    image = resize(image, width, height);
    if (image.width !== width || image.height !== height) {
      throw new Error(`${plan.id}: resampling gave ${image.width}×${image.height} px instead of ${width}×${height}.`);
    }
    transform.resample = planned.resample;
  }

  return { bitmap: image, geometries: boxes, transform, resampleX };
}
