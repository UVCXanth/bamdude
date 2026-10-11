/**
 * The mat a part picture sits on (thumbnail backdrop, 2026-10-11): renders are transparent PNGs, and no one
 * backdrop reads every filament colour -- on the dark theme's frame a black, navy or red part all but vanishes,
 * on the light one a white part does, on a mid grey a grey part does (measured on real renders,
 * research-artifacts/part-thumb-backdrop-2026-10-11). So each picture is put on a mat by its own tone.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAT_COLOURS, MAT_CROSSOVER, matForSample } from '../../components/partTone';

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
