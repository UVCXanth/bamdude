/**
 * The one «overdue» rule (spec workshop-lists, rule 11): an ACTIVE order whose
 * due date is before the start of today. A deadline of today is not missed
 * yet, and a closed order's date is history. The server's orders tile counts
 * the same rule on its own clock, so the tile equals the red dates.
 */
/**
 * Whether a calendar deadline lies before the start of today — the day alone, whatever
 * the order's status (WS-13 E6 R07): a copy of a closed order becomes ACTIVE with the
 * original's deadline, so the duplicate dialog asks the date, not the status. The same
 * day boundary as `isOverdue`; the naive server date is read as a local day.
 */
export function isPastDueDate(due: string | null | undefined, now: Date = new Date()): boolean {
  if (!due) return false;
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  return new Date(due) < startOfToday;
}

export function isOverdue(order: { status: string; due_date?: string | null }, now: Date = new Date()): boolean {
  if (order.status !== 'active' || !order.due_date) return false;
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  return new Date(order.due_date) < startOfToday;
}
