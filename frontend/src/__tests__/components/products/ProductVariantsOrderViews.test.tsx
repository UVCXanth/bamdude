/**
 * A variant change reaches the orders: their lines name the options they
 * chose, and a new group adds a choice to each (spec workshop-product-variants) —
 * and to every stock position. One helper decides the keys (WS-13 E1 CL4); what it
 * marks stale is pinned in `utils/queryInvalidation.test.ts`.
 */

import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { render } from '../../utils';
import { api } from '../../../api/client';
import type { Product } from '../../../api/client';
import { ProductVariants } from '../../../components/products/ProductVariants';
import { invalidateProductVariants } from '../../../utils/queryInvalidation';

vi.mock('../../../utils/queryInvalidation', async (original) => ({
  ...(await original<typeof import('../../../utils/queryInvalidation')>()),
  invalidateProductVariants: vi.fn(),
}));

const product = { id: 7, name: 'Pipe', parts: [], variant_groups: [] } as unknown as Product;

describe('ProductVariants → orders', () => {
  it('refreshes the order and stock views after a change', async () => {
    vi.spyOn(api, 'createVariantGroup').mockResolvedValue(product);
    render(<ProductVariants product={product} canEdit />);
    fireEvent.change(screen.getByLabelText('New group'), { target: { value: 'Tail' } });
    fireEvent.change(screen.getByLabelText('Options, comma-separated'), { target: { value: 'a, b' } });
    fireEvent.click(screen.getByRole('button', { name: /add group/i }));
    await waitFor(() => expect(invalidateProductVariants).toHaveBeenCalledWith(expect.anything(), 7));
  });
});
