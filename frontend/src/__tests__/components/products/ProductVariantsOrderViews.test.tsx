/**
 * A variant change reaches the orders: their lines name the options they
 * chose, and a new group adds a choice to each (spec workshop-product-variants).
 */

import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { render } from '../../utils';
import { api } from '../../../api/client';
import type { Product } from '../../../api/client';
import { ProductVariants } from '../../../components/products/ProductVariants';
import { invalidateOrderViews } from '../../../utils/queryInvalidation';

vi.mock('../../../utils/queryInvalidation', async (original) => ({
  ...(await original<typeof import('../../../utils/queryInvalidation')>()),
  invalidateOrderViews: vi.fn(),
}));

const product = { id: 7, name: 'Pipe', parts: [], variant_groups: [] } as unknown as Product;

describe('ProductVariants → orders', () => {
  it('refreshes the order views after a change', async () => {
    vi.spyOn(api, 'createVariantGroup').mockResolvedValue(product);
    render(<ProductVariants product={product} canEdit />);
    fireEvent.change(screen.getByLabelText('New group'), { target: { value: 'Tail' } });
    fireEvent.change(screen.getByLabelText('Options, comma-separated'), { target: { value: 'a, b' } });
    fireEvent.click(screen.getByRole('button', { name: /add group/i }));
    await waitFor(() => expect(invalidateOrderViews).toHaveBeenCalled());
  });
});
