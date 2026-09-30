/**
 * The fields WS-13 E1 added to the wire, at the values the server sends when there is
 * nothing to say. A fixture written before them spreads the matching block so it stays
 * the shape the server answers (CL5) — and a test about one of these fields sets it
 * explicitly after the spread.
 */

import type { ListVariantGroup } from '../api/client';

/** `ProductListItem` (PC2, PC3). */
export const PRODUCT_ROW_DEFAULTS = {
  sliced: false,
  printed_parts_count: 0,
  purchased_parts_count: 0,
  variant_group_names: [] as string[],
  variant_groups: [] as ListVariantGroup[],
  active_orders_count: 0,
  finished_positions: 0,
  finished_below_min: 0,
};

/** `ProjectFigures` (OR8, PR4–PR7): no purchases at all is a known 0.00. */
export const FIGURES_DEFAULTS = {
  issued_units: 0,
  held_units: 0,
  procurement_cost: 0 as number | null,
  procurement_known_cost: 0,
  procurement_partial: false,
  cost_with_procurement: null as number | null,
  margin_with_procurement: null as number | null,
};

/** `OrderForecast` (OR4, OR5). */
export const FORECAST_DEFAULTS = {
  incomplete_reasons: [] as { code: string; count: number | null }[],
  late: false,
};

/** `OrderListItem` (OR2, OR3). */
export const ORDER_ROW_DEFAULTS = {
  materials: [] as string[],
  products: [] as { product_id: number; has_cover: boolean }[],
};

/** `StockProduct` (ST4). */
export const STOCK_ROW_DEFAULTS = {
  sku: null as string | null,
  parts_on_shelf: 0,
  kits_by_option: [],
};

/** `ProductPartRow` / a part's sources (PS2). */
export const PART_SOURCES_DEFAULTS = {
  sources: [],
  has_sliced_source: false,
  yield_min: null as number | null,
  yield_max: null as number | null,
  hidden_sources: 0,
};
