import { describe, it, expect } from 'vitest';
import { isOverdue, isPastDueDate } from '../../utils/orderDates';

const localMidnight = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T00:00:00`;
};

describe('isOverdue', () => {
  const now = new Date(2026, 8, 25, 15, 30); // 25 Sep, afternoon
  it('a deadline of today is not overdue yet, yesterday is', () => {
    expect(isOverdue({ status: 'active', due_date: localMidnight(now) }, now)).toBe(false);
    expect(isOverdue({ status: 'active', due_date: localMidnight(new Date(2026, 8, 24)) }, now)).toBe(true);
  });
  it('a closed order or one without a date is never overdue', () => {
    expect(isOverdue({ status: 'completed', due_date: localMidnight(new Date(2026, 0, 1)) }, now)).toBe(false);
    expect(isOverdue({ status: 'active', due_date: null }, now)).toBe(false);
  });
});

describe('isPastDueDate (WS-13 E6 R07)', () => {
  const now = new Date(2026, 8, 25, 15, 30);
  it('asks the calendar day alone — the order’s status is not its question', () => {
    expect(isPastDueDate(localMidnight(new Date(2026, 8, 24)), now)).toBe(true);
    expect(isPastDueDate(localMidnight(now), now)).toBe(false);
    expect(isPastDueDate(null, now)).toBe(false);
  });
  it('reads the server’s naive deadline as a local calendar day, late in the evening too', () => {
    // A day west of UTC would be shifted by reading it as UTC; local parsing keeps it whole.
    const lateEvening = new Date(2026, 8, 25, 23, 59);
    expect(isPastDueDate('2026-09-25T00:00:00', lateEvening)).toBe(false);
    expect(isPastDueDate('2026-09-24T00:00:00', new Date(2026, 8, 25, 0, 1))).toBe(true);
  });
});
