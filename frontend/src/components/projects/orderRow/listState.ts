/**
 * The state of a paged order list (WS-13 E7 C05), read off the query of the
 * CURRENT key.
 *
 * ⚠️ `keepPreviousData` keeps the previous key's rows only while the new key is in
 * flight: once the new key FAILS, TanStack answers `data = undefined` (R03, probed
 * on the installed version). So a failed page, filter or customer is `failed` —
 * no rows of another key, no page bar, no workspace detail — and only a failed
 * background re-read of the SAME key keeps its rows (`refresh-failed`).
 */
export type ListState = 'loading' | 'transition' | 'refresh-failed' | 'failed' | 'empty' | 'data';

export function listState(q: {
  data: { meta: { total: number } } | undefined;
  isError: boolean;
  isPlaceholderData: boolean;
}): ListState {
  if (q.isPlaceholderData) return 'transition';
  if (q.isError) return q.data ? 'refresh-failed' : 'failed';
  if (!q.data) return 'loading';
  return q.data.meta.total === 0 ? 'empty' : 'data';
}
