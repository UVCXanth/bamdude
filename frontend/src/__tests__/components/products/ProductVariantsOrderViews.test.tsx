/**
 * A variant change reaches the orders: their lines name the options they
 * chose, and a new group adds a choice to each (spec workshop-product-variants) —
 * and to every stock position. One helper decides the keys (WS-13 E1 CL4); what it
 * marks stale is pinned in `utils/queryInvalidation.test.ts`. The manager's save
 * goes through it (WS-13 E10 D05).
 */

import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { render } from '../../utils';
import { api } from '../../../api/client';
import type { Product } from '../../../api/client';
import { ProductVariantsDialog } from '../../../components/products/ProductVariantsDialog';
import { invalidateProductVariants } from '../../../utils/queryInvalidation';

vi.mock('../../../utils/queryInvalidation', async (original) => ({
  ...(await original<typeof import('../../../utils/queryInvalidation')>()),
  invalidateProductVariants: vi.fn(),
}));

const product = {
  id: 7,
  code: 'PR-0007',
  name: 'Pipe',
  parts: [],
  variant_groups: [],
  variants_revision: 'rev-1',
} as unknown as Product;

describe('ProductVariantsDialog → orders', () => {
  it('refreshes the order and stock views after a change', async () => {
    vi.spyOn(api, 'applyProductVariants').mockResolvedValue(product);
    render(<ProductVariantsDialog product={product} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add group' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(invalidateProductVariants).toHaveBeenCalledWith(expect.anything(), 7));
  });
});
