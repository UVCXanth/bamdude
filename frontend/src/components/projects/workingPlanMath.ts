import type { LinePlan, WorkingEntry } from '../../api/client';
import { rowDistribution, type ChosenByRow, type SplitByRow } from './planMath';

/** The same distribution that drives counts, forecast and addressed publication. */
export function workingEntries(lines: LinePlan[], counts: Record<number, Record<number, number>>,
  chosen: Record<number, ChosenByRow>, split: Record<number, SplitByRow>, known: WorkingEntry[] = []): WorkingEntry[] {
  const entries = new Map<string, WorkingEntry>();
  for (const line of lines) for (const row of line.rows) {
    const edited = counts[line.line_id]?.[row.plate_id] != null || chosen[line.line_id]?.[row.plate_id] != null
      || split[line.line_id]?.[row.plate_id] != null;
    const count = Math.max(0, Math.trunc(counts[line.line_id]?.[row.plate_id] ?? row.count));
    const distribution = rowDistribution(row, count, chosen[line.line_id]?.[row.plate_id], split[line.line_id]?.[row.plate_id]);
    // Explicit zero is an exclusion during remainder planning.
    if (!distribution.length) distribution.push({ plate_id: row.plate_id, count: 0 });
    for (const part of distribution) {
      const same = row.plate_id === part.plate_id;
      const source = same ? row : row.alternatives.find(a => a.plate_id === part.plate_id);
      const key = `${line.line_id}-${part.plate_id}`;
      const entry: WorkingEntry = {
        entry_id: same && row.entry_id ? row.entry_id : `row-${key}`,
        line_id: line.line_id, plate_id: part.plate_id, count: part.count,
        line_token: row.line_token,
        target: row.target_printer_id ? { kind: 'printer', printer_id: row.target_printer_id } : { kind: 'auto' },
        source_token: source?.source_token,
        manual: edited || !!row.manual,
        protected_count: edited ? part.count : row.protected_count ?? 0,
      };
      const previous = entries.get(key);
      if (previous) {
        previous.count += entry.count;
        previous.protected_count += entry.protected_count;
        previous.manual ||= entry.manual;
      } else entries.set(key, entry);
    }
  }
  const stored = new Map(known.map(e => [e.entry_id, e]));
  return [...entries.values()].map(entry => {
    const previous = stored.get(entry.entry_id);
    if (!previous || previous.line_id !== entry.line_id || previous.plate_id !== entry.plate_id) return entry;
    return { ...entry, line_token: entry.line_token ?? previous.line_token,
      source_token: entry.source_token ?? previous.source_token };
  });
}
