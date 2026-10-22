import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type DraftPreview } from '../../api/client';
import { DRAFT_DEBOUNCE_MS, useDraftForecast } from '../../hooks/useDraftForecast';

function result(revision: string, seconds = 72000): DraftPreview {
  return {
    client_revision: revision, inputs_token: 'inputs', forecast: null, forecast_error: 'forecast_unavailable',
    totals: { prints: 10, rows: 1, print_time_seconds: seconds, filament_used_grams: 10, cost: null },
    workload: { prints: 10, known_seconds: seconds, total_seconds: seconds, unknown_prints: 0, by_model: [], by_line: [] },
    coverage: [], coverage_complete: true, issues: [], order_ready_at: null, comparison: { status: 'no_baseline' },
  };
}
function Wrapper({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('exact draft forecast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(api, 'previewDraftFilament').mockResolvedValue({ project_id: 1, rows: [], unknown_prints: 0, stock_unavailable: false, assumptions: [] });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('debounces changes and sends the same explicit files/counts as enqueue', async () => {
    const preview = vi.spyOn(api, 'previewOrderDraft').mockImplementation(async (_, body) => result(body.client_revision));
    const { result: hook, rerender } = renderHook(({ count }) => useDraftForecast(1,
      [{ line_id: 10, plate_id: 20, count }], 'inputs', true, false), { wrapper: Wrapper, initialProps: { count: 10 } });
    rerender({ count: 9 });
    rerender({ count: 8 });
    expect(preview).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS + 20); });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview.mock.calls[0][1].entries[0]).toMatchObject({ line_id: 10, plate_id: 20, count: 8 });
    expect(hook.current.result?.workload.total_seconds).toBe(72000);
  });

  it('never displays an old request after a newer edit, even if it ignores abort', async () => {
    let old!: (value: DraftPreview) => void;
    const preview = vi.spyOn(api, 'previewOrderDraft')
      .mockImplementationOnce(() => new Promise(resolve => { old = resolve; }))
      .mockImplementation(async (_, body) => result(body.client_revision, 64800));
    const { result: hook, rerender } = renderHook(({ count }) => useDraftForecast(1,
      [{ line_id: 10, plate_id: 20, count }], 'inputs', true, false), { wrapper: Wrapper, initialProps: { count: 10 } });
    await act(async () => { await vi.advanceTimersByTimeAsync(520); });
    rerender({ count: 9 });
    await act(async () => { await vi.advanceTimersByTimeAsync(520); });
    expect(preview).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(hook.current.result?.workload.total_seconds).toBe(64800);
    await act(async () => { old(result('old', 72000)); await vi.advanceTimersByTimeAsync(20); });
    expect(hook.current.result?.workload.total_seconds).toBe(64800);
  });

  it('does not submit an incomplete split or a hidden editor', async () => {
    const preview = vi.spyOn(api, 'previewOrderDraft');
    const { result: hook, rerender } = renderHook(({ enabled, invalid }) => useDraftForecast(1, [], 'inputs', enabled, invalid),
      { wrapper: Wrapper, initialProps: { enabled: true, invalid: true } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    rerender({ enabled: false, invalid: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(preview).not.toHaveBeenCalled();
    expect(hook.current.pending).toBe(false);
    expect(hook.current.result).toBeUndefined();
  });
});
