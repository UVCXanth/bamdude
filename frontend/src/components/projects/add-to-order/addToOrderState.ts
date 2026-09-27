import type { BatchLine, BatchLinesResult, StockSuggestion, StockSuggestItem } from '../../../api/client';

/**
 * The picks of the «Add to order» dialog (spec workshop-add-to-order, rules
 * 19–20). They live in the dialog, keyed by id, so a search, another page or
 * another tab never loses them; closing the dialog drops them.
 */

/** One product the operator ticked on the products tab. */
export interface ProductPick {
  qty: number;
  /** Only the groups the operator set. A group left alone is the product's
   *  standard — the server fills it (`line_config`), as for every other line. */
  choices: Record<number, number>;
  /** `''` — any. */
  material: string;
  color: string;
  /** The operator's own numbers, read only while `auto` is false. */
  fromFinished: number;
  fromKits: number;
  /** Take the server's proposal: the batch sends `stock: 'auto'` and the
   *  server picks again under its locks. */
  auto: boolean;
}

export type ProductPicks = Map<number, ProductPick>;
/** Part id → how many to order; parts of one product become ONE line. */
export type PartPicks = Map<number, { productId: number; qty: number }>;
export type PlatePick = { fileId: number; plateIndex: number; copies: number } | null;

/** The server's cap on a line's quantity (`schemas/project.MAX_QTY`). */
export const MAX_LINE_QTY = 1_000_000;

export function newProductPick(): ProductPick {
  return { qty: 1, choices: {}, material: '', color: '', fromFinished: 0, fromKits: 0, auto: true };
}

/** What the shelf row shows and what the batch sends. */
export interface ShownStock {
  fromFinished: number;
  fromKits: number;
  toPrint: number;
}

/**
 * The stock numbers of a row: the server's proposal for an auto row, the
 * operator's for a manual one — both within the row's quantity and, once the
 * proposal is in, within what is free («з N»). Ready units first, kits on the
 * rest (spec rule 6).
 */
export function shownStock(pick: ProductPick, suggestion: StockSuggestion | undefined): ShownStock {
  const finishedCap = Math.min(pick.qty, suggestion?.finished_free ?? pick.qty);
  const wantFinished = pick.auto ? (suggestion?.from_finished ?? 0) : pick.fromFinished;
  const fromFinished = clamp(wantFinished, finishedCap);
  const kitsCap = Math.min(pick.qty - fromFinished, suggestion?.kits_free ?? pick.qty);
  const wantKits = pick.auto ? (suggestion?.from_kits ?? 0) : pick.fromKits;
  const fromKits = clamp(wantKits, kitsCap);
  return { fromFinished, fromKits, toPrint: Math.max(0, pick.qty - fromFinished - fromKits) };
}

/** An edited stock field: the row turns manual, holding what it shows now. */
export function withStock(
  pick: ProductPick,
  suggestion: StockSuggestion | undefined,
  field: 'fromFinished' | 'fromKits',
  value: number,
): ProductPick {
  const now = shownStock(pick, suggestion);
  const next: ProductPick = { ...pick, auto: false, fromFinished: now.fromFinished, fromKits: now.fromKits };
  next[field] = Math.max(0, Math.floor(value) || 0);
  const held = shownStock(next, suggestion);
  return { ...next, fromFinished: held.fromFinished, fromKits: held.fromKits };
}

/** One `/stock/suggest` item per pick, in the order they were ticked. */
export function suggestItems(picks: ProductPicks): StockSuggestItem[] {
  return [...picks].map(([productId, pick]) => ({
    product_id: productId,
    options: Object.values(pick.choices),
    quantity: pick.qty,
  }));
}

/**
 * The products tab's lines of the batch. An order that takes no stock (not
 * active, rule 7) sends zeros — the server would store zeros anyway.
 */
export function productLines(
  picks: ProductPicks,
  suggestions: Map<number, StockSuggestion>,
  takesStock: boolean,
): BatchLine[] {
  return [...picks].map(([productId, pick]) => {
    const shown = shownStock(pick, suggestions.get(productId));
    return {
      kind: 'product',
      product_id: productId,
      quantity: pick.qty,
      choices: pick.choices,
      material: pick.material || null,
      color: pick.color || null,
      stock: !takesStock
        ? { from_finished: 0, from_kits: 0 }
        : pick.auto
          ? 'auto'
          : { from_finished: shown.fromFinished, from_kits: shown.fromKits },
    };
  });
}

export function productUnits(picks: ProductPicks): number {
  let units = 0;
  for (const pick of picks.values()) units += pick.qty;
  return units;
}

/** A line whose shelf gave less than was asked — the shelf moved (rule 23). */
export interface Shortfall {
  name: string;
  askedFinished: number;
  gotFinished: number;
  askedKits: number;
  gotKits: number;
}

/** Named by the order's own lines — the one answer that knows a plate line's product too. */
export function shortfalls(result: BatchLinesResult): Shortfall[] {
  const names = new Map((result.order.lines ?? []).map((line) => [line.id, line.product_name]));
  return result.results
    .filter((r) => r.got_finished < r.asked_finished || r.got_kits < r.asked_kits)
    .map((r) => ({
      name: names.get(r.line_id) ?? `#${r.line_id}`,
      askedFinished: r.asked_finished,
      gotFinished: r.got_finished,
      askedKits: r.asked_kits,
      gotKits: r.got_kits,
    }));
}

function clamp(value: number, cap: number): number {
  return Math.max(0, Math.min(value, Math.max(0, cap)));
}
