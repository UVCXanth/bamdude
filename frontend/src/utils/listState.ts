/**
 * The state of a paged Workshop list — orders, a customer's orders, the product
 * catalog (WS-13 E7 C05, E8 C08) — read off the query of the CURRENT key.
 *
 * ⚠️ `keepPreviousData` keeps the previous key's rows only while the new key is in
 * flight: once the new key FAILS, TanStack answers `data = undefined` (R03, probed
 * on the installed version). So a failed page, filter or customer is `failed` —
 * no rows of another key, no page bar, no workspace detail — and only a failed
 * background re-read of the SAME key keeps its rows (`refresh-failed`).
 */
export type ListState = 'loading' | 'transition' | 'refresh-failed' | 'failed' | 'empty' | 'data';

/**
 * The last answer had no rows — `empty`, or that same answer kept under a re-read that failed
 * (Codex r1 V01). The page keeps the empty explanation for both; the list says the failure.
 */
export function answeredEmpty(state: ListState, data: { meta: { total: number } } | undefined): boolean {
  return state === 'empty' || (state === 'refresh-failed' && data?.meta.total === 0);
}

/**
 * What a figure of the list's answer shows in its state (WS-13 E8 C11): a number only
 * from an answer of THIS key — «…» while one is on its way (the previous key's figures
 * belong to another filter), «—» when it failed; a 0 is a real 0 only then.
 */
export function listFigure(state: ListState, value: number): string {
  if (state === 'loading' || state === 'transition') return '…';
  if (state === 'failed') return '—';
  return String(value);
}

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
