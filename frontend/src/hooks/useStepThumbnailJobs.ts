import { useCallback, useEffect, useRef, useState } from 'react';

import { api, ApiError, type ThumbnailJobItem } from '../api/client';

/**
 * The one polling owner of STEP thumbnail jobs on a page (spec §5, plan A6).
 *
 * It asks only about receipts still active, in requests of at most 64, backing off from `pollMs` to five times
 * it, and stops when a receipt ends, when its epoch is an earlier session's (410), when the server no longer lets
 * this caller read it (`missing` — no result is shown, the file is read again), on unmount, and after `maxMs`:
 * no job outlives its 30-minute wait plus its 10-minute wall, so a receipt older than that is over whatever the
 * server last said. Everyone else learns through the ordinary library invalidation the callbacks trigger.
 */

export const POLL_MS = 2000;
export const TRACK_MAX_MS = 40 * 60_000;
const BATCH = 64;
const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);

export interface StepThumbnailCallbacks {
  onSucceeded: (fileId: number) => void;
  onFailed: (fileId: number, code: string | null) => void;
  /** The job is gone for this caller (earlier session, access lost, bound passed): read the file again. */
  onExpired: (fileId: number) => void;
}

interface Tracked {
  receiptId: string;
  fileId: number;
  epoch: string;
  since: number;
}

type Trackable = Pick<ThumbnailJobItem, 'file_id'> & { receipt_id: string | null };

export function useStepThumbnailJobs(
  callbacks: StepThumbnailCallbacks,
  options: { pollMs?: number; maxMs?: number } = {},
) {
  const pollMs = options.pollMs ?? POLL_MS;
  const maxMs = options.maxMs ?? TRACK_MAX_MS;
  const tracked = useRef(new Map<string, Tracked>());
  const callbacksRef = useRef(callbacks);
  const [activeFileIds, setActiveFileIds] = useState<ReadonlySet<number>>(() => new Set());

  useEffect(() => {
    callbacksRef.current = callbacks;
  }, [callbacks]);

  const sync = useCallback(() => {
    setActiveFileIds(new Set([...tracked.current.values()].map((item) => item.fileId)));
  }, []);

  const track = useCallback(
    (epoch: string, items: Trackable[]) => {
      const now = Date.now();
      for (const item of items) {
        if (item.receipt_id) {
          tracked.current.set(item.receipt_id, { receiptId: item.receipt_id, fileId: item.file_id, epoch, since: now });
        }
      }
      sync();
    },
    [sync],
  );

  const hasActive = activeFileIds.size > 0;

  useEffect(() => {
    if (!hasActive) return;
    let stopped = false;
    let delay = pollMs;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      const now = Date.now();
      for (const [id, item] of tracked.current) {
        if (now - item.since > maxMs) {
          tracked.current.delete(id);
          callbacksRef.current.onExpired(item.fileId);
        }
      }
      const byEpoch = new Map<string, Tracked[]>();
      for (const item of tracked.current.values()) {
        byEpoch.set(item.epoch, [...(byEpoch.get(item.epoch) ?? []), item]);
      }
      for (const [epoch, items] of byEpoch) {
        for (let start = 0; start < items.length; start += BATCH) {
          const chunk = items.slice(start, start + BATCH);
          let status;
          try {
            status = await api.getThumbnailJobs(epoch, chunk.map((item) => item.receiptId));
          } catch (error) {
            if (stopped) return;
            if (error instanceof ApiError && error.status === 410) {
              for (const item of items) {
                if (tracked.current.delete(item.receiptId)) callbacksRef.current.onExpired(item.fileId);
              }
              break;
            }
            continue; // a transient failure: keep the receipts, back off
          }
          if (stopped) return;
          for (const receipt of status.receipts) {
            const item = receipt.receipt_id ? tracked.current.get(receipt.receipt_id) : undefined;
            if (!item || !receipt.state || !TERMINAL.has(receipt.state)) continue;
            tracked.current.delete(item.receiptId);
            if (receipt.state === 'succeeded') callbacksRef.current.onSucceeded(item.fileId);
            else if (receipt.state === 'failed') callbacksRef.current.onFailed(item.fileId, receipt.error_code);
          }
          for (const id of status.missing) {
            const item = tracked.current.get(id);
            if (item) {
              tracked.current.delete(id);
              callbacksRef.current.onExpired(item.fileId);
            }
          }
        }
      }
      if (stopped) return;
      sync();
      if (tracked.current.size > 0) {
        delay = Math.min(Math.round(delay * 1.5), pollMs * 5);
        timer = setTimeout(tick, delay);
      }
    };

    timer = setTimeout(tick, delay);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [hasActive, pollMs, maxMs, sync]);

  /** Detach this caller's receipt for a file. Null when it landed, else the closed reason (cancel_too_late…). */
  const cancel = useCallback(
    async (fileId: number): Promise<string | null> => {
      const item = [...tracked.current.values()].find((entry) => entry.fileId === fileId);
      if (!item) return null;
      try {
        await api.cancelThumbnailJob(item.receiptId, item.epoch);
      } catch (error) {
        if (error instanceof ApiError && error.status === 410) {
          tracked.current.delete(item.receiptId);
          sync();
          callbacksRef.current.onExpired(fileId);
          return 'job_expired';
        }
        if (error instanceof ApiError && error.code) return error.code;
        return 'unavailable';
      }
      tracked.current.delete(item.receiptId);
      sync();
      return null;
    },
    [sync],
  );

  return { track, cancel, activeFileIds };
}
