import type { LinePlan, OrderPlan, PlanRow, WorkingEntry, WorkingPlan } from '../../api/client';
import { rowDistribution, type ChosenByRow, type SplitByRow } from './planMath';

/** The same distribution that drives counts, forecast and addressed publication. */
export function workingEntries(lines: LinePlan[], counts: Record<number, Record<number, number>>,
  chosen: Record<number, ChosenByRow>, split: Record<number, SplitByRow>, known: WorkingEntry[] = [], authoritative = false): WorkingEntry[] {
  const entries = new Map<string, WorkingEntry>();
  const represented = new Set<string>();
  for (const line of lines) for (const row of line.rows) {
    for (const plate of [row, ...row.alternatives]) represented.add(`${line.line_id}-${plate.plate_id}`);
    const edited = counts[line.line_id]?.[row.plate_id] != null || chosen[line.line_id]?.[row.plate_id] != null
      || split[line.line_id]?.[row.plate_id] != null;
    const exact = known.find(e => e.entry_id === row.entry_id && e.line_id === line.line_id && e.plate_id === row.plate_id);
    if (authoritative && !edited && exact) {
      entries.set(exact.entry_id, { ...exact });
      continue;
    }
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
  const result = [...entries.values()].map(entry => {
    const previous = stored.get(entry.entry_id);
    if (!previous || previous.line_id !== entry.line_id || previous.plate_id !== entry.plate_id) return entry;
    return { ...entry, line_token: previous.line_token ?? entry.line_token,
      source_token: previous.source_token ?? entry.source_token };
  });
  // Missing context is not permission to delete an operator's stored entry.
  if (authoritative) for (const entry of known) {
    if (!represented.has(`${entry.line_id}-${entry.plate_id}`) && !result.some(e => e.entry_id === entry.entry_id)) result.push(entry);
  }
  return result;
}

/** Metadata can lag, but it never supplies quantities for a saved draft. */
export function withWorkingEntries(context: OrderPlan | undefined, state: WorkingPlan | undefined): OrderPlan | undefined {
  if (!context || !state || state.revision === 0) return context; // explicit recommendation bootstrap only
  return { ...context, lines: context.lines.map(line => {
    const rows = new Map<number, PlanRow>();
    for (const row of line.rows) {
      rows.set(row.plate_id, row);
      for (const alternative of row.alternatives) if (!rows.has(alternative.plate_id)) {
        rows.set(alternative.plate_id, { ...row, ...alternative, alternatives: [row, ...row.alternatives.filter(a => a.plate_id !== alternative.plate_id)] });
      }
    }
    const entries = state.entries.filter(e => e.line_id === line.line_id);
    const selected = new Set(entries.map(e => e.plate_id));
    return { ...line, rows: entries.flatMap(entry => {
      const metadata = rows.get(entry.plate_id);
      return metadata ? [{ ...metadata, count: entry.count, entry_id: entry.entry_id,
        line_token: entry.line_token, source_token: entry.source_token,
        target_printer_id: entry.target?.kind === 'printer' ? entry.target.printer_id : null,
        manual: entry.manual, protected_count: entry.protected_count,
        alternatives: metadata.alternatives.filter(a => !selected.has(a.plate_id)) }] : [];
    }) };
  }) };
}
