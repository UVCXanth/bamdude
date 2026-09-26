import { localDateKey } from './date';

/** Monday of the week that holds `today`, moved by whole weeks — local dates (spec workshop-order-views, rule 17). */
export function windowStart(today: Date, weekOffset: number): Date {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7) + weekOffset * 7);
  return start;
}

/** `YYYY-MM-DD` of each local day of the window — built by calendar day, so a DST change neither skips nor repeats one. */
export function dayKeys(start: Date, days: number): string[] {
  return Array.from({ length: days }, (_, i) =>
    localDateKey(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)),
  );
}
