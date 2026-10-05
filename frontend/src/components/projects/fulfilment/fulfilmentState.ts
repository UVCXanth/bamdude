import type {
  FulfilmentLineBody,
  FulfilmentLineState,
  FulfilmentPartState,
  FulfilmentState,
} from '../../../api/client';

/**
 * The issue dialog's draft (spec workshop-order-issue, rule 27) — pure, so the
 * arithmetic the dialog shows is tested apart from it. The server checks every
 * number again against the same `state` under its locks; these functions only
 * keep the form from asking for what the state already says is impossible.
 *
 * Per line the order is assemble → receive → write off → issue (spec
 * workshop-order-issue-followups, rule 46): what is written off is no longer there
 * to issue. An order without a customer issues nothing — it closes to stock
 * (followups, rules 35–39).
 */

/** `all` fills everything; `receive` («Оприбуткувати…») issues nothing. */
export type FulfilmentMode = 'all' | 'receive';

export interface PartDraft {
  receive: number;
  writeOff: number;
  issue: number;
}

export interface LineDraft {
  assemble: number;
  receive: number;
  writeOff: number;
  issue: number;
  parts: Record<number, PartDraft>;
}

/** `line_id → draft`. */
export type Draft = Record<number, LineDraft>;

/** What a product line can hand over in this batch: what lies on the shelf plus
 *  what this batch assembles and receives, less what it writes off. */
export function issueCeiling(line: FulfilmentLineState, draft: LineDraft): number {
  return line.held + draft.assemble + draft.receive - draft.writeOff;
}

/** A new write-off for a product line. An issue that followed its ceiling follows it back
 *  when a write-off is taken back; one the operator chose stays (final review M10). */
export function withLineWriteOff(line: FulfilmentLineState, d: LineDraft, writeOff: number): LineDraft {
  const atCeiling = d.issue === issueCeiling(line, d);
  return { ...d, writeOff, issue: atCeiling ? d.issue + d.writeOff - writeOff : d.issue };
}

/** The same for one part of a parts line. */
export function withPartWriteOff(part: FulfilmentPartState, p: PartDraft, writeOff: number): PartDraft {
  const atCeiling = p.issue === part.held + p.receive - p.writeOff;
  return { ...p, writeOff, issue: atCeiling ? p.issue + p.writeOff - writeOff : p.issue };
}

/** Every write-off taken back — the column closed, so nothing hidden is written off (final
 *  review I2). */
export function withoutWriteOffs(state: FulfilmentState, draft: Draft): Draft {
  const out: Draft = { ...draft };
  for (const line of state.lines) {
    const d = draft[line.line_id];
    if (!d) continue;
    const parts: Record<number, PartDraft> = { ...d.parts };
    for (const part of line.parts) {
      const p = d.parts[part.part_id];
      if (p) parts[part.part_id] = withPartWriteOff(part, p, 0);
    }
    out[line.line_id] = { ...withLineWriteOff(line, d, 0), parts };
  }
  return out;
}

/**
 * Nothing typed: a caller without the stock's move may not receive, issue or write off — it only
 * completes an order whose goods are already out, a consequence of the order's own right (WS-13
 * E13 O23).
 */
export function emptyDraft(state: FulfilmentState): Draft {
  const out: Draft = {};
  for (const line of state.lines) {
    const parts: Record<number, PartDraft> = {};
    for (const part of line.parts) parts[part.part_id] = { receive: 0, writeOff: 0, issue: 0 };
    out[line.line_id] = { assemble: 0, receive: 0, writeOff: 0, issue: 0, parts };
  }
  return out;
}

export function draftFrom(state: FulfilmentState, mode: FulfilmentMode): Draft {
  const issuing = mode === 'all' && !state.closes_to_stock;
  const out: Draft = {};
  for (const line of state.lines) {
    const parts: Record<number, PartDraft> = {};
    for (const part of line.parts) {
      parts[part.part_id] = {
        receive: part.can_receive,
        writeOff: 0,
        issue: issuing ? part.held + part.can_receive : 0,
      };
    }
    const assemble = line.can_assemble;
    const receive = line.can_receive;
    out[line.line_id] = {
      assemble,
      receive,
      writeOff: 0,
      issue: issuing ? line.held + assemble + receive : 0,
      parts,
    };
  }
  return out;
}

function clamp(n: number, max: number): number {
  return Math.max(0, Math.min(Number.isFinite(n) ? Math.floor(n) : 0, max));
}

/** Every number between 0 and what the state allows; a write-off never above what is on
 *  the shelf after this batch, an issue never above what is left of it. */
export function clampDraft(draft: Draft, state: FulfilmentState): Draft {
  const out: Draft = {};
  for (const line of state.lines) {
    // A line the draft never had (the state was read again) starts at nothing.
    const d = draft[line.line_id] ?? { assemble: 0, receive: 0, writeOff: 0, issue: 0, parts: {} };
    const assemble = clamp(d.assemble, line.can_assemble);
    const receive = clamp(d.receive, line.can_receive);
    const writeOff = clamp(d.writeOff ?? 0, line.held + assemble + receive);
    const issueMax = state.closes_to_stock ? 0 : line.held + assemble + receive - writeOff;
    const parts: Record<number, PartDraft> = {};
    for (const part of line.parts) {
      const p = d.parts[part.part_id] ?? { receive: 0, writeOff: 0, issue: 0 };
      const partReceive = clamp(p.receive, part.can_receive);
      const partWriteOff = clamp(p.writeOff ?? 0, part.held + partReceive);
      parts[part.part_id] = {
        receive: partReceive,
        writeOff: partWriteOff,
        issue: clamp(p.issue, state.closes_to_stock ? 0 : part.held + partReceive - partWriteOff),
      };
    }
    out[line.line_id] = { assemble, receive, writeOff, issue: clamp(d.issue, issueMax), parts };
  }
  return out;
}

/**
 * The STORED draft brought inside a new state (WS-13 E6 E13, R04): a record, not a view —
 * so a bound that grows back does not return the units it took; only the operator does.
 * `changed` says whether any number the operator had was cut (a line the draft never had
 * starts at nothing and is not a change).
 */
export function clampStored(draft: Draft, state: FulfilmentState): { draft: Draft; changed: boolean } {
  const next = clampDraft(draft, state);
  let changed = false;
  for (const [id, before] of Object.entries(draft)) {
    const after = next[Number(id)];
    if (!after) continue;
    if (after.assemble !== before.assemble || after.receive !== before.receive || after.writeOff !== before.writeOff || after.issue !== before.issue) {
      changed = true;
    }
    for (const [partId, p] of Object.entries(before.parts)) {
      const q = after.parts[Number(partId)];
      if (q && (q.receive !== p.receive || q.writeOff !== p.writeOff || q.issue !== p.issue)) changed = true;
    }
  }
  return { draft: next, changed };
}

/** The two columns a parts line's «all N parts» drives (E6 E06). */
export type PartsColumn = 'receive' | 'issue';

function partMax(part: FulfilmentPartState, p: PartDraft, column: PartsColumn): number {
  return column === 'receive' ? part.can_receive : part.held + p.receive - p.writeOff;
}

/** N of «all N parts»: the sum of what each part of the line can take in that column now. */
export function partsColumnTotal(line: FulfilmentLineState, d: LineDraft, column: PartsColumn): number {
  return line.parts.reduce((sum, part) => sum + partMax(part, d.parts[part.part_id] ?? { receive: 0, writeOff: 0, issue: 0 }, column), 0);
}

/** Whether every part is at its bound (`all`), none moves (`none`), or some do (`mixed`). */
export function partsColumnState(line: FulfilmentLineState, d: LineDraft, column: PartsColumn): 'all' | 'none' | 'mixed' {
  let full = true;
  let empty = true;
  for (const part of line.parts) {
    const p = d.parts[part.part_id] ?? { receive: 0, writeOff: 0, issue: 0 };
    const max = partMax(part, p, column);
    if (p[column] !== max) full = false;
    if (p[column] !== 0) empty = false;
  }
  return full ? 'all' : empty ? 'none' : 'mixed';
}

/** Every part of the line to its bound (`on`) or to nothing — the checkbox of E06. */
export function setAllParts(line: FulfilmentLineState, d: LineDraft, column: PartsColumn, on: boolean): LineDraft {
  const parts: Record<number, PartDraft> = { ...d.parts };
  for (const part of line.parts) {
    const p = parts[part.part_id] ?? { receive: 0, writeOff: 0, issue: 0 };
    parts[part.part_id] = { ...p, [column]: on ? partMax(part, p, column) : 0 };
  }
  return { ...d, parts };
}

/** What the batch does, per operation — the footer's summary (E6 E12). Units: a parts line counts parts. */
export function batchTotals(draft: Draft): { assemble: number; receive: number; writeOff: number; issue: number } {
  let assemble = 0;
  let receive = 0;
  for (const d of Object.values(draft)) {
    assemble += d.assemble;
    receive += d.receive;
    for (const p of Object.values(d.parts)) receive += p.receive;
  }
  return { assemble, receive, writeOff: writingOff(draft), issue: issuingUnits(draft) };
}

/** «X of Y» after this batch (E6 E09): issued so far plus what this batch issues — or, closing
 *  to stock, what is issued or on the shelf after it. Off the VISIBLE draft. */
export function doneAfter(state: FulfilmentState, draft: Draft): number {
  const t = batchTotals(draft);
  if (state.closes_to_stock) return state.issued + state.held + t.assemble + t.receive - t.writeOff;
  return state.issued + t.issue;
}

/** The request's lines — only what is not zero; a parts line names its parts. */
export function requestFrom(draft: Draft): FulfilmentLineBody[] {
  const out: FulfilmentLineBody[] = [];
  for (const [id, d] of Object.entries(draft)) {
    const lineId = Number(id);
    const parts = Object.entries(d.parts)
      .filter(([, p]) => p.receive > 0 || p.issue > 0 || p.writeOff > 0)
      .map(([partId, p]) => ({
        part_id: Number(partId),
        receive: p.receive,
        issue: p.issue,
        ...(p.writeOff > 0 ? { write_off: p.writeOff } : {}),
      }));
    if (parts.length > 0) {
      out.push({ line_id: lineId, parts });
    } else if (d.assemble > 0 || d.receive > 0 || d.issue > 0 || d.writeOff > 0) {
      out.push({
        line_id: lineId,
        assemble: d.assemble,
        receive: d.receive,
        issue: d.issue,
        ...(d.writeOff > 0 ? { write_off: d.writeOff } : {}),
      });
    }
  }
  return out;
}

/** Units (a parts line: parts) this batch hands over. */
export function issuingUnits(draft: Draft): number {
  let total = 0;
  for (const d of Object.values(draft)) {
    total += d.issue;
    for (const p of Object.values(d.parts)) total += p.issue;
  }
  return total;
}

/** Units (a parts line: parts) this batch writes off — a note is then required. */
export function writingOff(draft: Draft): number {
  let total = 0;
  for (const d of Object.values(draft)) {
    total += d.writeOff;
    for (const p of Object.values(d.parts)) total += p.writeOff;
  }
  return total;
}

/** Would the order be closable once this batch is done — everything issued (spec rule 12),
 *  or, for an order without a customer, everything on the shelf or issued (followups, rule 36)? */
export function completesOrder(state: FulfilmentState, draft: Draft): boolean {
  return state.lines.every((line) => {
    const d = draft[line.line_id];
    if (line.mode === 'parts') {
      return line.parts.every((part) => {
        const p = d?.parts[part.part_id];
        if (state.closes_to_stock) {
          return part.issued + part.held + (p?.receive ?? 0) - (p?.writeOff ?? 0) >= part.wanted;
        }
        return part.issued + (p?.issue ?? 0) >= part.wanted;
      });
    }
    if (state.closes_to_stock) {
      return line.issued + line.held + (d?.assemble ?? 0) + (d?.receive ?? 0) - (d?.writeOff ?? 0) >= line.ordered;
    }
    return line.issued + (d?.issue ?? 0) >= line.ordered;
  });
}
