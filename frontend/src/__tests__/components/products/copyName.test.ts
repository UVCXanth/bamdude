import { describe, it, expect } from 'vitest';
import { copyName } from '../../../components/products/productActions/copyName';

const points = (s: string) => Array.from(s).length;

// WS-13 E8 F03 (R02): one generator of a copy's name — the whole suffix, the base cut by
// Unicode code points so the name fits the column (255), never a broken surrogate pair.
describe('copyName', () => {
  it('appends the localized suffix to a short name', () => {
    expect(copyName('Gear', ' (copy)')).toBe('Gear (copy)');
    expect(copyName('Шестерня', ' (копія)')).toBe('Шестерня (копія)');
  });

  it('keeps a name that just fits, and cuts the base of one that does not', () => {
    expect(copyName('a'.repeat(248), ' (copy)')).toBe(`${'a'.repeat(248)} (copy)`);
    expect(copyName('a'.repeat(249), ' (copy)')).toBe(`${'a'.repeat(248)} (copy)`);
    const long = copyName('я'.repeat(255), ' (копія)');
    expect(points(long)).toBe(255);
    expect(long.endsWith(' (копія)')).toBe(true);
  });

  it('counts code points: a character outside the BMP is one, and is never split', () => {
    const out = copyName('😀'.repeat(250), ' (copy)');
    expect(points(out)).toBe(255);
    expect(out).toBe(`${'😀'.repeat(248)} (copy)`);
    // A lone high surrogate would be a broken character at the cut.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
  });

  it('a copy of a long copy still fits and still ends with the whole suffix', () => {
    const first = copyName('b'.repeat(255), ' (copy)');
    const second = copyName(first, ' (copy)');
    expect(points(second)).toBeLessThanOrEqual(255);
    expect(second.endsWith(' (copy)')).toBe(true);
  });

  it('drops the space a cut leaves at the end of the base', () => {
    const out = copyName(`${'c'.repeat(247)} tail`, ' (copy)');
    expect(out).toBe(`${'c'.repeat(247)} (copy)`);
  });

  it('takes another limit when asked', () => {
    expect(copyName('abcdef', ' (c)', 8)).toBe('abcd (c)');
  });
});
