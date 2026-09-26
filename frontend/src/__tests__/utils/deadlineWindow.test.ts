import { describe, it, expect } from 'vitest';
import { dayKeys, windowStart } from '../../utils/deadlineWindow';

const ymd = (d: Date) => [d.getFullYear(), d.getMonth() + 1, d.getDate()];

describe('windowStart', () => {
  it('is the Monday of the week that holds today, moved by whole weeks', () => {
    const wednesday = new Date(2026, 9, 7, 15, 30);
    expect(ymd(windowStart(wednesday, 0))).toEqual([2026, 10, 5]);
    expect(ymd(windowStart(wednesday, -1))).toEqual([2026, 9, 28]);
    expect(ymd(windowStart(wednesday, 2))).toEqual([2026, 10, 19]);
    expect(windowStart(wednesday, 0).getHours()).toBe(0);
  });
  it('a Sunday belongs to the week that began the Monday before', () => {
    expect(ymd(windowStart(new Date(2026, 9, 11, 23), 0))).toEqual([2026, 10, 5]);
    expect(ymd(windowStart(new Date(2026, 9, 5), 0))).toEqual([2026, 10, 5]); // a Monday is its own start
  });
});

describe('dayKeys', () => {
  it('names each local day of the window', () => {
    const keys = dayKeys(new Date(2026, 9, 5), 14);
    expect(keys).toHaveLength(14);
    expect(keys[0]).toBe('2026-10-05');
    expect(keys[13]).toBe('2026-10-18');
  });
  it('crosses a month end and a DST change without skipping or repeating a day', () => {
    const keys = dayKeys(new Date(2026, 9, 19), 14); // 19 Oct … 1 Nov, over the October DST switch
    expect(keys[12]).toBe('2026-10-31');
    expect(keys[13]).toBe('2026-11-01');
    expect(new Set(keys).size).toBe(14);
  });
});
