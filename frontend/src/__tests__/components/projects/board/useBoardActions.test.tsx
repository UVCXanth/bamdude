import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
});
