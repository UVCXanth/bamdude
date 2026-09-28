import type { FulfilmentLineBody, FulfilmentLineState, FulfilmentState } from '../../../api/client';

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
