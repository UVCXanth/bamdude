import type { EstimateReason, OrderForecast, OrderListItem } from '../../../api/client';

/** Where the list's forecast batch is (`useOrdersForecast`). */
export type ForecastState = 'idle' | 'loading' | 'error' | 'data';

/**
 * What a list says under «Ready ≈» about one order (WS-13 E7 B03).
 *
 * ⚠️ **Incomplete is the reasons, not `eta_complete`** (R01): an admitted ETA can
 * still come with `no_plate` & co — the date stays, with a warning beside it. A
 * date is admitted by E1's rule only (`eta_complete`), the rule the server's
 * `ready` sort and the deadlines board use, so a row never shows a date the column
 * order did not take into account. `eta_complete=false` always carries a reason
 * (`unknown_time` / `unroutable`), so it is «partial» too.
 */
export type Readiness =
  | { kind: 'closed' }
  | { kind: 'covered' }
  | { kind: 'loading' }
  | { kind: 'error' }
  /** eta_complete = false, or no date while reasons exist — never a date. */
  | { kind: 'partial'; reasons: EstimateReason[] }
  | { kind: 'none' }
  | { kind: 'eta'; eta: string; late: boolean; after: { eta: string; ahead: number } | null; reasons: EstimateReason[] };

export function readiness(
  order: Pick<OrderListItem, 'status' | 'ordered' | 'remaining'>,
  forecast: OrderForecast | undefined,
  state: ForecastState,
): Readiness {
  // Nothing is planned for a closed order or a draft without lines — and neither is asked.
  if (order.status !== 'active' || order.ordered <= 0) return { kind: 'closed' };
  // Not «everything printed»: the stage is the operator's (E01); coverage is the fact.
  if (order.remaining <= 0) return { kind: 'covered' };
  if (!forecast) return state === 'error' ? { kind: 'error' } : { kind: 'loading' };
  const reasons = forecast.incomplete_reasons ?? [];
  if (!forecast.eta_complete) return { kind: 'partial', reasons };
  if (!forecast.now_eta) return reasons.length > 0 ? { kind: 'partial', reasons } : { kind: 'none' };
  const after =
    forecast.after_eta && forecast.after_eta !== forecast.now_eta && forecast.ahead_count > 0
      ? { eta: forecast.after_eta, ahead: forecast.ahead_count }
      : null;
  return { kind: 'eta', eta: forecast.now_eta, late: forecast.late, after, reasons };
}
