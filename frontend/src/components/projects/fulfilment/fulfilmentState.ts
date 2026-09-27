import type { FulfilmentLineBody, FulfilmentLineState, FulfilmentState } from '../../../api/client';

/**
 * The issue dialog's draft (spec workshop-order-issue, rule 27) — pure, so the
 * arithmetic the dialog shows is tested apart from it. The server checks every
 * number again against the same `state` under its locks; these functions only
 * keep the form from asking for what the state already says is impossible.
 */

/** `all` fills everything; `receive` («Оприбуткувати…») issues nothing. */
export type FulfilmentMode = 'all' | 'receive';

export interface PartDraft {
  receive: number;
  issue: number;
}

export interface LineDraft {
  assemble: number;
  receive: number;
  issue: number;
  parts: Record<number, PartDraft>;
}

/** `line_id → draft`. */
export type Draft = Record<number, LineDraft>;

/** What a product line can hand over in this batch: what lies on the shelf plus
 *  what this batch assembles and receives. */
export function issueCeiling(line: FulfilmentLineState, draft: LineDraft): number {
  return line.held + draft.assemble + draft.receive;
}

export function draftFrom(state: FulfilmentState, mode: FulfilmentMode): Draft {
  const out: Draft = {};
  for (const line of state.lines) {
    const parts: Record<number, PartDraft> = {};
    for (const part of line.parts) {
      parts[part.part_id] = { receive: part.can_receive, issue: mode === 'all' ? part.held + part.can_receive : 0 };
    }
    const assemble = line.can_assemble;
    const receive = line.can_receive;
    out[line.line_id] = {
      assemble,
      receive,
      issue: mode === 'all' ? line.held + assemble + receive : 0,
      parts,
    };
  }
  return out;
}

function clamp(n: number, max: number): number {
  return Math.max(0, Math.min(Number.isFinite(n) ? Math.floor(n) : 0, max));
}

/** Every number between 0 and what the state allows; an issue never above its ceiling. */
export function clampDraft(draft: Draft, state: FulfilmentState): Draft {
  const out: Draft = {};
  for (const line of state.lines) {
    // A line the draft never had (the state was read again) starts at nothing.
    const d = draft[line.line_id] ?? { assemble: 0, receive: 0, issue: 0, parts: {} };
    const assemble = clamp(d.assemble, line.can_assemble);
    const receive = clamp(d.receive, line.can_receive);
    const parts: Record<number, PartDraft> = {};
    for (const part of line.parts) {
      const p = d.parts[part.part_id] ?? { receive: 0, issue: 0 };
      const partReceive = clamp(p.receive, part.can_receive);
      parts[part.part_id] = { receive: partReceive, issue: clamp(p.issue, part.held + partReceive) };
    }
    out[line.line_id] = { assemble, receive, issue: clamp(d.issue, line.held + assemble + receive), parts };
  }
  return out;
}

/** The request's lines — only what is not zero; a parts line names its parts. */
export function requestFrom(draft: Draft): FulfilmentLineBody[] {
  const out: FulfilmentLineBody[] = [];
  for (const [id, d] of Object.entries(draft)) {
    const lineId = Number(id);
    const parts = Object.entries(d.parts)
      .filter(([, p]) => p.receive > 0 || p.issue > 0)
      .map(([partId, p]) => ({ part_id: Number(partId), receive: p.receive, issue: p.issue }));
    if (parts.length > 0) {
      out.push({ line_id: lineId, parts });
    } else if (d.assemble > 0 || d.receive > 0 || d.issue > 0) {
      out.push({ line_id: lineId, assemble: d.assemble, receive: d.receive, issue: d.issue });
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

/** Would everything ordered be issued once this batch is done (spec rule 12)? */
export function completesOrder(state: FulfilmentState, draft: Draft): boolean {
  return state.lines.every((line) => {
    const d = draft[line.line_id];
    if (line.mode === 'parts') {
      return line.parts.every((part) => part.issued + (d?.parts[part.part_id]?.issue ?? 0) >= part.wanted);
    }
    return line.issued + (d?.issue ?? 0) >= line.ordered;
  });
}
