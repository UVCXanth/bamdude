/**
 * Which products may be offered for binding.
 *
 * ⚠️ **The trap this is mostly here to pin:** a row already bound must stay on
 * the list even when it is out of the catalog. Hiding it renders the field as
 * "nothing chosen", and the next save writes that emptiness back — the filter
 * would quietly destroy the binding it was meant to tidy around. (Orders follow
 * the same rule on the server side of `OrderChoice`: active orders are searched,
 * the bound one keeps its own label — WS-13 E13 D01.)
 */

import { describe, it, expect } from 'vitest';
import { selectableProducts } from '../../utils/projects';

describe('selectableProducts', () => {
  const IN = { id: 1, is_active: true };
  const OUT = { id: 2, is_active: false };

  it('offers catalog products only, plus the bound one', () => {
    expect(selectableProducts([IN, OUT])).toEqual([IN]);
    expect(selectableProducts([IN, OUT], [2])).toEqual([IN, OUT]);
  });

  it('treats a missing flag as in the catalog', () => {
    expect(selectableProducts([{ id: 3 }])).toEqual([{ id: 3 }]);
  });

  it('tolerates empty input', () => {
    expect(selectableProducts(undefined)).toEqual([]);
    expect(selectableProducts(null)).toEqual([]);
  });

  it('hides adhoc products unless the row already links them', () => {
    const products = [
      { id: 1, is_active: true, origin: 'catalog' as const },
      { id: 2, is_active: true, origin: 'adhoc_job' as const },
      { id: 3, is_active: true, origin: 'adhoc_plate' as const },
    ];
    expect(selectableProducts(products).map((p) => p.id)).toEqual([1]);
    expect(selectableProducts(products, [3]).map((p) => p.id)).toEqual([1, 3]);
    // A row from an older server carries no origin and stays selectable.
    expect(selectableProducts([{ id: 4, is_active: true }]).map((p) => p.id)).toEqual([4]);
  });
});
