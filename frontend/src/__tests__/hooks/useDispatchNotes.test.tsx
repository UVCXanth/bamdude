/**
 * The dispatch notes' one query (WS-13 E11 E09, R02): the previous answer stays on screen
 * while the next one loads only for the SAME owner — a customer's notes are never shown
 * under another customer, an order's under another order. The stock tab has no owner, so
 * its pages and searches keep the previous answer as before.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { api } from '../../api/client';
import type { DispatchNotesParams } from '../../api/client';
import { useDispatchNotes, useDispatchNotesCount } from '../../hooks/useDispatchNotes';

const answer = (id: number) => ({ items: [{ id }], meta: { total: 1, current_page: 1, per_page: 24, last_page: 1 } }) as never;

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

// Codex E12-V04 (B03): a count whose re-read failed is unknown — no number in the tab — until
// a read answers again; a true zero stays a zero.
describe('useDispatchNotesCount', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('a failed re-read hides the count; the next answer brings the new one', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const page = (total: number) => ({ items: [], meta: { total, current_page: 1, per_page: 1, last_page: Math.max(total, 1) } }) as never;
    const get = vi.spyOn(api, 'getDispatchNotes').mockResolvedValueOnce(page(9));
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useDispatchNotesCount(), { wrapper });
    await waitFor(() => expect(result.current).toBe(9));
    get.mockRejectedValueOnce(new Error('HTTP 500'));
    await act(async () => {
      await client.refetchQueries({ queryKey: ['dispatch-notes'] });
    });
    await waitFor(() => expect(result.current).toBeUndefined());
    get.mockResolvedValueOnce(page(10));
    await act(async () => {
      await client.refetchQueries({ queryKey: ['dispatch-notes'] });
    });
    await waitFor(() => expect(result.current).toBe(10));
  });

  it('a true zero stays a zero', async () => {
    vi.spyOn(api, 'getDispatchNotes').mockResolvedValue({ items: [], meta: { total: 0, current_page: 1, per_page: 1, last_page: 1 } } as never);
    const { result } = renderHook(() => useDispatchNotesCount(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current).toBe(0));
  });
});

describe('useDispatchNotes', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('keeps the previous answer for the same owner, never for another', async () => {
    vi.spyOn(api, 'getDispatchNotes').mockImplementation(((p: DispatchNotesParams) =>
      p.page === 1 && p.customer_id === 2 ? Promise.resolve(answer(1)) : new Promise(() => {})) as never);
    const { result, rerender } = renderHook((p: DispatchNotesParams) => useDispatchNotes(p), {
      wrapper: makeWrapper(),
      initialProps: { customer_id: 2, page: 1 } as DispatchNotesParams,
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    rerender({ customer_id: 2, page: 2 });
    expect(result.current.isPlaceholderData).toBe(true);
    rerender({ customer_id: 3, page: 1 });
    expect(result.current.data).toBeUndefined();
  });

  it('the stock tab, which names no owner, keeps the previous answer across pages and searches', async () => {
    vi.spyOn(api, 'getDispatchNotes').mockImplementation(((p: DispatchNotesParams) =>
      p.page === 1 && !p.q ? Promise.resolve(answer(1)) : new Promise(() => {})) as never);
    const { result, rerender } = renderHook((p: DispatchNotesParams) => useDispatchNotes(p), {
      wrapper: makeWrapper(),
      initialProps: { page: 1 } as DispatchNotesParams,
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    rerender({ page: 2 });
    expect(result.current.isPlaceholderData).toBe(true);
    rerender({ page: 1, q: 'DN' });
    expect(result.current.isPlaceholderData).toBe(true);
  });
});
