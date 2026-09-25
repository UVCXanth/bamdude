import { describe, it, expect } from 'vitest';
import { isOverdue } from '../../utils/orderDates';

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
