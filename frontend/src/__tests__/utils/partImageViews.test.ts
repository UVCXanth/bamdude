/**
 * The views a part's picture lives in (spec part-thumbnails §12.3; plan E5, D12): the author's own
 * write refreshes what the server event refreshes for everybody, and every E5 surface's query sits
 * under the event's keys — or a finished render would leave it «being prepared».
 */
import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { invalidatePartImageViews, ORDER_VIEW_KEYS, PART_IMAGE_VIEW_KEYS } from '../../utils/queryInvalidation';

const covered = (key: readonly unknown[]) =>
  PART_IMAGE_VIEW_KEYS.some((prefix) => prefix.every((part, index) => key[index] === part));

describe('invalidatePartImageViews', () => {
  it('refreshes every picture view and the order views', () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    invalidatePartImageViews(qc);
    const seen = spy.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
    for (const key of PART_IMAGE_VIEW_KEYS) expect(seen).toContain(JSON.stringify([...key]));
    // ORDER_VIEW_KEYS are prefixes as strings; `invalidateOrderViews` asks `[key]` of each
    for (const key of ORDER_VIEW_KEYS) expect(seen).toContain(JSON.stringify([key]));
  });
});

describe('the event reaches every E5 surface', () => {
  it.each([
    ['the product page — composition, merge, editor', ['product', 7]],
    ['the plates and files tab', ['product-file-groups', 7]],
    ['the free parts on the stock tab', ['product-stock', 7]],
    ['the product journal', ['stock-journal-page', { product_id: 7, book: 'both', page: 1 }]],
    ['the editor’s candidates', ['part-image-candidates', 3]],
  ])('%s', (_name, key) => {
    expect(covered(key)).toBe(true);
  });
});
