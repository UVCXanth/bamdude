/**
 * How the cached part pictures follow a change (spec procurement-stock-images R6, R8; A16, A19).
 *
 * A picture-only change re-reads every picture and keeps the last one on screen meanwhile. A
 * structural change of products P drops what is cached for P's parts — SQLite gives a deleted
 * part's id to the next one, and an old picture must never sit on the new part — and leaves
 * every other product's picture exactly as it was while it is read again.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import type { PartImageMeta } from '../../api/client';
import { PART_IMAGE_REFS_KEY, refreshPartImageRefs } from '../../utils/queryInvalidation';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

type Pending = { resolve: (meta: PartImageMeta) => void };

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } } });
}

/** One observed picture query whose reads the test answers by hand. */
function watch(qc: QueryClient, partId: number) {
  const reads: Pending[] = [];
  const observer = new QueryObserver<PartImageMeta>(qc, {
    queryKey: [PART_IMAGE_REFS_KEY, partId],
    queryFn: () => new Promise<PartImageMeta>((resolve) => reads.push({ resolve })),
  });
  const stop = observer.subscribe(() => {});
  return { observer, reads, stop, data: () => observer.getCurrentResult().data };
}

const ref = (partId: number, productId: number | null, v: string | null): PartImageMeta => ({
  part_id: partId,
  product_id: productId,
  image: v === null ? null : { kind: 'render', status: 'ready', v },
});

let clients: QueryClient[] = [];
afterEach(() => {
  clients.forEach((qc) => qc.clear());
  clients = [];
});
function make() {
  const qc = client();
  clients.push(qc);
  return qc;
}

describe('refreshPartImageRefs', () => {
  it('keeps every picture on screen while a picture-only change is read again', async () => {
    const qc = make();
    const part = watch(qc, 1);
    part.reads[0].resolve(ref(1, 10, 'a'));
    await tick();
    refreshPartImageRefs(qc);
    await tick();
    expect(part.reads).toHaveLength(2);
    expect(part.data()).toEqual(ref(1, 10, 'a'));
    part.reads[1].resolve(ref(1, 10, 'b'));
    await tick();
    expect(part.data()).toEqual(ref(1, 10, 'b'));
    part.stop();
  });

  it('starts a new read for a picture still on its first read — the old one may predate the change', async () => {
    const qc = make();
    const part = watch(qc, 1);
    refreshPartImageRefs(qc);
    await tick();
    expect(part.reads).toHaveLength(2);
    part.reads[0].resolve(ref(1, 10, 'before'));
    part.reads[1].resolve(ref(1, 10, 'after'));
    await tick();
    expect(part.data()).toEqual(ref(1, 10, 'after'));
    part.stop();
  });

  it('drops the picture of a part of the changed product and reads it again', async () => {
    const qc = make();
    const part = watch(qc, 50);
    part.reads[0].resolve(ref(50, 1, 'photo-of-A'));
    await tick();
    refreshPartImageRefs(qc, [1]);
    await tick();
    expect(part.data()).toBeUndefined(); // B's own embedded picture shows meanwhile, never A's
    part.reads[1].resolve(ref(50, 2, null));
    await tick();
    expect(part.data()).toEqual(ref(50, 2, null));
    part.stop();
  });

  it('never lets the late answer of a dropped read refill the cache', async () => {
    const qc = make();
    const part = watch(qc, 50);
    part.reads[0].resolve(ref(50, 1, 'a'));
    await tick();
    refreshPartImageRefs(qc); // a read in flight for 50 ...
    await tick();
    refreshPartImageRefs(qc, [1]); // ... and then its product changes structurally
    await tick();
    part.reads[1].resolve(ref(50, 1, 'stale'));
    await tick();
    expect(part.data()).toBeUndefined();
    part.reads[2].resolve(ref(50, 2, 'b'));
    await tick();
    expect(part.data()).toEqual(ref(50, 2, 'b'));
    part.stop();
  });

  it('leaves another product’s picture as it is while it is read again', async () => {
    const qc = make();
    const changed = watch(qc, 1);
    const other = watch(qc, 2);
    changed.reads[0].resolve(ref(1, 10, 'x'));
    other.reads[0].resolve(ref(2, 20, 'ready-after-a-render'));
    await tick();
    refreshPartImageRefs(qc, [10]);
    await tick();
    expect(changed.data()).toBeUndefined();
    expect(other.data()).toEqual(ref(2, 20, 'ready-after-a-render')); // not back to the DTO's «pending»
    expect(other.reads).toHaveLength(2);
    changed.stop();
    other.stop();
  });

  it('drops an entry whose product it does not know, and only that one', async () => {
    const qc = make();
    const unknown = watch(qc, 1);
    const known = watch(qc, 2);
    unknown.reads[0].resolve(ref(1, null, null));
    known.reads[0].resolve(ref(2, 20, 'k'));
    await tick();
    refreshPartImageRefs(qc, [10]);
    await tick();
    expect(unknown.observer.getCurrentResult().status).toBe('pending');
    expect(known.data()).toEqual(ref(2, 20, 'k'));
    unknown.stop();
    known.stop();
  });

  it('drops every entry when the change does not say which products it touched', async () => {
    const qc = make();
    const a = watch(qc, 1);
    const b = watch(qc, 2);
    a.reads[0].resolve(ref(1, 10, 'a'));
    b.reads[0].resolve(ref(2, 20, 'b'));
    await tick();
    refreshPartImageRefs(qc, 'all');
    await tick();
    expect(a.data()).toBeUndefined();
    expect(b.data()).toBeUndefined();
    a.stop();
    b.stop();
  });

  it('removes an inactive entry of the changed product and only marks another product’s stale', async () => {
    const qc = make();
    qc.setQueryData([PART_IMAGE_REFS_KEY, 1], ref(1, 10, 'a'));
    qc.setQueryData([PART_IMAGE_REFS_KEY, 2], ref(2, 20, 'b'));
    refreshPartImageRefs(qc, [10]);
    await tick();
    expect(qc.getQueryState([PART_IMAGE_REFS_KEY, 1])).toBeUndefined();
    expect(qc.getQueryData([PART_IMAGE_REFS_KEY, 2])).toEqual(ref(2, 20, 'b'));
    expect(qc.getQueryState([PART_IMAGE_REFS_KEY, 2])?.isInvalidated).toBe(true);
  });

  it('reads each active picture once per refresh', async () => {
    const qc = make();
    const changed = watch(qc, 1);
    const other = watch(qc, 2);
    changed.reads[0].resolve(ref(1, 10, 'x'));
    other.reads[0].resolve(ref(2, 20, 'y'));
    await tick();
    refreshPartImageRefs(qc, [10]);
    await tick();
    expect([changed.reads.length, other.reads.length]).toEqual([2, 2]);
    changed.stop();
    other.stop();
  });
});
