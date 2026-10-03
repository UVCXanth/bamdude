import type { StockReservationGroup } from '../../api/client';

/**
 * What a position holds by hand, as the server counts it (`finished_stock.unassigned_reserved`):
 * the reservations with no order LINE. A line the server could not resolve to an order still
 * belongs to that order, never to the hand — so the test is the line, not the order's id
 * (WS-13 E12 final review M7). The release and «issue from the manual reservation» limits
 * (R03) and the position page's greyed moves all ask this one function.
 */
export function manualReserved(reservations: StockReservationGroup[]): number {
  return reservations.filter((r) => r.project_line_id == null).reduce((sum, r) => sum + r.qty, 0);
}
