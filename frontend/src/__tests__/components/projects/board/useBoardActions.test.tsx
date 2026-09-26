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
    const { result } = renderHook(() => useBoardActions(), { wrapper });
    act(() => result.current.drop(5, 'prep', 'qc'));
    await waitFor(() => expect(stage).toHaveBeenCalledWith(5, 'qc'));
    expect(update).not.toHaveBeenCalled();
    expect(result.current.confirming).toBeNull();
  });
  it('a drop into «done» asks first and completes only on confirm', async () => {
    const stage = vi.spyOn(api, 'setOrderStage').mockResolvedValue({} as never);
    const update = vi.spyOn(api, 'updateOrder').mockResolvedValue({} as never);
    const { result } = renderHook(() => useBoardActions(), { wrapper });
    act(() => result.current.drop(5, 'qc', 'done'));
    expect(result.current.confirming).toBe(5);
    expect(update).not.toHaveBeenCalled();
    act(() => result.current.confirm());
    await waitFor(() => expect(update).toHaveBeenCalledWith(5, { status: 'completed' }));
    await waitFor(() => expect(result.current.confirming).toBeNull());
    expect(stage).not.toHaveBeenCalled();
  });
  it('cancel clears the question and sends nothing', () => {
    const update = vi.spyOn(api, 'updateOrder').mockResolvedValue({} as never);
    const { result } = renderHook(() => useBoardActions(), { wrapper });
    act(() => result.current.drop(5, 'printing', 'done'));
    act(() => result.current.cancel());
    expect(result.current.confirming).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });
  it('a drop into its own column, or of a completed card, sends nothing', () => {
    const stage = vi.spyOn(api, 'setOrderStage').mockResolvedValue({} as never);
    const update = vi.spyOn(api, 'updateOrder').mockResolvedValue({} as never);
    const { result } = renderHook(() => useBoardActions(), { wrapper });
    act(() => result.current.drop(5, 'qc', 'qc'));
    act(() => result.current.drop(5, 'done', 'prep'));
    expect(stage).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(result.current.confirming).toBeNull();
  });
});
