import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { DispatchNotesParams } from '../api/client';

/** Whose notes a key asks for — a customer's, an order's, or (the stock tab) the farm's. */
function ownerOf(params: DispatchNotesParams | undefined): string {
  return `${params?.customer_id ?? ''}|${params?.project_id ?? ''}`;
}

/** One server page of dispatch notes — the stock tab, an order's and a customer's issues
 *  (spec workshop-dispatch-notes, rules 20–22).
 *
 *  The previous answer stays on screen while the next one loads — but only the SAME
 *  owner's (WS-13 E11 E09, R02): a customer's notes are never shown, even dimmed, under
 *  another customer, nor an order's under another order. The stock tab names no owner, so
 *  its pages and searches keep the previous answer as they always did. */
export function useDispatchNotes(params: DispatchNotesParams, enabled = true) {
  const owner = ownerOf(params);
  return useQuery({
    queryKey: ['dispatch-notes', params],
    queryFn: () => api.getDispatchNotes(params),
    placeholderData: (previous, previousQuery) =>
      previousQuery && ownerOf(previousQuery.queryKey[1] as DispatchNotesParams | undefined) === owner
        ? previous
        : undefined,
    enabled,
  });
}

/** The farm's count of dispatch notes — the stock page's «Dispatch notes (N)» (WS-13 E12 B03):
 *  one light read under the notes' key, so an issue refreshes it. Unknown — while it is read or
 *  after a failure — is `undefined`, never a zero. */
export function useDispatchNotesCount(): number | undefined {
  const { data, isPlaceholderData } = useDispatchNotes({ page: 1, per_page: 1 });
  return data && !isPlaceholderData ? data.meta.total : undefined;
}

/** One dispatch note — the document page (rule 19). */
export function useDispatchNote(id: number) {
  return useQuery({
    queryKey: ['dispatch-note', id],
    queryFn: () => api.getDispatchNote(id),
    enabled: Number.isFinite(id) && id > 0,
  });
}
