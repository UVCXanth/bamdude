import { useQuery, useQueryClient } from '@tanstack/react-query';
import { partImageBatcher } from '../utils/partImageBatch';
import { PART_IMAGE_REFS_KEY } from '../utils/queryInvalidation';

/**
 * One part's picture, read apart from the figures of the view that shows it (spec
 * procurement-stock-images R5): a picture-only change re-reads this, and never a stock or order
 * answer. Every part asked in one tick goes out in one request (`utils/partImageBatch.ts`).
 *
 * ⚠️ No `initialData` / `placeholderData` from the view's own answer: a structural change resets
 * this query to «no answer yet», and a seeded value would bring the old picture straight back.
 * `retry: false` — a retry would leave the batch on a timer of its own; the next change, a remount
 * or a refocus reads it again. `staleTime: 0` (spec R5) — a view shown again reads its pictures
 * again, one request for all of them: the app keeps other answers fresh for a minute, and a cached
 * picture would win over a newer one in the view's own fresh answer for that long.
 */
export function usePartImageRef(partId: number, enabled = true) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: [PART_IMAGE_REFS_KEY, partId],
    queryFn: ({ signal }) => partImageBatcher(queryClient).load(partId, signal),
    enabled: enabled && Number.isSafeInteger(partId) && partId > 0,
    retry: false,
    staleTime: 0,
  });
}
