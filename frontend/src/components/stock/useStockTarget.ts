import { useEffect, useState } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import type { StockItem } from '../../api/client';
import { useStockItem, useStockLookup } from '../../hooks/useFinishedStock';
import { useProductDetail } from '../../hooks/useProductDetail';

/**
 * The CURRENT answer of a query (WS-13 E12 G08): a success of THIS key that arrived after
 * the dialog opened, with no read on its way. A cached answer from before, a placeholder of
 * another key or an answer being read again is not one.
 */
export function isCurrent(q: UseQueryResult<unknown>): boolean {
  return q.isSuccess && q.isFetchedAfterMount && !q.isFetching && !q.isPlaceholderData;
}

/**
 * Which position a stock dialog acts on, and what the server says about it now — the move
 * dialog's and the assembly's one answer to G08 (R04).
 *
 * A fixed position (`item`) is read at the opening; a product's configuration waits for
 * the product's groups, then asks `lookup` — every new key read now, since the app keeps a
 * query fresh for a minute and a cached answer is not this dialog's — and, once the lookup
 * names a position, that position is read too (its reservations live only there). Only a
 * current answer gives a number: `figures` and `lookupCurrent` say so. What is SHOWN —
 * `shownFigures`, `lookupShown` — is the current answer, or the last answer of the SAME key
 * this dialog has read, kept on screen dimmed while that key is read again or after its re-read
 * failed (owner, F6 D1) — never as a limit. A cache from before the opening and another key's
 * answer show nothing («reading…»). After a refusal `reread()` asks both again and nothing is
 * judged until they answer.
 */
export function useStockTarget({
  item,
  productId,
  options,
}: {
  item?: StockItem;
  productId: number | null;
  options: number[];
}) {
  const [rereading, setRereading] = useState(false);

  const product = useProductDetail(item ? null : productId);
  // The groups must be read before a configuration means anything (G08).
  const groupsReady = item == null && productId != null && product.data != null;
  const lookup = useStockLookup(groupsReady ? productId : null, options);
  const lookupKey = `${groupsReady ? productId : ''}:${[...options].sort((a, b) => a - b).join(',')}`;
  useEffect(() => {
    if (groupsReady) void lookup.refetch({ cancelRefetch: false });
    // The key is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookupKey]);
  const lookupCurrent = groupsReady && isCurrent(lookup) && !rereading;
  const lookupOwn = lookup.data && !lookup.isPlaceholderData ? lookup.data : undefined;
  // F6 D1: this key's answer, once read in this dialog, stays on screen while it is read again.
  const lookupShown = lookupCurrent || (groupsReady && lookup.isFetchedAfterMount) ? lookupOwn : undefined;

  const positionId = item?.id ?? lookupOwn?.item?.id;
  const detail = useStockItem(positionId ?? 0);
  useEffect(() => {
    if (positionId != null) void detail.refetch({ cancelRefetch: false });
    // The position is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positionId]);
  const detailCurrent = positionId != null && isCurrent(detail) && !rereading;
  const figures = detailCurrent ? detail.data : undefined;
  const shownFigures =
    figures ?? (positionId != null && detail.isFetchedAfterMount && !detail.isPlaceholderData ? detail.data : undefined);

  const reread = () => {
    setRereading(true);
    const reads: Promise<unknown>[] = [];
    if (positionId != null) reads.push(detail.refetch({ cancelRefetch: false }));
    if (item == null && groupsReady) reads.push(lookup.refetch({ cancelRefetch: false }));
    void Promise.allSettled(reads).finally(() => setRereading(false));
  };

  return {
    product,
    groupsReady,
    lookup,
    lookupCurrent,
    lookupOwn,
    lookupShown,
    positionId,
    detail,
    detailCurrent,
    figures,
    shownFigures,
    reread,
    /** Reading again after a refusal — nothing is judged until it answers. */
    rereading,
  };
}
