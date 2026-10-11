/**
 * The colour the part renderer paints a filament in (spec part-thumbnails §34): colour x lighting left black flat 0 in
 * every pixel -- a silhouette without its faces -- so a colour darker than OKLab lightness MIN_LIGHTNESS is raised to
 * it, hue and chroma kept. A lighter colour is untouched, the probe fixtures' too (their golden hashes hold).
 */
import { describe, expect, it } from 'vitest';
import { lightness, MIN_LIGHTNESS, paintColour, type Rgb } from '../../part-render/colour';

const hex = (h: string): Rgb => {
  const n = Number.parseInt(h.slice(1), 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
};

describe('the colour a filament is painted in', () => {
  it('raises black to a neutral charcoal at the floor', () => {
    const [r, g, b] = paintColour([0, 0, 0]);
    expect(lightness([r, g, b])).toBeCloseTo(MIN_LIGHTNESS, 6);
    expect(Math.abs(r - g)).toBeLessThan(1e-6);
    expect(Math.abs(g - b)).toBeLessThan(1e-6);
    expect(Math.round(r * 255)).toBe(58); // #3a3a3a
  });

  it('raises a dark colour keeping its hue', () => {
    const navy = hex('#1F2A44');
    const painted = paintColour(navy);
    expect(lightness(painted)).toBeCloseTo(MIN_LIGHTNESS, 6);
    const [, a0, b0] = oklab(navy);
    const [, a1, b1] = oklab(painted);
    expect(Math.atan2(b1, a1)).toBeCloseTo(Math.atan2(b0, a0), 4);
    expect(painted.every((c) => c >= 0 && c <= 1)).toBe(true);
  });

  it('leaves a colour at or above the floor as it is -- the probe fixtures’ silver and green too', () => {
    for (const h of ['#C8102E', '#FFFFFF', '#808080', '#C0C0C0', '#00AE42']) {
      expect(paintColour(hex(h))).toEqual(hex(h));
    }
  });

  it('puts the floor where black still reads as black plastic', () => {
    expect(MIN_LIGHTNESS).toBe(0.35);
  });
});

/** The same OKLab the module uses, for the hue check. */
function oklab(rgb: Rgb): [number, number, number] {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = rgb.map(lin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
