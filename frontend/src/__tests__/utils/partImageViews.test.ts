/**
 * The views a part's picture lives in (spec part-thumbnails §12.3; plan E5, D12): the author's own
 * write refreshes what the server event refreshes for everybody, and every E5 surface's query sits
 * under the event's keys — or a finished render would leave it «being prepared». A picture-only
 * write refreshes the pictures and the product views, never a stock or order figure (spec
 * procurement-stock-images R6): those views read their pictures through `LivePartThumb`.
 */
import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  invalidatePartImageViews,
  ORDER_VIEW_KEYS,
  PART_IMAGE_PURE_KEYS,
  PART_IMAGE_REFS_KEY,
  PART_IMAGE_VIEW_KEYS,
  STOCK_KEYS,
} from '../../utils/queryInvalidation';

const covered = (key: readonly unknown[]) =>
  PART_IMAGE_VIEW_KEYS.some((prefix) => prefix.every((part, index) => key[index] === part));

describe('invalidatePartImageViews', () => {
  it('refreshes the pictures and the product views — and no stock or order figure', () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    invalidatePartImageViews(qc);
    const seen = spy.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
    for (const key of PART_IMAGE_PURE_KEYS) expect(seen).toContain(JSON.stringify([...key]));
    expect(seen).toContain(JSON.stringify([PART_IMAGE_REFS_KEY]));
    const pure = new Set(PART_IMAGE_PURE_KEYS.map((key) => JSON.stringify([...key])));
    const figures = [...STOCK_KEYS.map((key) => [...key]), ...ORDER_VIEW_KEYS.map((key) => [key])]
      .map((key) => JSON.stringify(key))
      .filter((key) => !pure.has(key));
    expect(seen.filter((key) => figures.includes(key as string))).toEqual([]);
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

// A structural event refreshes PART_IMAGE_VIEW_KEYS and, through `invalidateProjectViews`, every ORDER_VIEW_KEYS
// prefix; a picture-only one reaches these surfaces through `LivePartThumb` (`partThumbLiveReaders.test.ts`).
const coveredByEvent = (key: readonly unknown[]) => covered(key) || (ORDER_VIEW_KEYS as readonly unknown[]).includes(key[0]);

describe('the event reaches every E6 surface', () => {
  it.each([
    ['an order — its lines, the line editor, «Surplus to free stock»', ['project', 5]],
    ['the line’s configuration — the product it reads its pictures from (D5)', ['product', 7]],
    ['the plan', ['project-plan', 5]],
    ['the plates the plan projects its surplus from', ['product-plates', 7]],
    ['the issue dialog', ['project-fulfilment', 5]],
    ['the parts tab of «Add to order»', ['product-parts', { q: '', page: 1 }]],
    ['the stock page', ['stock-summary', { page: 1 }]],
    ['a position', ['stock-item', 5]],
    ['the assembly dialog’s lookup', ['stock-lookup', 1, '100']],
    ['the stock page’s journal', ['stock-journal-page', { book: 'both', page: 1 }]],
  ])('%s', (_name, key) => {
    expect(coveredByEvent(key)).toBe(true);
  });
});
