/**
 * The mat a part picture sits on. A render is a transparent PNG drawn in the filament's colour, and no one backdrop
 * reads every colour: on the dark theme's frame a black, navy or red part all but vanishes, on the light theme's a
 * white one does, on a mid grey a grey one does (measured on real renders in five colours, 2026-10-11). So each
 * picture goes on a mat by its own tone -- a dark part on the light mat, a light part on the dark one -- the same
 * two in every theme. A picture with no transparency (a photo) fills its box and keeps the theme's frame.
 */

export type PartMat = 'dark' | 'light';

/** The mats' colours; index.css carries them as `--color-part-mat-*` (a test keeps the two copies equal). */
export const MAT_COLOURS: Record<PartMat, string> = { dark: '#2f2f2f', light: '#c8c8c8' };

/** WCAG relative luminance of one sRGB channel, 0..255. */
function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminanceOf(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 0xff) + 0.7152 * channel((n >> 8) & 0xff) + 0.0722 * channel(n & 0xff);
}

/** The part's tone at which its contrast against both mats is equal: lighter goes on the dark mat. */
export const MAT_CROSSOVER =
  Math.sqrt((luminanceOf(MAT_COLOURS.dark) + 0.05) * (luminanceOf(MAT_COLOURS.light) + 0.05)) - 0.05;

/**
 * The mat for a sample of a picture (RGBA bytes), by the part's tone: the mean luminance of its opaque pixels (alpha
 * >= 128) -- the part, not its half-transparent edge. A thin part can have none (Codex BT-R1, 2026-10-12: a bar
 * about 100 x 1 x 2 mm reduced to 16 px had alpha 98 at most): then the tone is the mean of every visible pixel,
 * weighted by its alpha -- so no thinner part can fall under a fixed threshold. None when nothing is transparent
 * (a photo fills its box) or nothing is visible.
 */
export function matForSample(rgba: ArrayLike<number>): PartMat | null {
  let opaqueSum = 0;
  let opaqueCount = 0;
  let weightedSum = 0;
  let weight = 0;
  let transparent = false;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const alpha = rgba[i + 3];
    if (alpha < 255) transparent = true;
    if (alpha === 0) continue;
    const luminance = 0.2126 * channel(rgba[i]) + 0.7152 * channel(rgba[i + 1]) + 0.0722 * channel(rgba[i + 2]);
    if (alpha >= 128) {
      opaqueSum += luminance;
      opaqueCount += 1;
    }
    weightedSum += luminance * alpha;
    weight += alpha;
  }
  if (!transparent || weight === 0) return null;
  const tone = opaqueCount > 0 ? opaqueSum / opaqueCount : weightedSum / weight;
  return tone > MAT_CROSSOVER ? 'dark' : 'light';
}

/** A picture is sampled at its own size up to this side: the small thumbnail (128 px) is read whole, nothing is
 *  reduced to the point where a thin part loses its pixels, and the cost stays bounded (16 k pixels a load). */
const SAMPLE_MAX_PX = 128;

/**
 * The mat for a loaded picture, read back through a canvas at its own size, at most SAMPLE_MAX_PX a side (the
 * picture is same-origin, so the canvas is not tainted). None when the browser gives no 2D context or refuses the
 * read -- the theme's frame then stays.
 */
export function matForImage(img: HTMLImageElement): PartMat | null {
  try {
    const width = Math.max(1, Math.min(SAMPLE_MAX_PX, img.naturalWidth || SAMPLE_MAX_PX));
    const height = Math.max(1, Math.min(SAMPLE_MAX_PX, img.naturalHeight || SAMPLE_MAX_PX));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(img, 0, 0, width, height);
    return matForSample(context.getImageData(0, 0, width, height).data);
  } catch {
    return null;
  }
}
