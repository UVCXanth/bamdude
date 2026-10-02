/**
 * The product page's header (WS-13 E9 B01–B02): the breadcrumbs, the name with its
 * badges, the identity line (the code first), «+ Add to order» and «Edit», and «⋮» with
 * every other whole-product action of the page's host — plus «Re-read the card from a
 * file…», the page's own item, for somebody who may change the product.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import { http, HttpResponse } from 'msw';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { render } from '../../../utils';
import { server } from '../../../mocks/server';
import { api, ApiError } from '../../../../api/client';
import type { Product } from '../../../../api/client';
import { ProductDetailHeader } from '../../../../components/products/detail/ProductDetailHeader';
import { useProductActions } from '../../../../components/products/productActions/useProductActions';
import { PRODUCT_ROW_DEFAULTS } from '../../../wireDefaults';

const product = {
  ...PRODUCT_ROW_DEFAULTS,
  id: 7,
  code: 'PR-0007',
  name: 'Flask',
  is_active: true,
  origin: 'catalog',
  status: 'ready',
  sku: 'FL-1',
  version: 'v2',
  category: { id: 3, name: 'Lighting' },
  parts_count: 2,
  plates_count: 3,
  has_cover: false,
  cover_image_filename: null,
  attachments: [],
  parts: [],
  library_file_ids: [],
  library_folder_ids: [],
} as unknown as Product;

const onReread = vi.fn();

function Header({ product: p }: { product: Product }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const actions = useProductActions<Product>({ context: 'detail', onEdit: () => {}, fallbackFocusRef: heading });
  return (
    <>
      <ProductDetailHeader product={p} actions={actions} headingRef={heading} onReread={onReread} />
      {actions.host}
    </>
  );
}

function mount(over: Partial<Product> = {}) {
  render(<Header product={{ ...product, ...over } as Product} />);
}

function asReader() {
  server.use(
    http.get('/api/v1/auth/me', () =>
      HttpResponse.json({
        id: 2,
        username: 'viewer',
        role: 'user',
        is_active: true,
        is_admin: false,
        groups: [{ id: 2, name: 'Viewers' }],
        permissions: ['projects:read'],
        created_at: '2024-01-01T00:00:00Z',
      }),
    ),
  );
}

async function menuItems() {
  fireEvent.click(await screen.findByRole('button', { name: 'Actions' }));
  return within(await screen.findByRole('menu')).getAllByRole('menuitem').map((item) => item.textContent?.trim());
}

describe('ProductDetailHeader', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    onReread.mockReset();
  });

  it('B01 breadcrumbs, the name with its badges and the identity line with the code first', async () => {
    mount({ status: 'draft' });
    const nav = screen.getByRole('navigation', { name: 'Breadcrumbs' });
    expect(within(nav).getByRole('link', { name: 'Products' })).toHaveAttribute('href', '/products');
    expect(nav).toHaveTextContent('Flask');
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('Flask');
    expect(heading).toHaveAttribute('tabindex', '-1');
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.getByTestId('product-identity')).toHaveTextContent('PR-0007 · FL-1 v2 · Lighting');
  });

  it('B01 «Add to order» and «Edit» are buttons; everything else is in «⋮» in the mockup’s order', async () => {
    mount();
    expect(await screen.findByRole('button', { name: /Add to order/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Edit$/ })).toBeInTheDocument();
    expect(await menuItems()).toEqual([
      'Duplicate',
      'Export ZIP',
      'Re-read the card from a file…',
      'Hide from catalog',
      'Delete',
    ]);
  });

  it('B02 a hidden catalog product offers «Return to catalog»; a one-off offers «Add to catalog…»', async () => {
    mount({ is_active: false });
    expect(await menuItems()).toContain('Return to catalog');
  });

  it('B02 a one-off: no «Add to order», «Add to catalog…» in the menu', async () => {
    mount({ origin: 'adhoc_plate' });
    const items = await menuItems();
    expect(items).toContain('Add to catalog…');
    expect(items).not.toContain('Hide from catalog');
    expect(screen.queryByRole('button', { name: /Add to order/ })).not.toBeInTheDocument();
  });

  it('B02 «Re-read…» opens the page’s dialog', async () => {
    mount();
    await menuItems();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Re-read the card from a file…' }));
    expect(onReread).toHaveBeenCalledTimes(1);
  });

  it('B02 a reader: no «Edit», no «Add to order», no «Re-read…» — «Export ZIP» stays', async () => {
    asReader();
    const me = vi.spyOn(api, 'getCurrentUser');
    mount();
    await waitFor(() => expect(me).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /^Edit$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add to order/ })).not.toBeInTheDocument();
    expect(await menuItems()).toEqual(['Export ZIP']);
  });

  it('export downloads the ZIP, and a failure says so', async () => {
    const save = vi.spyOn(api, 'downloadProductExport').mockRejectedValueOnce(new ApiError('nope', 500));
    mount();
    await menuItems();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export ZIP' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(7));
    expect(await screen.findByText(/export failed \(HTTP 500\)/i)).toBeInTheDocument();
  });
});
