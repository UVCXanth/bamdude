import type { QueryStatus } from '@tanstack/react-query';

/**
 * May the draft be saved (WS-13 E5 R05)? An unchanged one only closes, so yes. A
 * changed one only once its impact is known for exactly this draft: the product
 * read, the draft settled past its debounce, no ask in flight, and the LAST ask for
 * this draft answered — a cached answer after a failed re-read is not one.
 */
export function saveAllowed({
  productRead,
  dirty,
  settled,
  fetching,
  status,
}: {
  productRead: boolean;
  dirty: boolean;
  settled: boolean;
  fetching: boolean;
  status: QueryStatus;
}): boolean {
  if (!productRead) return false;
  if (!dirty) return true;
  return settled && !fetching && status === 'success';
}
