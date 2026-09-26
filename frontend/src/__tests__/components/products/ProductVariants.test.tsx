/**
 * The variants section of a product (spec workshop-product-variants, rules 18,
 * 24–25): groups with their options, the standard picked by a radio, and a
 * delete the server would refuse shown disabled with the reason beforehand.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { render } from '../../utils';
import { api } from '../../../api/client';
import type { Product } from '../../../api/client';
import { ProductVariants } from '../../../components/products/ProductVariants';
import { CompositionTable } from '../../../components/products/CompositionTable';

const product = {
  id: 7,
  name: 'Pipe',
  parts: [
    {
      id: 5,
      kind: 'printed',
      name: 'tail',
      name_key: 'tail',
      qty_per_unit: 1,
      aliases: ['tail'],
      auto: false,
      unit_price: null,
      sourcing_url: null,
      remarks: null,
      sort_order: 0,
      stock_balance: 0,
      variant_option_id: null,
    },
  ],
  variant_groups: [
    {
      id: 3,
      name: 'Хвіст',
      position: 0,
      default_option_id: 11,
      options: [
        { id: 11, name: 'прямий', position: 0, lines_count: 0, parts_count: 0 },
        { id: 12, name: 'кутовий', position: 1, lines_count: 2, parts_count: 0 },
      ],
    },
  ],
} as unknown as Product;

describe('ProductVariants', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows each group with its options and the standard one checked', () => {
    render(<ProductVariants product={product} canEdit />);
    const group = screen.getByTestId('variant-group-3');
    expect(within(group).getByDisplayValue('Хвіст')).toBeInTheDocument();
    expect(within(group).getByDisplayValue('прямий')).toBeInTheDocument();
    expect(within(group).getByDisplayValue('кутовий')).toBeInTheDocument();
    expect(screen.getByTestId('variant-option-11-standard')).toBeChecked();
    expect(screen.getByTestId('variant-option-12-standard')).not.toBeChecked();
  });

  it('adds a group with its comma-separated options', async () => {
    const create = vi.spyOn(api, 'createVariantGroup').mockResolvedValue(product);
    render(<ProductVariants product={product} canEdit />);
    fireEvent.change(screen.getByLabelText('New group'), { target: { value: 'Хвіст' } });
    fireEvent.change(screen.getByLabelText('Options, comma-separated'), { target: { value: 'прямий, кутовий' } });
    fireEvent.click(screen.getByRole('button', { name: /add group/i }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(7, { name: 'Хвіст', options: ['прямий', 'кутовий'] }));
  });

  it('makes another option the standard', async () => {
    const update = vi.spyOn(api, 'updateVariantGroup').mockResolvedValue(product);
    render(<ProductVariants product={product} canEdit />);
    fireEvent.click(screen.getByTestId('variant-option-12-standard'));
    await waitFor(() => expect(update).toHaveBeenCalledWith(7, 3, { default_option_id: 12 }));
  });

  it('disables deleting an option order lines chose, and says why', () => {
    render(<ProductVariants product={product} canEdit />);
    const remove = screen.getByTestId('variant-option-12-delete');
    expect(remove).toBeDisabled();
    expect(remove).toHaveAttribute('title', 'Chosen in 2 order lines');
    // The standard one is refused for its own reason.
    expect(screen.getByTestId('variant-option-11-delete')).toBeDisabled();
  });

  it('renames an option on blur', async () => {
    const update = vi.spyOn(api, 'updateVariantOption').mockResolvedValue(product);
    render(<ProductVariants product={product} canEdit />);
    const field = screen.getByDisplayValue('прямий');
    fireEvent.change(field, { target: { value: 'straight' } });
    fireEvent.blur(field);
    await waitFor(() => expect(update).toHaveBeenCalledWith(7, 3, 11, { name: 'straight' }));
  });

  it('shows nothing to a viewer of a product without variants', () => {
    const { container } = render(<ProductVariants product={{ ...product, variant_groups: [] }} canEdit={false} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('CompositionTable — variant column', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('binds a part to an option', async () => {
    const save = vi.spyOn(api, 'updateProductPart').mockResolvedValue(product.parts[0]);
    render(<CompositionTable product={product} canEdit />);
    fireEvent.change(screen.getByLabelText('Variant'), { target: { value: '12' } });
    await waitFor(() => expect(save).toHaveBeenCalledWith(7, 5, { variant_option_id: 12 }));
  });

  it('has no variant column when the product has no groups', () => {
    render(<CompositionTable product={{ ...product, variant_groups: [] }} canEdit />);
    expect(screen.queryByLabelText('Variant')).not.toBeInTheDocument();
  });
});
