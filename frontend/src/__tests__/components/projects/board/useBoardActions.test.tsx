import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { ToastProvider } from '../../../../contexts/ToastContext';
import { api } from '../../../../api/client';
import { useBoardActions } from '../../../../components/projects/board/useBoardActions';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}

describe('useBoardActions', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  it('a drop into another active column sets the stage at once', async () => {
    const stage = vi.spyOn(api, 'setOrderStage').mockResolvedValue({} as never);
    const update = vi.spyOn(api, 'updateOrder').mockResolvedValue({} as never);
    const onComplete = vi.fn();
    const { result } = renderHook(() => useBoardActions(onComplete), { wrapper });
    act(() => result.current.drop(5, 'prep', 'qc'));
    await waitFor(() => expect(stage).toHaveBeenCalledWith(5, 'qc'));
    expect(update).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });
  it('a drop into «done» is the page’s «complete» door and writes nothing itself (WS-13 E6 B04)', () => {
    const stage = vi.spyOn(api, 'setOrderStage').mockResolvedValue({} as never);
    const update = vi.spyOn(api, 'updateOrder').mockResolvedValue({} as never);
    const onComplete = vi.fn();
    const { result } = renderHook(() => useBoardActions(onComplete), { wrapper });
    act(() => result.current.drop(5, 'qc', 'done'));
    expect(onComplete).toHaveBeenCalledWith(5);
    expect(update).not.toHaveBeenCalled();
    expect(stage).not.toHaveBeenCalled();
  });
  it('a drop into its own column, or of a completed card, sends nothing', () => {
    const stage = vi.spyOn(api, 'setOrderStage').mockResolvedValue({} as never);
    const update = vi.spyOn(api, 'updateOrder').mockResolvedValue({} as never);
    const onComplete = vi.fn();
    const { result } = renderHook(() => useBoardActions(onComplete), { wrapper });
    act(() => result.current.drop(5, 'qc', 'qc'));
    act(() => result.current.drop(5, 'done', 'prep'));
    expect(stage).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });
  // WS-13 E7 F05: one write per card at a time, from either door.
  it('holds a card while its stage is written, and refuses a second write for it', async () => {
    let finish!: () => void;
    const stage = vi.spyOn(api, 'setOrderStage').mockImplementation(() => new Promise((r) => { finish = () => r({} as never); }));
    const { result } = renderHook(() => useBoardActions(vi.fn()), { wrapper });
    act(() => result.current.setStage(5, 'qc'));
    await waitFor(() => expect(result.current.pendingIds.has(5)).toBe(true));
    act(() => result.current.drop(5, 'prep', 'printing'));
    act(() => result.current.setStage(5, 'printing'));
    expect(stage).toHaveBeenCalledTimes(1);
    expect(result.current.pendingIds.has(6)).toBe(false);
    await act(async () => finish());
    await waitFor(() => expect(result.current.pendingIds.has(5)).toBe(false));
  });
  // Released at the write's answer, the card flashed back undimmed in its old column — and could be
  // written again — until the board's re-read moved it. It is held until that re-read lands.
  it('holds the card until the board has been read again, not only until the write answers', async () => {
    vi.spyOn(api, 'setOrderStage').mockResolvedValue({} as never);
    let reads = 0;
    let release!: () => void;
    const { result } = renderHook(() => {
      useQuery({
        queryKey: ['projects', 'board', {}],
        queryFn: () => {
          reads += 1;
          return reads === 1 ? Promise.resolve({}) : new Promise((r) => { release = () => r({}); });
        },
      });
      return useBoardActions(vi.fn());
    }, { wrapper });
    await waitFor(() => expect(reads).toBe(1));
    act(() => result.current.setStage(5, 'qc'));
    await waitFor(() => expect(reads).toBe(2));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(result.current.pendingIds.has(5)).toBe(true);
    await act(async () => release());
    await waitFor(() => expect(result.current.pendingIds.has(5)).toBe(false));
  });
});
