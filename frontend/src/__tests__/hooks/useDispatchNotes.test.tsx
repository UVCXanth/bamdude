/**
 * The dispatch notes' one query (WS-13 E11 E09, R02): the previous answer stays on screen
 * while the next one loads only for the SAME owner — a customer's notes are never shown
 * under another customer, an order's under another order. The stock tab has no owner, so
 * its pages and searches keep the previous answer as before.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { api } from '../../api/client';
import type { DispatchNotesParams } from '../../api/client';
import { useDispatchNotes } from '../../hooks/useDispatchNotes';

const answer = (id: number) => ({ items: [{ id }], meta: { total: 1, current_page: 1, per_page: 24, last_page: 1 } }) as never;

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

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
