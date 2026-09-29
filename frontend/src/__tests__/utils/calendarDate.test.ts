/**
 * A calendar date (an order's deadline) is a DAY, not an instant (WS-13 E3,
 * review 1): read as UTC midnight it shows the previous day west of UTC, where
 * the overdue rule and every list read it as the local day.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { formatCalendarDate } from '../../utils/date';

describe('formatCalendarDate', () => {
  const saved = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'America/New_York';
  });
  afterAll(() => {
    process.env.TZ = saved;
  });

  it('keeps the day of a naive midnight west of UTC', () => {
    expect(formatCalendarDate('2026-09-10T00:00:00', { day: 'numeric' })).toBe('10');
  });

  it('reads a bare date as that day', () => {
    expect(formatCalendarDate('2026-09-10', { day: 'numeric' })).toBe('10');
  });

  it('follows an explicit date format', () => {
    expect(formatCalendarDate('2026-09-10', undefined, 'iso')).toBe('2026-09-10');
  });

  it('writes nothing for no date', () => {
    expect(formatCalendarDate(null)).toBe('');
  });
});
