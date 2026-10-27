/**
 * The batch read's transport (spec procurement-stock-images R5, A15, A18): one tick of `load` calls
 * becomes one request per 200 parts, each waiter gets its own part's answer, and a cancelled waiter
 * never takes its neighbours down — nor holds a request nobody waits for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { PartImageMeta } from '../../api/client';
import { PartImageBatcher, partImageBatcher } from '../../utils/partImageBatch';

const meta = (id: number, v = `v${id}`): PartImageMeta => ({
  part_id: id,
  product_id: 9,
  image: { kind: 'photo', status: 'ready', v },
});

type Call = { ids: number[]; signal: AbortSignal; resolve: (rows: unknown) => void; reject: (e: unknown) => void };

function harness() {
  const calls: Call[] = [];
  const fetchMeta = vi.fn(
    (ids: readonly number[], signal: AbortSignal) =>
      new Promise<unknown>((resolve, reject) => calls.push({ ids: [...ids], signal, resolve, reject })),
  );
  return { calls, fetchMeta, batcher: new PartImageBatcher(fetchMeta) };
}

const answer = (call: Call, rows?: PartImageMeta[]) => call.resolve(rows ?? call.ids.map((id) => meta(id)));

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('PartImageBatcher', () => {
  it('sends one tick of loads as one request, each id once', async () => {
    const { calls, batcher } = harness();
    const asked = [7, 3, 7, 5].map((id) => batcher.load(id));
    expect(calls).toHaveLength(0); // nothing before the tick ends
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((c) => c.ids)).toEqual([[3, 5, 7]]);
    answer(calls[0]);
    expect(await Promise.all(asked)).toEqual([meta(7), meta(3), meta(7), meta(5)]);
  });

  it('gives a hundred parts one request and cuts more into chunks of 200', async () => {
    const { calls, batcher } = harness();
    const hundred = Array.from({ length: 100 }, (_, i) => batcher.load(i + 1));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    answer(calls[0]);
    await Promise.all(hundred);

    const many = Array.from({ length: 450 }, (_, i) => batcher.load(1000 + i));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.slice(1).map((c) => c.ids.length)).toEqual([200, 200, 50]);
    calls.slice(1).forEach((call) => answer(call));
    expect(await Promise.all(many)).toHaveLength(450);
  });

  it('fails only the chunk that failed', async () => {
    const { calls, batcher } = harness();
    const asked = Array.from({ length: 250 }, (_, i) => batcher.load(i + 1).then(() => 'ok', () => 'failed'));
    await vi.advanceTimersByTimeAsync(0);
    calls[0].reject(new Error('502'));
    answer(calls[1]);
    const outcomes = await Promise.all(asked);
    expect(outcomes.slice(0, 200).every((o) => o === 'failed')).toBe(true);
    expect(outcomes.slice(200).every((o) => o === 'ok')).toBe(true);
  });

  it('treats a part missing from the answer, or a malformed answer, as an error — never as «no picture»', async () => {
    const { calls, batcher } = harness();
    const kept = batcher.load(1);
    const missing = batcher.load(2);
    await vi.advanceTimersByTimeAsync(0);
    answer(calls[0], [meta(1)]);
    expect(await kept).toEqual(meta(1));
    await expect(missing).rejects.toThrow();

    for (const bad of [{ rows: [] }, [{ part_id: '3', product_id: 9, image: null }], [{ part_id: 3, product_id: 9, image: 'x' }]]) {
      const asked = batcher.load(3);
      await vi.advanceTimersByTimeAsync(0);
      calls[calls.length - 1].resolve(bad);
      await expect(asked).rejects.toThrow();
    }
  });

  it('keeps an explicit «no picture» as an answer', async () => {
    const { calls, batcher } = harness();
    const asked = batcher.load(4);
    await vi.advanceTimersByTimeAsync(0);
    answer(calls[0], [{ part_id: 4, product_id: null, image: null }]);
    expect(await asked).toEqual({ part_id: 4, product_id: null, image: null });
  });

  it('never sends a part whose waiter was cancelled before the tick ended', async () => {
    const { calls, batcher } = harness();
    const gone = new AbortController();
    const cancelled = batcher.load(1, gone.signal);
    const kept = batcher.load(2);
    gone.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((c) => c.ids)).toEqual([[2]]);
    answer(calls[0]);
    expect(await kept).toEqual(meta(2));
  });

  it('sends nothing and leaves no timer when every waiter of the tick was cancelled', async () => {
    const { calls, batcher } = harness();
    const gone = new AbortController();
    const asked = [batcher.load(1, gone.signal), batcher.load(2, gone.signal)];
    gone.abort();
    await Promise.allSettled(asked);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(0);
  });

  it('lets the neighbours of a waiter cancelled in flight get their answers', async () => {
    const { calls, batcher } = harness();
    const gone = new AbortController();
    const cancelled = batcher.load(1, gone.signal);
    const kept = batcher.load(2);
    await vi.advanceTimersByTimeAsync(0);
    gone.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls[0].signal.aborted).toBe(false); // the request still has a waiter
    answer(calls[0]);
    expect(await kept).toEqual(meta(2));
  });

  it('aborts a request once nobody waits for it', async () => {
    const { calls, batcher } = harness();
    const a = new AbortController();
    const b = new AbortController();
    const asked = [batcher.load(1, a.signal), batcher.load(2, b.signal)];
    await vi.advanceTimersByTimeAsync(0);
    a.abort();
    expect(calls[0].signal.aborted).toBe(false);
    b.abort();
    expect(calls[0].signal.aborted).toBe(true);
    await Promise.allSettled(asked);
  });

  it('starts a new request for a part asked again after its waiter was cancelled — never the doomed one', async () => {
    const { calls, batcher } = harness();
    const gone = new AbortController();
    const first = batcher.load(5, gone.signal);
    const neighbour = batcher.load(6);
    await vi.advanceTimersByTimeAsync(0);
    gone.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const again = batcher.load(5);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((c) => c.ids)).toEqual([[5, 6], [5]]);
    answer(calls[0], [meta(5, 'old'), meta(6)]); // the late answer of the first wave
    answer(calls[1], [meta(5, 'new')]);
    expect(await again).toEqual(meta(5, 'new'));
    expect(await neighbour).toEqual(meta(6));
  });

  it('refuses at once a load whose signal is already aborted', async () => {
    const { calls, batcher } = harness();
    const gone = new AbortController();
    gone.abort();
    await expect(batcher.load(1, gone.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(0);
  });

  it('leaves no abort listener behind once a waiter has its answer', async () => {
    const { calls, batcher } = harness();
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, 'addEventListener');
    const removed = vi.spyOn(controller.signal, 'removeEventListener');
    const asked = batcher.load(1, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    answer(calls[0]);
    await asked;
    expect(added).toHaveBeenCalledTimes(1);
    expect(removed).toHaveBeenCalledWith('abort', added.mock.calls[0][1]);
  });

  it('belongs to one QueryClient', () => {
    const one = new QueryClient();
    const other = new QueryClient();
    expect(partImageBatcher(one)).toBe(partImageBatcher(one));
    expect(partImageBatcher(one)).not.toBe(partImageBatcher(other));
  });
});
