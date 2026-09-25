import { describe, it, expect } from 'vitest';
import { nextSortBy, splitSortBy } from '../../utils/listSort';

describe('listSort', () => {
  it('splits on the last dash only — keys may contain one', () => {
    expect(splitSortBy('total_price-desc')).toEqual({ key: 'total_price', desc: true });
    expect(splitSortBy('name-asc')).toEqual({ key: 'name', desc: false });
  });
  it('a new key starts at its first direction; the active key flips', () => {
    expect(nextSortBy('name-asc', 'queued', true)).toBe('queued-desc');
    expect(nextSortBy('name-asc', 'due', false)).toBe('due-asc');
    expect(nextSortBy('queued-desc', 'queued', true)).toBe('queued-asc');
    expect(nextSortBy('queued-asc', 'queued', true)).toBe('queued-desc');
  });
});
