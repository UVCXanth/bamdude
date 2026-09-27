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
/** The one-off tab's pick: the file stays picked while its plate is not chosen yet. */
export type PlatePick = { fileId: number; filename: string; plateIndex: number | null; copies: number } | null;

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

/** The server's cap on one part's count (`line_config.MAX_COUNT`). */
export const MAX_PART_COUNT = 9999;

/** Parts of one product are ONE `parts` line (spec rule 21), products in the order first ticked. */
export function partsLines(picks: PartPicks): BatchLine[] {
  const byProduct = new Map<number, Record<number, number>>();
  for (const [partId, { productId, qty }] of picks) {
    const counts = byProduct.get(productId) ?? {};
    counts[partId] = qty;
    byProduct.set(productId, counts);
  }
  return [...byProduct].map(([productId, counts]) => ({ kind: 'parts', product_id: productId, part_counts: counts }));
}

export function partUnits(picks: PartPicks): number {
  let units = 0;
  for (const pick of picks.values()) units += pick.qty;
  return units;
}

/** The plate line, once a plate is chosen; stock is kits only, picked by the server (rule 11). */
export function plateLines(pick: PlatePick): BatchLine[] {
  if (!pick || pick.plateIndex == null) return [];
  return [{ kind: 'plate', library_file_id: pick.fileId, plate_index: pick.plateIndex, copies: pick.copies }];
}

/** A line whose shelf gave less than was asked — the shelf moved (rule 23). */
export interface Shortfall {
  name: string;
  askedFinished: number;
  gotFinished: number;
  askedKits: number;
  gotKits: number;
}

/** What the dialog showed for a line when «Add» was pressed; `undefined` where it showed nothing. */
export type Shown = { finished: number; kits: number } | undefined;

/**
 * Named by the order's own lines — the one answer that knows a plate line's
 * product too. ⚠️ For an «auto» row the server picks again at confirmation, so
 * its `asked` always equals its `got` (final review I1): the comparison is with
 * what the dialog SHOWED (`shown`, in the order of the lines sent), and with the
 * server's `asked` only where the dialog showed nothing.
 */
export function shortfalls(result: BatchLinesResult, shown: Shown[] = []): Shortfall[] {
  const names = new Map((result.order.lines ?? []).map((line) => [line.id, line.product_name]));
  return result.results
    .map((r, i) => ({
      name: names.get(r.line_id) ?? `#${r.line_id}`,
      askedFinished: shown[i]?.finished ?? r.asked_finished,
      gotFinished: r.got_finished,
      askedKits: shown[i]?.kits ?? r.asked_kits,
      gotKits: r.got_kits,
    }))
    .filter((s) => s.gotFinished < s.askedFinished || s.gotKits < s.askedKits);
}

/** What each product line shows, in the order the batch sends them (see {@link shortfalls}). */
export function shownForLines(picks: ProductPicks, suggestions: Map<number, StockSuggestion>, takesStock: boolean): Shown[] {
  return [...picks].map(([productId, pick]) => {
    if (!takesStock) return undefined;
    const shown = shownStock(pick, suggestions.get(productId));
    return { finished: shown.fromFinished, kits: shown.fromKits };
  });
}

function clamp(value: number, cap: number): number {
  return Math.max(0, Math.min(value, Math.max(0, cap)));
}
