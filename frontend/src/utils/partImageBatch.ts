import type { QueryClient } from '@tanstack/react-query';
import { api, type PartImageMeta } from '../api/client';

/** What the server takes in one request (`GET /product-parts/images`, spec procurement-stock-images R4). */
export const PART_IMAGE_BATCH_MAX = 200;

type FetchPartImageMeta = (partIds: readonly number[], signal: AbortSignal) => Promise<unknown>;

interface Flight {
  controller: AbortController;
  waiting: number;
}

interface Waiter {
  resolve: (meta: PartImageMeta) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  /** The request it waits on — none until its tick ends. */
  flight?: Flight;
  settled: boolean;
}

function abortError(): DOMException {
  return new DOMException('The picture read was cancelled', 'AbortError');
}

function isRef(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== 'object') return false;
  const ref = value as Record<string, unknown>;
  return (
    (ref.kind === 'photo' || ref.kind === 'render') &&
    (ref.status === 'ready' || ref.status === 'pending') &&
    (ref.v === null || typeof ref.v === 'string')
  );
}

function isMeta(value: unknown): value is PartImageMeta {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(row.part_id) &&
    (row.product_id === null || Number.isSafeInteger(row.product_id)) &&
    isRef(row.image)
  );
}

/**
 * The transport of the batch picture read (spec procurement-stock-images R5) — never a cache:
 * the QueryClient keeps every answer under `['part-image-refs', id]`, and this only turns one
 * tick of their `queryFn` calls into one request per 200 parts.
 *
 * A waiter is ONE query's fetch. Its cancellation takes only itself out: before the tick ends
 * its part is not sent, after it the request goes on for the neighbours and is aborted once
 * nobody waits for it. A part asked again after a cancellation waits in the next tick — never
 * on the doomed request, whose answer may predate the change that cancelled it. An answer that
 * does not name a part, or is not one, rejects that part's waiters: «no picture» is only ever
 * what the server said.
 */
export class PartImageBatcher {
  private queued = new Map<number, Waiter[]>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly fetchMeta: FetchPartImageMeta;

  constructor(fetchMeta: FetchPartImageMeta = (ids, signal) => api.getPartImageMeta(ids, signal)) {
    this.fetchMeta = fetchMeta;
  }

  load(partId: number, signal?: AbortSignal): Promise<PartImageMeta> {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise<PartImageMeta>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal, settled: false };
      if (signal) {
        waiter.onAbort = () => this.cancel(partId, waiter);
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      const list = this.queued.get(partId);
      if (list) list.push(waiter);
      else this.queued.set(partId, [waiter]);
      if (this.timer === null) this.timer = setTimeout(() => this.flush(), 0);
    });
  }

  private settle(waiter: Waiter, outcome: { meta: PartImageMeta } | { error: unknown }): void {
    if (waiter.settled) return;
    waiter.settled = true;
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
    if ('meta' in outcome) waiter.resolve(outcome.meta);
    else waiter.reject(outcome.error);
  }

  private cancel(partId: number, waiter: Waiter): void {
    if (waiter.settled) return;
    if (waiter.flight) {
      waiter.flight.waiting -= 1;
      if (waiter.flight.waiting === 0) waiter.flight.controller.abort();
    } else {
      const list = (this.queued.get(partId) ?? []).filter((w) => w !== waiter);
      if (list.length) this.queued.set(partId, list);
      else this.queued.delete(partId);
      if (this.queued.size === 0 && this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    }
    this.settle(waiter, { error: abortError() });
  }

  private flush(): void {
    this.timer = null;
    const queued = this.queued;
    this.queued = new Map();
    const ids = [...queued.keys()].sort((a, b) => a - b);
    for (let start = 0; start < ids.length; start += PART_IMAGE_BATCH_MAX) {
      this.send(ids.slice(start, start + PART_IMAGE_BATCH_MAX), queued);
    }
  }

  private send(ids: number[], queued: Map<number, Waiter[]>): void {
    const flight: Flight = { controller: new AbortController(), waiting: 0 };
    const waiters = ids.map((id) => [id, queued.get(id) ?? []] as const);
    for (const [, list] of waiters) {
      for (const waiter of list) {
        waiter.flight = flight;
        flight.waiting += 1;
      }
    }
    this.fetchMeta(ids, flight.controller.signal).then(
      (rows) => {
        const byId = new Map<number, PartImageMeta>();
        if (Array.isArray(rows)) for (const row of rows) if (isMeta(row)) byId.set(row.part_id, row);
        for (const [id, list] of waiters) {
          const row = byId.get(id);
          for (const waiter of list) {
            this.settle(waiter, row ? { meta: row } : { error: new Error(`No picture answer for part ${id}`) });
          }
        }
      },
      (error: unknown) => {
        for (const [, list] of waiters) for (const waiter of list) this.settle(waiter, { error });
      },
    );
  }
}

const batchers = new WeakMap<QueryClient, PartImageBatcher>();

/** The batcher of one QueryClient: a client of another session never shares its requests. */
export function partImageBatcher(queryClient: QueryClient): PartImageBatcher {
  let batcher = batchers.get(queryClient);
  if (!batcher) {
    batcher = new PartImageBatcher();
    batchers.set(queryClient, batcher);
  }
  return batcher;
}
