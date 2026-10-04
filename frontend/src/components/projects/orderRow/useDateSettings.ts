import type { DateFormat, TimeFormat } from '../../../utils/date';
import { formatCalendarDate, formatDateOnly } from '../../../utils/date';
import { useUiPreferences } from '../../../hooks/useUiPreferences';

/** The user's date and time format — the same `['settings']` read every page shares. */
export function useDateSettings(): { dateFormat: DateFormat; timeFormat: TimeFormat } {
  const { data } = useUiPreferences();
  return { dateFormat: data?.date_format ?? 'system', timeFormat: data?.time_format ?? 'system' };
}

/** A deadline — a calendar DAY, never an instant (`formatCalendarDate`): «28 вер». */
export function dueLabel(due: string | null | undefined, dateFormat: DateFormat = 'system'): string {
  return formatCalendarDate(due, { day: 'numeric', month: 'short' }, dateFormat);
}

/** A forecast instant as the user's local day, the way the order page's tile shows it. */
export function etaLabel(iso: string, dateFormat: DateFormat = 'system'): string {
  return formatDateOnly(iso, { day: 'numeric', month: 'short' }, dateFormat);
}
