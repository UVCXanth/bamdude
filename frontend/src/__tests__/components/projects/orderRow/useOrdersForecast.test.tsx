import { describe, it, expect } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../../mocks/server';
import type { OrderListItem } from '../../../../api/client';
import { forecastIdsFor, useOrdersForecast } from '../../../../components/projects/orderRow/useOrdersForecast';
import { FORECAST_DEFAULTS, ORDER_ROW_DEFAULTS } from '../../../wireDefaults';

const row = (id: number, over: Partial<OrderListItem> = {}): OrderListItem => ({
  ...ORDER_ROW_DEFAULTS,
  id, code: `OR-${id}`, name: `O${id}`, customer_id: null, customer_name: null, color: null, status: 'active',
  stage: 'prep', responsible_id: null, responsible_name: null, due_date: null, priority: 'normal', price: null,
  tags: null, cover_image_filename: null, created_at: '2026-09-01T00:00:00', lines_count: 1, ordered: 5, printed: 0,
  progress: 0, covered_units: 0, remaining: 5, from_stock_units: 0, issued_units: 0, line_products: [],
  prints_in_progress: 0, prints_queued: 0, ...over,
});

const farm = { now: '2026-10-01T00:00:00Z', printers: 0, accepting: 0, assumptions: [] };
const forecastOf = (id: number) => ({
  ...FORECAST_DEFAULTS, project_id: id, now_eta: null, now_seconds: null, after_eta: null, after_seconds: null,
  machine_seconds: null, unknown_prints: 0, unroutable_prints: 0, eta_complete: true, ahead_count: 0, assumptions: [],
});

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('forecastIdsFor', () => {
  it('asks only for active orders that still have something to cover (R07)', () => {
    const rows = [
      row(1),
      row(2, { status: 'completed' }),
      row(3, { ordered: 0, remaining: 0 }),
      row(4, { remaining: 0 }),
      row(5),
    ];
    expect(forecastIdsFor(rows)).toEqual([1, 5]);
  });
});

describe('useOrdersForecast', () => {
  it('sends one request per batch of 200, never one per row', async () => {
    const asked: string[] = [];
    server.use(
      http.get('/api/v1/projects/forecast', ({ request }) => {
        const ids = (new URL(request.url).searchParams.get('ids') ?? '').split(',').map(Number);
        asked.push(String(ids.length));
        return HttpResponse.json({ farm, orders: ids.map(forecastOf) });
      }),
    );
    const rows = Array.from({ length: 201 }, (_, i) => row(i + 1));
    const { result } = renderHook(() => useOrdersForecast(rows, true), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.state).toBe('data'));
    expect(asked).toEqual(['200', '1']);
    expect(Object.keys(result.current.byId)).toHaveLength(201);
  });

  it('asks nothing when no row needs a forecast, or when the view does not show one', async () => {
    let calls = 0;
    server.use(http.get('/api/v1/projects/forecast', () => { calls += 1; return HttpResponse.json({ farm, orders: [] }); }));
    const idle = renderHook(() => useOrdersForecast([row(1, { status: 'completed' })], true), { wrapper: wrapper() });
    const off = renderHook(() => useOrdersForecast([row(2)], false), { wrapper: wrapper() });
    expect(idle.result.current.state).toBe('idle');
    expect(off.result.current.state).toBe('idle');
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(0);
  });

  it('fails the whole set when a batch fails, and a retry reads it again', async () => {
    let fail = true;
    server.use(
      http.get('/api/v1/projects/forecast', ({ request }) => {
        const ids = (new URL(request.url).searchParams.get('ids') ?? '').split(',').map(Number);
        if (fail && ids.length === 1) return HttpResponse.json({ detail: 'boom' }, { status: 500 });
        return HttpResponse.json({ farm, orders: ids.map(forecastOf) });
      }),
    );
    const rows = Array.from({ length: 201 }, (_, i) => row(i + 1));
    const { result } = renderHook(() => useOrdersForecast(rows, true), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.state).toBe('error'));
    fail = false;
    act(() => result.current.refetch());
    await waitFor(() => expect(result.current.state).toBe('data'));
  });
});
