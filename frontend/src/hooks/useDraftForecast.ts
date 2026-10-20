import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type DraftPreview, type DraftPreviewRequest, type OrderNeeds, type PlanEnqueueItem } from '../api/client';

export const DRAFT_DEBOUNCE_MS = 500;
export interface DraftForecastState {
  result?: DraftPreview;
  filament?: OrderNeeds;
  pending: boolean;
  error: boolean;
  invalid: boolean;
  filamentError?: boolean;
  retry: () => void;
}

/** One owner for exact work, shared by the page, figures, lines and modal. */
export function useDraftForecast(orderId: number, items: PlanEnqueueItem[], inputsToken: string | null | undefined,
  enabled: boolean, invalid: boolean, refreshRevision = 0) {
  const queryClient = useQueryClient();
  const signature = JSON.stringify([items, inputsToken, refreshRevision]);
  const [settled, setSettled] = useState('');
  useEffect(() => {
    if (!enabled || invalid) return;
    const timer = setTimeout(() => setSettled(signature), DRAFT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [signature, enabled, invalid]);
  const body = useMemo<DraftPreviewRequest>(() => ({
    client_revision: signature.length > 90 ? String(hash(signature)) : signature,
    inputs_token: inputsToken,
    entries: items.map((item, index) => ({ ...item, entry_id: `${item.line_id}:${item.plate_id}:${index}` })),
  }), [signature, inputsToken, items]);
  const current = enabled && !invalid && settled === signature;
  const forecast = useQuery({
    queryKey: ['order-draft-forecast', orderId, signature],
    queryFn: ({ signal }) => api.previewOrderDraft(orderId, body, signal),
    enabled: current,
    retry: false,
    staleTime: 30_000,
    gcTime: 30_000,
  });
  const filament = useQuery({
    queryKey: ['order-draft-filament', orderId, signature],
    queryFn: ({ signal }) => api.previewDraftFilament(orderId, body, signal),
    enabled: current,
    retry: false,
    staleTime: 30_000,
    gcTime: 30_000,
  });
  useEffect(() => {
    if (forecast.error instanceof ApiError && forecast.error.code === 'inputs_changed') {
      void queryClient.invalidateQueries({ queryKey: ['project-plan', orderId] });
    }
  }, [forecast.error, queryClient, orderId]);
  const { data, isFetching, isError, refetch } = forecast;
  const { data: filamentData, isError: filamentError, refetch: refetchFilament } = filament;
  return useMemo<DraftForecastState>(() => ({
    result: current ? data : undefined,
    filament: current ? filamentData : undefined,
    pending: !invalid && (!current || isFetching || !data && !isError),
    error: current && isError,
    invalid,
    filamentError: current && filamentError,
    retry: () => { void refetch(); void refetchFilament(); },
  }), [current, data, isFetching, isError, refetch, filamentData, filamentError, refetchFilament, invalid]);
}

// A small revision echo, not a source identity or permission token. The full
// structural signature is the query key, so collisions cannot reuse a result.
function hash(s: string) {
  let n = 0;
  for (const c of s) n = (Math.imul(n, 31) + c.charCodeAt(0)) | 0;
  return n;
}
