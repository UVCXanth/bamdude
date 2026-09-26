/**
 * Every mutation that creates a product or changes its files refreshes the
 * catalog's server figures through ONE helper (spec workshop-product-catalog):
 * the list, the drafts badge in the sidebar, the filter choices and the
 * directory's counts. Refreshing only `['products']` left the badge up to a
 * minute behind a duplicate — which always makes a new draft — and a newly
 * linked material missing from the filter until its `staleTime` ran out.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { QueryClient } from '@tanstack/react-query';
import { invalidateAfterDelete, invalidateProductCatalog } from '../../utils/queryInvalidation';

const SRC = join(process.cwd(), 'src');
/** A call that makes a product, or moves a file into or out of one. */
const CATALOG_MUTATION = /api\.(createProduct|createProductFromFile|duplicateProduct|importProduct)\(|product_ids: productIds/;

function walk(dir: string, out: string[] = []): string[] {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) {
      if (d.name !== '__tests__') walk(p, out);
    } else if (d.name.endsWith('.tsx')) {
      out.push(p);
    }
  }
  return out;
}

function seed(qc: QueryClient, keys: unknown[][]) {
  for (const key of keys) qc.setQueryData(key, { seeded: true });
}

function stale(qc: QueryClient, key: unknown[]) {
  return qc.getQueryState(key)?.isInvalidated === true;
}

describe('invalidateProductCatalog', () => {
  it('refreshes the list, the drafts badge, the filter choices and the directory — nothing else', () => {
    const qc = new QueryClient();
    const keys = [['products', { page: 1 }], ['projects', 'nav-badges'], ['product-facets'], ['product-categories']];
    seed(qc, [...keys, ['projects', { page: 1 }], ['product', 7]]);
    invalidateProductCatalog(qc);
    for (const key of keys) expect(stale(qc, key)).toBe(true);
    // The orders list and an open product page are not the catalog's figures.
    expect(stale(qc, ['projects', { page: 1 }])).toBe(false);
    expect(stale(qc, ['product', 7])).toBe(false);
  });

  it('a deleted product takes its facets and its category count with it', () => {
    const qc = new QueryClient();
    seed(qc, [['product-facets'], ['product-categories']]);
    invalidateAfterDelete(qc, 'product');
    expect(stale(qc, ['product-facets'])).toBe(true);
    expect(stale(qc, ['product-categories'])).toBe(true);
  });

  it('every mutation that makes a product or changes its files goes through it', () => {
    const offenders = walk(SRC)
      .filter((file) => {
        const text = readFileSync(file, 'utf8');
        return CATALOG_MUTATION.test(text) && !text.includes('invalidateProductCatalog(');
      })
      .map((file) => relative(SRC, file).split(sep).join('/'));
    expect(offenders).toEqual([]);
  });
});
