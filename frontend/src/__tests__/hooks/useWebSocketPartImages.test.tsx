/**
 * `part_images_changed` through the real socket hook (spec procurement-stock-images R3, R6, R6a;
 * A08, A10, A16, A17, A19): a picture-only change re-reads the pictures and the product views, and
 * not one stock or order figure; a structural one keeps every read it had and drops only the
 * pictures of the products it named. Nothing happens per event — everything at the debounce flush.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { render } from '@testing-library/react';
import { ToastProvider } from '../../contexts/ToastContext';
import { server } from '../mocks/server';
import { LivePartThumb } from '../../components/PartThumb';
import type { PartImageMeta } from '../../api/client';
import { INVALIDATION_DEBOUNCE_MS, INVALIDATION_MAX_WAIT_MS } from '../../hooks/useWebSocket';
import { PART_IMAGE_REFS_KEY } from '../../utils/queryInvalidation';

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return { ...actual, api: { ...actual.api, getWebSocketToken: vi.fn().mockResolvedValue({ token: 't' }) } };
});
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: {} }) }));

let sockets: MockWebSocket[] = [];

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = MockWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  url: string;
  constructor(url: string) {
    this.url = url;
    sockets.push(this);
  }
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  });
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }
  say(data: unknown) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
  }
}

const imagesChanged = (product_ids: unknown, images_only?: boolean) => ({
  type: 'part_images_changed',
  data: images_only === undefined ? { product_ids } : { product_ids, images_only },
});

let originalWebSocket: typeof WebSocket;
let queryClient: QueryClient;
const stops: (() => void)[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  queryClient.clear();
  globalThis.WebSocket = originalWebSocket;
  vi.useRealTimers();
});

/** An observed query whose every read answers at once; `reads()` counts them. */
function numeric(key: readonly unknown[]) {
  let reads = 0;
  const observer = new QueryObserver(queryClient, {
    queryKey: key,
    queryFn: () => {
      reads += 1;
      return Promise.resolve({ value: reads });
    },
  });
  stops.push(observer.subscribe(() => {}));
  return { reads: () => reads, observer };
}

/** An observed picture of `part` in `product`; `answers` decides what each read says. */
function picture(part: number, product: number | null) {
  let reads = 0;
  const observer = new QueryObserver<PartImageMeta>(queryClient, {
    queryKey: [PART_IMAGE_REFS_KEY, part],
    queryFn: () => {
      reads += 1;
      return Promise.resolve({ part_id: part, product_id: product, image: { kind: 'render', status: 'ready', v: `r${reads}` } });
    },
  });
  stops.push(observer.subscribe(() => {}));
  return { reads: () => reads, data: () => observer.getCurrentResult().data };
}

async function connect() {
  const { useWebSocket } = await import('../../hooks/useWebSocket');
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(
      ToastProvider,
      { children: null },
      React.createElement(QueryClientProvider, { client: queryClient }, children),
    );
  const hook = renderHook(() => useWebSocket(), { wrapper });
  stops.push(() => hook.unmount());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const ws = sockets[sockets.length - 1];
  act(() => ws.open());
  return ws;
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('part_images_changed', () => {
  it('re-reads the pictures and the product views, and no stock or order figure, for a picture-only change', async () => {
    const stockItem = numeric(['stock-item', 1]);
    const lookup = numeric(['stock-lookup', 7, '']);
    const order = numeric(['project', 3]);
    const plan = numeric(['project-plan', 3]);
    const product = numeric(['product', 9]);
    const part = picture(5, 9);
    await advance(0);
    const ws = await connect();

    act(() => ws.say(imagesChanged([9], true)));
    await advance(INVALIDATION_MAX_WAIT_MS + 5000);

    expect([stockItem.reads(), lookup.reads(), order.reads(), plan.reads()]).toEqual([1, 1, 1, 1]);
    expect(stockItem.observer.getCurrentResult().isFetching).toBe(false);
    expect(product.reads()).toBe(2);
    expect(part.reads()).toBe(2);
    expect(part.data()?.image?.v).toBe('r2');
  });

  it('keeps every figure a structural change reads, and re-reads the pictures once', async () => {
    const stockItem = numeric(['stock-item', 1]);
    const plan = numeric(['project-plan', 3]);
    const part = picture(5, 9);
    await advance(0);
    const ws = await connect();

    act(() => ws.say(imagesChanged([9])));
    await advance(INVALIDATION_MAX_WAIT_MS + 5000);

    expect(stockItem.reads()).toBe(2);
    expect(plan.reads()).toBe(2);
    expect(part.reads()).toBe(2); // once — the paced lane never reads a picture
  });

  it('does nothing before the flush, then spends a burst in one pass', async () => {
    const part = picture(5, 9);
    await advance(0);
    const ws = await connect();
    const cancel = vi.spyOn(queryClient, 'cancelQueries');

    act(() => {
      for (let i = 0; i < 5; i++) ws.say(imagesChanged([9], true));
    });
    await advance(INVALIDATION_DEBOUNCE_MS - 100);
    expect(part.reads()).toBe(1);
    expect(cancel).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: [PART_IMAGE_REFS_KEY] }));

    await advance(200);
    expect(part.reads()).toBe(2);
    expect(cancel.mock.calls.filter(([f]) => JSON.stringify(f?.queryKey) === JSON.stringify([PART_IMAGE_REFS_KEY]))).toHaveLength(1);
  });

  it('drops the pictures of the products the structural events named — never one a picture-only event named', async () => {
    const first = picture(1, 1);
    const second = picture(2, 2);
    const third = picture(3, 3);
    const unknown = picture(4, null);
    const reset = vi.spyOn(queryClient, 'resetQueries');
    await advance(0);
    const ws = await connect();

    act(() => {
      ws.say(imagesChanged([1]));
      ws.say(imagesChanged([2]));
      ws.say(imagesChanged([3], true));
    });
    await advance(INVALIDATION_DEBOUNCE_MS + 100);

    const dropped = reset.mock.calls.flatMap(([filters]) =>
      queryClient
        .getQueryCache()
        .findAll({ queryKey: [PART_IMAGE_REFS_KEY] })
        .filter((q) => filters?.predicate?.(q))
        .map((q) => q.queryKey[1]),
    );
    expect(dropped.sort()).toEqual([1, 2, 4]);
    await advance(0);
    expect([first.reads(), second.reads(), third.reads(), unknown.reads()]).toEqual([2, 2, 2, 2]);
  });

  it('drops every picture when a structural event does not say which products it touched', async () => {
    for (const ids of [undefined, [], ['7'], [0]]) {
      const parts = [picture(10, 1), picture(11, 2)];
      await advance(0);
      const ws = await connect();
      const reset = vi.spyOn(queryClient, 'resetQueries');
      act(() => ws.say(imagesChanged(ids)));
      await advance(INVALIDATION_DEBOUNCE_MS + 100);
      const dropped = reset.mock.calls.flatMap(([filters]) =>
        queryClient
          .getQueryCache()
          .findAll({ queryKey: [PART_IMAGE_REFS_KEY] })
          .filter((q) => filters?.predicate?.(q)),
      );
      expect(dropped).toHaveLength(2);
      reset.mockRestore();
      stops.splice(0).forEach((stop) => stop());
      queryClient.clear();
      void parts;
    }
  });

  it('gives every live picture on screen one request per flush, through the real batcher (A19)', async () => {
    const requests: number[][] = [];
    server.use(
      http.get('/api/v1/product-parts/images', ({ request }) => {
        const ids = new URL(request.url).searchParams.getAll('part_ids').map(Number);
        requests.push(ids);
        return HttpResponse.json(
          ids.map((id) => ({ part_id: id, product_id: 9, image: { kind: 'render', status: 'ready', v: `w${requests.length}` } })),
        );
      }),
    );
    const { useWebSocket } = await import('../../hooks/useWebSocket');
    function Screen() {
      useWebSocket();
      return (
        <>
          {[1, 2, 3].map((id) => (
            <LivePartThumb key={id} partId={id} name={`P${id}`} image={null} />
          ))}
        </>
      );
    }
    const view = render(
      <ToastProvider>
        <QueryClientProvider client={queryClient}>
          <Screen />
        </QueryClientProvider>
      </ToastProvider>,
    );
    stops.push(() => view.unmount());
    await advance(0);
    await advance(0);
    expect(requests).toEqual([[1, 2, 3]]);
    const ws = sockets[sockets.length - 1];
    act(() => ws.open());

    act(() => {
      for (let i = 0; i < 5; i++) ws.say(imagesChanged([9], true));
      ws.say(imagesChanged([9]));
    });
    await advance(INVALIDATION_DEBOUNCE_MS - 100);
    expect(requests).toHaveLength(1); // nothing before the flush
    await advance(200);
    await advance(0);
    expect(requests).toEqual([[1, 2, 3], [1, 2, 3]]); // one request for the whole burst, not one per part
  });

  it('leaves an event that arrives after a flush to the next one', async () => {
    const part = picture(5, 9);
    await advance(0);
    const ws = await connect();

    act(() => ws.say(imagesChanged([9], true)));
    await advance(INVALIDATION_DEBOUNCE_MS + 100);
    expect(part.reads()).toBe(2);
    act(() => ws.say(imagesChanged([9], true)));
    await advance(100);
    expect(part.reads()).toBe(2);
    await advance(INVALIDATION_DEBOUNCE_MS);
    expect(part.reads()).toBe(3);
  });
});
