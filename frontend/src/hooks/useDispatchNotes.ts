import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { DispatchNotesParams } from '../api/client';

/** One server page of dispatch notes — the stock tab, an order's and a customer's issues
 *  (spec workshop-dispatch-notes, rules 20–22). */
export function useDispatchNotes(params: DispatchNotesParams, enabled = true) {
  return useQuery({
    queryKey: ['dispatch-notes', params],
    queryFn: () => api.getDispatchNotes(params),
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** One dispatch note — the document page (rule 19). */
export function useDispatchNote(id: number) {
  return useQuery({
    queryKey: ['dispatch-note', id],
    queryFn: () => api.getDispatchNote(id),
    enabled: Number.isFinite(id) && id > 0,
  });
}
