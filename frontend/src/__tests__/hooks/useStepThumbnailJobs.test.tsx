/**
 * The one polling owner of STEP thumbnail jobs (spec §5, plan A6): it asks only about receipts still active,
 * stops on a terminal, on an earlier epoch (410), on a receipt it may no longer read, on unmount and after its
 * bound — and never polls when nothing is active. Others learn through the ordinary library invalidation.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useStepThumbnailJobs } from '../../hooks/useStepThumbnailJobs';
import { server } from '../mocks/server';

const JOBS = '/api/v1/library/thumbnail-jobs';
const EPOCH = 'e'.repeat(32);

function callbacks() {
  return { onSucceeded: vi.fn(), onFailed: vi.fn(), onExpired: vi.fn() };
}

function answer(receipts: Array<Record<string, unknown>>, missing: string[] = []) {
  return HttpResponse.json({ jobs_epoch: EPOCH, receipts, missing });
}

afterEach(() => vi.useRealTimers());

describe('useStepThumbnailJobs', () => {
  it('never polls while nothing is active', async () => {
    const seen = vi.fn();
    server.use(http.get(JOBS, () => { seen(); return answer([]); }));
    renderHook(() => useStepThumbnailJobs(callbacks(), { pollMs: 10 }));
    await new Promise((r) => setTimeout(r, 80));
    expect(seen).not.toHaveBeenCalled();
  });

  it('asks about the receipts it tracks, reports success and stops', async () => {
    const asked: string[][] = [];
    let calls = 0;
    server.use(
      http.get(JOBS, ({ request }) => {
        const params = new URL(request.url).searchParams;
        expect(params.get('epoch')).toBe(EPOCH);
        asked.push(params.getAll('ids'));
        calls += 1;
        return answer([{ receipt_id: 'r1', file_id: 7, state: calls < 2 ? 'running' : 'succeeded', error_code: null }]);
      }),
    );
    const cb = callbacks();
    const { result } = renderHook(() => useStepThumbnailJobs(cb, { pollMs: 10 }));
    act(() => result.current.track(EPOCH, [{ receipt_id: 'r1', file_id: 7 }]));
    expect(result.current.activeFileIds.has(7)).toBe(true);
    await waitFor(() => expect(cb.onSucceeded).toHaveBeenCalledWith(7));
    await waitFor(() => expect(result.current.activeFileIds.has(7)).toBe(false)); // the set follows the callback
    const after = calls;
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toBe(after); // stopped: nothing active
    expect(asked[0]).toEqual(['r1']);
  });

  it('reports a failure with its closed reason', async () => {
    server.use(http.get(JOBS, () => answer([{ receipt_id: 'r1', file_id: 7, state: 'failed', error_code: 'cad_unavailable' }])));
    const cb = callbacks();
    const { result } = renderHook(() => useStepThumbnailJobs(cb, { pollMs: 10 }));
    act(() => result.current.track(EPOCH, [{ receipt_id: 'r1', file_id: 7 }]));
    await waitFor(() => expect(cb.onFailed).toHaveBeenCalledWith(7, 'cad_unavailable'));
    expect(cb.onSucceeded).not.toHaveBeenCalled();
  });

  it('an earlier epoch (410) ends every receipt of it as expired', async () => {
    server.use(http.get(JOBS, () => HttpResponse.json({ detail: { error: 'preview_job_expired', message: 'x' } }, { status: 410 })));
    const cb = callbacks();
    const { result } = renderHook(() => useStepThumbnailJobs(cb, { pollMs: 10 }));
    act(() => result.current.track(EPOCH, [{ receipt_id: 'r1', file_id: 7 }, { receipt_id: 'r2', file_id: 8 }]));
    await waitFor(() => expect(cb.onExpired).toHaveBeenCalledTimes(2));
    expect(result.current.activeFileIds.size).toBe(0);
  });

  it('reports everything one poll ended together, once', async () => {
    server.use(
      http.get(JOBS, () =>
        answer(
          [
            { receipt_id: 'r1', file_id: 7, state: 'succeeded', error_code: null },
            { receipt_id: 'r2', file_id: 8, state: 'failed', error_code: 'cad_unavailable' },
          ],
          ['r3'],
        ),
      ),
    );
    const onSettled = vi.fn();
    const cb = { ...callbacks(), onSettled };
    const { result } = renderHook(() => useStepThumbnailJobs(cb, { pollMs: 10 }));
    act(() =>
      result.current.track(EPOCH, [
        { receipt_id: 'r1', file_id: 7 },
        { receipt_id: 'r2', file_id: 8 },
        { receipt_id: 'r3', file_id: 9 },
      ]),
    );
    await waitFor(() => expect(onSettled).toHaveBeenCalled());
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith({
      succeeded: [7],
      failed: [{ fileId: 8, code: 'cad_unavailable' }],
      expired: [9],
    });
  });

  it('an earlier epoch (410) is one report for all its receipts', async () => {
    server.use(http.get(JOBS, () => HttpResponse.json({ detail: { error: 'preview_job_expired', message: 'x' } }, { status: 410 })));
    const onSettled = vi.fn();
    const cb = { ...callbacks(), onSettled };
    const { result } = renderHook(() => useStepThumbnailJobs(cb, { pollMs: 10 }));
    act(() => result.current.track(EPOCH, [{ receipt_id: 'r1', file_id: 7 }, { receipt_id: 'r2', file_id: 8 }]));
    await waitFor(() => expect(onSettled).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 40));
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith({ succeeded: [], failed: [], expired: [7, 8] });
  });

  it('a receipt it may no longer read shows no result, only a re-read', async () => {
    server.use(http.get(JOBS, () => answer([], ['r1'])));
    const cb = callbacks();
    const { result } = renderHook(() => useStepThumbnailJobs(cb, { pollMs: 10 }));
    act(() => result.current.track(EPOCH, [{ receipt_id: 'r1', file_id: 7 }]));
    await waitFor(() => expect(cb.onExpired).toHaveBeenCalledWith(7));
    expect(cb.onSucceeded).not.toHaveBeenCalled();
    expect(cb.onFailed).not.toHaveBeenCalled();
  });

  it('stops on unmount', async () => {
    let calls = 0;
    server.use(http.get(JOBS, () => { calls += 1; return answer([{ receipt_id: 'r1', file_id: 7, state: 'queued', error_code: null }]); }));
    const { result, unmount } = renderHook(() => useStepThumbnailJobs(callbacks(), { pollMs: 10 }));
    act(() => result.current.track(EPOCH, [{ receipt_id: 'r1', file_id: 7 }]));
    await waitFor(() => expect(calls).toBeGreaterThan(0));
    unmount();
    const after = calls;
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toBeLessThanOrEqual(after + 1); // at most the request already in flight
  });

  it('gives up after its bound and reports the job expired', async () => {
    server.use(http.get(JOBS, () => answer([{ receipt_id: 'r1', file_id: 7, state: 'queued', error_code: null }])));
    const cb = callbacks();
    const { result } = renderHook(() => useStepThumbnailJobs(cb, { pollMs: 10, maxMs: 60 }));
    act(() => result.current.track(EPOCH, [{ receipt_id: 'r1', file_id: 7 }]));
    await waitFor(() => expect(cb.onExpired).toHaveBeenCalledWith(7));
    expect(result.current.activeFileIds.size).toBe(0);
  });

  it('asks at most 64 receipts per request', async () => {
    const sizes: number[] = [];
    server.use(
      http.get(JOBS, ({ request }) => {
        const ids = new URL(request.url).searchParams.getAll('ids');
        sizes.push(ids.length);
        return answer(ids.map((id, i) => ({ receipt_id: id, file_id: i, state: 'succeeded', error_code: null })));
      }),
    );
    const cb = callbacks();
    const { result } = renderHook(() => useStepThumbnailJobs(cb, { pollMs: 10 }));
    const many = Array.from({ length: 70 }, (_, i) => ({ receipt_id: `r${i}`, file_id: i }));
    act(() => result.current.track(EPOCH, many));
    await waitFor(() => expect(cb.onSucceeded).toHaveBeenCalledTimes(70));
    expect(Math.max(...sizes)).toBeLessThanOrEqual(64);
  });

  it('a cancel too late answers cancel_too_late and keeps the job', async () => {
    server.use(
      http.get(JOBS, () => answer([{ receipt_id: 'r1', file_id: 7, state: 'running', error_code: null }])),
      http.delete(`${JOBS}/r1`, () => HttpResponse.json({ detail: { error: 'cancel_too_late', message: 'x' } }, { status: 409 })),
    );
    const { result } = renderHook(() => useStepThumbnailJobs(callbacks(), { pollMs: 1000 }));
    act(() => result.current.track(EPOCH, [{ receipt_id: 'r1', file_id: 7 }]));
    let code: string | null = null;
    await act(async () => { code = await result.current.cancel(7); });
    expect(code).toBe('cancel_too_late');
    expect(result.current.activeFileIds.has(7)).toBe(true);
  });

  it('a cancel that finds the job already finished reports its result, never a cancel', async () => {
    server.use(
      http.get(JOBS, () => answer([{ receipt_id: 'r1', file_id: 7, state: 'running', error_code: null }])),
      http.delete(`${JOBS}/r1`, () => HttpResponse.json({ receipt_id: 'r1', file_id: 7, state: 'succeeded', error_code: null })),
    );
    const onSettled = vi.fn();
    const cb = { ...callbacks(), onSettled };
    const { result } = renderHook(() => useStepThumbnailJobs(cb, { pollMs: 1000 }));
    act(() => result.current.track(EPOCH, [{ receipt_id: 'r1', file_id: 7 }]));
    let code: string | null = null;
    await act(async () => { code = await result.current.cancel(7); });
    expect(code).toBe('finished');
    expect(cb.onSucceeded).toHaveBeenCalledWith(7);
    expect(onSettled).toHaveBeenCalledWith({ succeeded: [7], failed: [], expired: [] });
    expect(result.current.activeFileIds.has(7)).toBe(false);
  });

  it('a cancel the server knows nothing about (404) is the job gone, not the service down', async () => {
    server.use(
      http.get(JOBS, () => answer([{ receipt_id: 'r1', file_id: 7, state: 'queued', error_code: null }])),
      http.delete(`${JOBS}/r1`, () => HttpResponse.json({ detail: 'Not found' }, { status: 404 })),
    );
    const onSettled = vi.fn();
    const cb = { ...callbacks(), onSettled };
    const { result } = renderHook(() => useStepThumbnailJobs(cb, { pollMs: 1000 }));
    act(() => result.current.track(EPOCH, [{ receipt_id: 'r1', file_id: 7 }]));
    let code: string | null = null;
    await act(async () => { code = await result.current.cancel(7); });
    expect(code).toBe('job_expired');
    expect(cb.onExpired).toHaveBeenCalledWith(7);
    expect(onSettled).toHaveBeenCalledWith({ succeeded: [], failed: [], expired: [7] });
  });

  it('a cancel that lands detaches the receipt', async () => {
    server.use(
      http.get(JOBS, () => answer([{ receipt_id: 'r1', file_id: 7, state: 'queued', error_code: null }])),
      http.delete(`${JOBS}/r1`, ({ request }) => {
        expect(new URL(request.url).searchParams.get('epoch')).toBe(EPOCH);
        return HttpResponse.json({ receipt_id: 'r1', file_id: 7, state: 'canceled', error_code: null });
      }),
    );
    const { result } = renderHook(() => useStepThumbnailJobs(callbacks(), { pollMs: 1000 }));
    act(() => result.current.track(EPOCH, [{ receipt_id: 'r1', file_id: 7 }]));
    let code: string | null = 'x';
    await act(async () => { code = await result.current.cancel(7); });
    expect(code).toBeNull();
    expect(result.current.activeFileIds.has(7)).toBe(false);
  });
it('a receipt tracked just as the last one ended is still polled to its end', async () => {
    server.use(
      http.get(JOBS, ({ request }) => {
        const ids = new URL(request.url).searchParams.getAll('ids');
        return answer(ids.map((id) => ({ receipt_id: id, file_id: id === 'r1' ? 7 : 8, state: 'succeeded', error_code: null })));
      }),
    );
    const cb = callbacks();
    const { result } = renderHook(() => useStepThumbnailJobs(cb, { pollMs: 10 }));
    cb.onSucceeded.mockImplementation((fileId: number) => {
      // lands after the tick emptied the set and before React re-renders: the two updates batch into one
      if (fileId === 7) queueMicrotask(() => result.current.track(EPOCH, [{ receipt_id: 'r2', file_id: 8 }]));
    });
    act(() => result.current.track(EPOCH, [{ receipt_id: 'r1', file_id: 7 }]));
    await waitFor(() => expect(cb.onSucceeded).toHaveBeenCalledWith(8), { timeout: 2000 });
    await waitFor(() => expect(result.current.activeFileIds.size).toBe(0));
  });
});
