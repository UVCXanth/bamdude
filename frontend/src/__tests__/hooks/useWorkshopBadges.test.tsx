import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { api } from '../../api/client';
import { useWorkshopBadges } from '../../hooks/useWorkshopBadges';

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);

describe('useWorkshopBadges', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('asks the server when the user may see Projects', async () => {
    const get = vi.spyOn(api, 'getProjectsNavBadges').mockResolvedValue({ active_orders: 3 });
    const { result } = renderHook(() => useWorkshopBadges(true), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual({ active_orders: 3 }));
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('asks nothing without the permission', async () => {
    const get = vi.spyOn(api, 'getProjectsNavBadges');
    renderHook(() => useWorkshopBadges(false), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(get).not.toHaveBeenCalled();
  });

  it('a failed request leaves no number behind', async () => {
    vi.spyOn(api, 'getProjectsNavBadges').mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useWorkshopBadges(true), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined(); // Layout maps undefined → 0 → no badge
  });
});
