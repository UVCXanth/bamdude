/**
 * The catalog menu's «To order…» (WS-13 E5 G01): a catalog, active product, for
 * somebody who may change orders — and only where the page can open the dialog.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { render } from '../../utils';
import type { Permission, ProductListItem } from '../../../api/client';
import { ProductActionMenu } from '../../../components/products/ProductActionMenu';
import { PRODUCT_ROW_DEFAULTS } from '../../wireDefaults';

const auth = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('../../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../contexts/AuthContext')>();
  return {
    ...actual,
    useAuth: () => ({ ...actual.useAuth(), hasPermission: (p: Permission) => auth.granted.has(p) }),
  };
});

const product: ProductListItem = {
  ...PRODUCT_ROW_DEFAULTS,
  id: 4,
  code: 'PR-0004',
  name: 'Flask',
  is_active: true,
  sku: null,
  version: null,
  category: null,
  status: 'ready',
  origin: 'catalog',
  origin_file_id: null,
  origin_plate_index: null,
  cover_image_filename: null,
  has_cover: false,
  parts_count: 1,
  plates_count: 1,
  lines_count: 0,
  kits_available: 0,
  finished_available: 0,
  materials: [],
  colors: [],
  models: [],
};

const noop = () => {};

function open(over: Partial<ProductListItem> = {}, onAddToOrder: ((p: ProductListItem) => void) | null = noop) {
  render(
    <ProductActionMenu
      product={{ ...product, ...over }}
      onEdit={noop}
      onDuplicate={noop}
      onToggleActive={noop}
      onDelete={noop}
      onAddToOrder={onAddToOrder ?? undefined}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
}

describe('ProductActionMenu — To order…', () => {
  beforeEach(() => {
    auth.granted = new Set(['projects:update']);
  });

  it('opens the dialog for this product', () => {
    const onAddToOrder = vi.fn();
    open({}, onAddToOrder);
    fireEvent.click(screen.getByRole('menuitem', { name: 'To order…' }));
    expect(onAddToOrder).toHaveBeenCalledWith(expect.objectContaining({ id: 4 }));
  });

  it('is not offered for a hidden or one-off product', () => {
    open({ is_active: false });
    expect(screen.queryByRole('menuitem', { name: 'To order…' })).not.toBeInTheDocument();
  });

  it('is not offered for a one-off product', () => {
    open({ origin: 'adhoc_job' });
    expect(screen.queryByRole('menuitem', { name: 'To order…' })).not.toBeInTheDocument();
  });

  it('is not offered to somebody who may not change orders', () => {
    auth.granted = new Set();
    open();
    expect(screen.queryByRole('menuitem', { name: 'To order…' })).not.toBeInTheDocument();
  });

  it('is not offered where the page cannot open the dialog', () => {
    open({}, null);
    expect(screen.queryByRole('menuitem', { name: 'To order…' })).not.toBeInTheDocument();
  });
});
