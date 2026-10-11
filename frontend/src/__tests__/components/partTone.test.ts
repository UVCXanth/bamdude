/**
 * The mat a part picture sits on (thumbnail backdrop, 2026-10-11): renders are transparent PNGs, and no one
 * backdrop reads every filament colour -- on the dark theme's frame a black, navy or red part all but vanishes,
 * on the light one a white part does, on a mid grey a grey part does (measured on real renders,
 * research-artifacts/part-thumb-backdrop-2026-10-11). So each picture is put on a mat by its own tone.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAT_COLOURS, MAT_CROSSOVER, matForImage, matForSample } from '../../components/partTone';

type Pixel = [number, number, number, number];
const clear: Pixel = [0, 0, 0, 0];
const sample = (...pixels: Pixel[]) => new Uint8ClampedArray(pixels.flat());

describe('a part picture’s mat', () => {
  it('puts a dark part on the light mat — the tones of the measured black, navy, red and grey renders', () => {
    expect(matForSample(sample([0, 0, 0, 255], clear))).toBe('light'); // black: flat 0
    expect(matForSample(sample([31, 42, 68, 255], clear))).toBe('light'); // navy
    expect(matForSample(sample([200, 16, 46, 255], clear))).toBe('light'); // red
    expect(matForSample(sample([100, 100, 100, 255], clear))).toBe('light'); // grey filament, shaded (~0.13)
  });

  it('puts a light part on the dark mat', () => {
    expect(matForSample(sample([200, 200, 200, 255], clear))).toBe('dark'); // white filament, shaded (~0.59)
    expect(matForSample(sample([255, 255, 255, 255], clear))).toBe('dark');
  });

  it('leaves a picture with no transparency alone: a photo fills its box', () => {
    expect(matForSample(sample([0, 0, 0, 255], [255, 255, 255, 255]))).toBeNull();
  });

  it('leaves a picture with nothing opaque alone', () => {
    expect(matForSample(sample(clear, clear))).toBeNull();
  });

  it('counts the part only: a half-transparent edge is no part pixel', () => {
    expect(matForSample(sample([0, 0, 0, 255], [255, 255, 255, 100], clear))).toBe('light');
  });

  it('crosses over where a part’s contrast against both mats is equal', () => {
    expect(MAT_CROSSOVER).toBeCloseTo(0.172, 3);
  });

  it('draws the mats in the colours it measures them by', () => {
    // index.css carries the classes' colours; the crossover is computed from MAT_COLOURS -- one pair, two copies
    const css = readFileSync(join(process.cwd(), 'src', 'index.css'), 'utf8');
    expect(css).toContain(`--color-part-mat-dark: ${MAT_COLOURS.dark};`);
    expect(css).toContain(`--color-part-mat-light: ${MAT_COLOURS.light};`);
  });
});

// Codex BT-R1 (2026-10-12): a thin part -- a white bar about 100 x 1 x 2 mm, rendered by the production renderer --
// has no pixel left at alpha >= 128 once its picture is reduced to 16 x 16, so the old sample named no mat at all.
// The fixtures are that bar's production small picture (128 px), in white and in black.

/** An 8-bit RGBA, non-interlaced PNG (what the renderer and part_render_fallback.small write) as pixels. */
function decodePng(png: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0, height = 0;
  const idat: Uint8Array[] = [];
  for (let at = 8; at < png.length; ) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const data = png.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      expect([data[8], data[9], data[12]]).toEqual([8, 6, 0]); // 8-bit, RGBA, not interlaced
    }
    if (type === 'IDAT') idat.push(data);
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const rgba = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= 4 ? rgba[y * stride + x - 4] : 0;
      const b = y > 0 ? rgba[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? rgba[(y - 1) * stride + x - 4] : 0;
      const paeth = () => {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      };
      const predictor = [0, a, b, (a + b) >> 1, filter === 4 ? paeth() : 0][filter];
      rgba[y * stride + x] = (v + predictor) & 0xff;
    }
  }
  return { width, height, rgba };
}

/** Area reduction to side x side, averaged in premultiplied space and read back unpremultiplied -- what a canvas
 *  `drawImage` reduction and `getImageData` hand the page. */
function reduce({ width, height, rgba }: { width: number; height: number; rgba: Uint8Array }, side: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(side * side * 4);
  for (let oy = 0; oy < side; oy++) {
    for (let ox = 0; ox < side; ox++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let y = Math.floor((oy * height) / side); y < Math.floor(((oy + 1) * height) / side); y++) {
        for (let x = Math.floor((ox * width) / side); x < Math.floor(((ox + 1) * width) / side); x++) {
          const i = (y * width + x) * 4, alpha = rgba[i + 3];
          r += rgba[i] * alpha; g += rgba[i + 1] * alpha; b += rgba[i + 2] * alpha; a += alpha; n += 1;
        }
      }
      const o = (oy * side + ox) * 4;
      out.set(a ? [r / a, g / a, b / a, a / n] : [0, 0, 0, 0], o);
    }
  }
  return out;
}

const fixture = (name: string) =>
  decodePng(new Uint8Array(readFileSync(join(process.cwd(), 'src', '__tests__', 'fixtures', 'part-tone', name))));

describe('a thin part’s mat (Codex BT-R1)', () => {
  it('reduced to 16 px the bar keeps no opaque pixel -- the case the old sample lost', () => {
    const reduced = reduce(fixture('thin-bar-white-sm.png'), 16);
    const alphas = Array.from({ length: reduced.length / 4 }, (_, i) => reduced[i * 4 + 3]);
    expect(Math.max(...alphas)).toBeLessThan(128);
    expect(Math.max(...alphas)).toBeGreaterThan(0);
  });

  it('still names the mat from the visible pixels when none is opaque: white on dark, black on light', () => {
    expect(matForSample(reduce(fixture('thin-bar-white-sm.png'), 16))).toBe('dark');
    expect(matForSample(reduce(fixture('thin-bar-black-sm.png'), 16))).toBe('light');
  });

  it('names the same mat from the picture at its own size', () => {
    const white = fixture('thin-bar-white-sm.png');
    const black = fixture('thin-bar-black-sm.png');
    expect(matForSample(reduce(white, white.width))).toBe('dark');
    expect(matForSample(reduce(black, black.width))).toBe('light');
  });

  it('an alpha-weighted visible pixel decides only when nothing is opaque', () => {
    // a faint white fringe beside a black part: the opaque part decides, as before
    expect(matForSample(sample([0, 0, 0, 255], [255, 255, 255, 60], clear))).toBe('light');
    // nothing opaque: the visible pixels decide, weighted by how visible they are
    expect(matForSample(sample([255, 255, 255, 90], [0, 0, 0, 10], clear))).toBe('dark');
    expect(matForSample(sample([0, 0, 0, 90], [255, 255, 255, 10], clear))).toBe('light');
  });
});

describe('the sample of a loaded picture (Codex BT-R1)', () => {
  function sampledAt(naturalWidth: number, naturalHeight: number) {
    const draws: number[][] = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: (_img: unknown, ...box: number[]) => draws.push(box),
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    } as never);
    const img = document.createElement('img');
    Object.defineProperty(img, 'naturalWidth', { value: naturalWidth });
    Object.defineProperty(img, 'naturalHeight', { value: naturalHeight });
    matForImage(img);
    return draws[0];
  }

  afterEach(() => vi.restoreAllMocks());

  it('reads a small picture at its own size, a larger one at 128 px at most', () => {
    expect(sampledAt(128, 128)).toEqual([0, 0, 128, 128]);
    expect(sampledAt(64, 64)).toEqual([0, 0, 64, 64]);
    expect(sampledAt(512, 512)).toEqual([0, 0, 128, 128]);
  });
});
