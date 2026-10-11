/**
 * The colour a filament is painted in (spec part-thumbnails §34). The renderer paints colour x lighting, as the
 * slicer's own viewer does, so a black filament came out 0 in every pixel: a silhouette without its faces, layers or
 * holes. A colour darker than OKLab lightness MIN_LIGHTNESS is raised to it, hue and chroma kept -- black becomes a
 * charcoal that still reads as black plastic and shows its shape; a colour already lighter is untouched.
 */

/** sRGB channels, 0..1. */
export type Rgb = [number, number, number];

/** Where black still reads as black plastic and its faces show (measured on real renders, 2026-10-11). */
export const MIN_LIGHTNESS = 0.35;

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c: number) => {
  const v = Math.min(1, Math.max(0, c));
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
};

function toOklab([r, g, b]: Rgb): Rgb {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab([L, a, b]: Rgb): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    toSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/** OKLab lightness of an sRGB colour. */
export function lightness(rgb: Rgb): number {
  return toOklab(rgb)[0];
}

/** The colour the renderer paints: raised to MIN_LIGHTNESS when darker, hue and chroma kept; else as given. */
export function paintColour(rgb: Rgb): Rgb {
  const [L, a, b] = toOklab(rgb);
  return L >= MIN_LIGHTNESS ? rgb : fromOklab([MIN_LIGHTNESS, a, b]);
}
