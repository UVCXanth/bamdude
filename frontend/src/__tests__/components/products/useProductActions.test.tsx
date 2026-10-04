/**
 * The one host of a product's actions (WS-13 E8 F): the catalog's menu (card and row),
 * the product page's header and the one-off banner all run through it — one action,
 * one behaviour, the same rights, refusals and invalidations at every door.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useRef } from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { render } from '../../utils';
import { api, ApiError } from '../../../api/client';
import type { Permission, ProductListItem } from '../../../api/client';
import { ProductActionMenu } from '../../../components/products/ProductActionMenu';
import { useProductActions } from '../../../components/products/productActions/useProductActions';
import {
  invalidateAfterDelete,
  invalidateOrderViews,
  invalidateProductCatalog,
} from '../../../utils/queryInvalidation';
import { PRODUCT_ROW_DEFAULTS } from '../../wireDefaults';

const auth = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('../../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../contexts/AuthContext')>();
  return {
    ...actual,
    useAuth: () => ({ ...actual.useAuth(), hasPermission: (p: Permission) => auth.granted.has(p) }),
  };
});
// The invalidations each action already makes (R06) are watched, not replaced.
vi.mock('../../../utils/queryInvalidation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/queryInvalidation')>();
  return {
    ...actual,
    invalidateAfterDelete: vi.fn(actual.invalidateAfterDelete),
    invalidateOrderViews: vi.fn(actual.invalidateOrderViews),
    invalidateProductCatalog: vi.fn(actual.invalidateProductCatalog),
  };
});

const ALL = ['orders:read', 'products:read', 'customers:read', 'stock:read', 'orders:create', 'products:create', 'customers:create', 'orders:update', 'products:update', 'customers:update', 'stock:move', 'stock:adjust', 'orders:delete', 'products:delete', 'customers:delete'];

const flask: ProductListItem = {
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

function Harness({
  products,
  context = 'catalog',
  onEdit = () => {},
  onDeleted,
}: {
  products: ProductListItem[];
  context?: 'catalog' | 'detail';
  onEdit?: (p: ProductListItem) => void;
  onDeleted?: (p: ProductListItem) => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const actions = useProductActions<ProductListItem>({ context, onEdit, onDeleted, fallbackFocusRef: heading });
  return (
    <>
      <h1 ref={heading} tabIndex={-1}>
        Products
      </h1>
      {products.map((p) => (
        <ProductActionMenu key={p.id} product={p} actions={actions} testId={`menu-${p.id}`} />
      ))}
      {actions.host}
    </>
  );
}

const openMenu = (id = 4) => fireEvent.click(screen.getByTestId(`menu-${id}`));
const items = () => screen.getAllByRole('menuitem').map((i) => i.textContent?.trim());

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(invalidateAfterDelete).mockClear();
  vi.mocked(invalidateOrderViews).mockClear();
  vi.mocked(invalidateProductCatalog).mockClear();
  auth.granted = new Set(ALL);
  window.history.pushState({}, '', '/products');
});
afterEach(() => window.history.pushState({}, '', '/'));

describe('ProductActionMenu — the items (F02)', () => {
  it('a listed catalog product: the mockup order', () => {
    render(<Harness products={[flask]} />);
    openMenu();
    expect(items()).toEqual(['Edit', 'To order…', 'Duplicate', 'Export ZIP', 'Hide from catalog', 'Delete']);
  });

  it('a hidden catalog product returns to the catalog and is not added to orders', () => {
    render(<Harness products={[{ ...flask, is_active: false }]} />);
    openMenu();
    expect(items()).toEqual(['Edit', 'Duplicate', 'Export ZIP', 'Return to catalog', 'Delete']);
  });

  it('a one-off product is added to the catalog, never hidden or returned', () => {
    render(<Harness products={[{ ...flask, origin: 'adhoc_plate' }]} />);
    openMenu();
    expect(items()).toEqual(['Edit', 'Duplicate', 'Export ZIP', 'Add to catalog…', 'Delete']);
  });

  it('an item without its right is not shown', () => {
    auth.granted = new Set(['orders:read', 'products:read', 'customers:read', 'stock:read']);
    render(<Harness products={[flask]} />);
    openMenu();
    expect(items()).toEqual(['Export ZIP']);
  });
});

describe('useProductActions — duplicate (F03)', () => {
  it('sends the localized copy name, goes to the copy and says what was copied', async () => {
    const dup = vi.spyOn(api, 'duplicateProduct').mockResolvedValue({ id: 12 } as never);
    render(<Harness products={[flask]} />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    await waitFor(() => expect(window.location.pathname).toBe('/products/12'));
    expect(dup).toHaveBeenCalledWith(4, 'Flask (copy)');
    expect(invalidateProductCatalog).toHaveBeenCalled();
    expect(await screen.findByText('Copy created — composition, variants and files copied, stock not')).toBeInTheDocument();
  });

  it('while the copy is being made the item says so and a second request is not sent', async () => {
    const dup = vi.spyOn(api, 'duplicateProduct').mockImplementation(() => new Promise(() => {}));
    render(<Harness products={[flask]} />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    openMenu();
    const pending = screen.getByRole('menuitem', { name: 'Duplicate…' });
    expect(pending).toBeDisabled();
    fireEvent.click(pending);
    expect(dup).toHaveBeenCalledTimes(1);
  });

  it('a refused copy is a toast; the page stays', async () => {
    vi.spyOn(api, 'duplicateProduct').mockRejectedValue(new ApiError('The product is busy', 409));
    render(<Harness products={[flask]} />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    expect(await screen.findByText('The product is busy')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/products');
  });
});

describe('useProductActions — export, hide and show (F04, F05)', () => {
  it('downloads the ZIP; a refusal says its HTTP status', async () => {
    const save = vi.spyOn(api, 'downloadProductExport').mockRejectedValue(new ApiError('nope', 500));
    render(<Harness products={[flask]} />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export ZIP' }));
    expect(await screen.findByText('The export failed (HTTP 500).')).toBeInTheDocument();
    expect(save).toHaveBeenCalledWith(4);
  });

  it('hides without a confirmation, with the order views told', async () => {
    const update = vi.spyOn(api, 'updateProduct').mockResolvedValue({ ...flask, is_active: false } as never);
    render(<Harness products={[flask]} />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide from catalog' }));
    expect(await screen.findByText('Product hidden from the catalog')).toBeInTheDocument();
    expect(update).toHaveBeenCalledWith(4, { is_active: false });
    expect(invalidateOrderViews).toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('returns a hidden product to the catalog', async () => {
    const update = vi.spyOn(api, 'updateProduct').mockResolvedValue({ ...flask, is_active: true } as never);
    render(<Harness products={[{ ...flask, is_active: false }]} />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Return to catalog' }));
    expect(await screen.findByText('Product is back in the catalog')).toBeInTheDocument();
    expect(update).toHaveBeenCalledWith(4, { is_active: true });
  });
});

describe('useProductActions — add to catalog (F06)', () => {
  const oneOff = { ...flask, origin: 'adhoc_plate' as const };

  it('asks first, names the product, and sends the origin alone', async () => {
    const update = vi.spyOn(api, 'updateProduct').mockResolvedValue({ ...oneOff, origin: 'catalog' } as never);
    render(<Harness products={[oneOff]} />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add to catalog…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add the product to the catalog?' });
    expect(dialog).toHaveTextContent('PR-0004 · Flask');
    expect(dialog).toHaveTextContent('The one-off product becomes an ordinary catalog product. It cannot be turned back into a one-off.');
    expect(dialog).toHaveTextContent('The catalog and the pickers will show it.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add to catalog' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(update).toHaveBeenCalledWith(4, { origin: 'catalog' });
    expect(invalidateProductCatalog).toHaveBeenCalled();
    expect(await screen.findByText('Added to the catalog')).toBeInTheDocument();
  });

  it('says a hidden one-off stays hidden', async () => {
    render(<Harness products={[{ ...oneOff, is_active: false }]} />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add to catalog…' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('It stays hidden until you return it to the catalog.');
  });

  it('a refusal stays in the dialog, with the focus on its button', async () => {
    vi.spyOn(api, 'updateProduct').mockRejectedValue(new ApiError('Product is busy', 409));
    render(<Harness products={[oneOff]} />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add to catalog…' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add to catalog' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Product is busy');
    expect(within(dialog).getByRole('button', { name: 'Add to catalog' })).toHaveFocus();
  });
});

describe('useProductActions — delete (F07–F09)', () => {
  it('asks with the mockup text; a 409 stays in the dialog as the server said it', async () => {
    vi.spyOn(api, 'deleteProduct').mockRejectedValue(new ApiError('The product has finished goods in stock', 409));
    render(<Harness products={[flask]} />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete product?' });
    expect(dialog).toHaveTextContent('PR-0004 · Flask');
    expect(dialog).toHaveTextContent('The files in the library stay.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('The product has finished goods in stock');
    expect(within(dialog).getByRole('button', { name: 'Delete' })).toHaveFocus();
    expect(invalidateAfterDelete).not.toHaveBeenCalled();
  });

  it('from the catalog: the lists AND the deleted product’s own entry go', async () => {
    vi.spyOn(api, 'deleteProduct').mockResolvedValue({ message: 'ok' });
    render(<Harness products={[flask]} />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Product deleted')).toBeInTheDocument();
    expect(invalidateAfterDelete).toHaveBeenCalledWith(expect.anything(), 'product', 4);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('from the detail: the lists only, and the page finishes (forget + leave)', async () => {
    vi.spyOn(api, 'deleteProduct').mockResolvedValue({ message: 'ok' });
    const onDeleted = vi.fn();
    render(<Harness products={[flask]} context="detail" onDeleted={onDeleted} />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(expect.objectContaining({ id: 4 })));
    expect(invalidateAfterDelete).toHaveBeenCalledWith(expect.anything(), 'product');
  });

  it('while the delete runs nothing closes the dialog or sends it again', async () => {
    const del = vi.spyOn(api, 'deleteProduct').mockImplementation(() => new Promise(() => {}));
    render(<Harness products={[flask]} />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    const primary = within(dialog).getByRole('button', { name: 'Delete' });
    fireEvent.click(primary);
    fireEvent.click(primary);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await waitFor(() => expect(del).toHaveBeenCalled());
    await act(async () => {});
    expect(del).toHaveBeenCalledTimes(1);
  });

  it('outlives its row, and with the row gone the focus lands on the page heading', async () => {
    vi.spyOn(api, 'deleteProduct').mockResolvedValue({ message: 'ok' });
    const { rerender } = render(<Harness products={[flask]} />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    // A re-read drops the row (another filter, somebody else's change).
    rerender(<Harness products={[]} />);
    expect(screen.getByRole('dialog')).toBe(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Products' })).toHaveFocus());
  });

  it('with the row still there, the focus goes back to its menu', async () => {
    render(<Harness products={[flask]} />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    });
    await waitFor(() => expect(screen.getByTestId('menu-4')).toHaveFocus());
  });
});

// Final review M5 (F09): a delete always takes the row away — the focus goes to the page's
// heading, not to a trigger about to vanish; a hide whose row the re-read drops does the same.
describe('useProductActions — focus after the row leaves', () => {
  it('after a delete from the catalog the focus is on the heading', async () => {
    vi.spyOn(api, 'deleteProduct').mockResolvedValue({ message: 'ok' });
    render(<Harness products={[flask]} />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Products' })).toHaveFocus());
  });

  it('after a hide whose row the re-read drops, the focus is on the heading', async () => {
    vi.spyOn(api, 'updateProduct').mockResolvedValue({ ...flask, is_active: false } as never);
    const { rerender } = render(<Harness products={[flask]} />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide from catalog' }));
    await screen.findByText('Product hidden from the catalog');
    rerender(<Harness products={[]} />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Products' })).toHaveFocus());
  });

  // Codex E8-V02: the re-read is the server's — it may take longer than any limit we pick. The
  // watch lasts as long as the row and the operator's focus on its trigger, not a number of seconds.
  it('after a hide whose re-read takes longer than five seconds, the focus is on the heading', async () => {
    vi.spyOn(api, 'updateProduct').mockResolvedValue({ ...flask, is_active: false } as never);
    const { rerender } = render(<Harness products={[flask]} />);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide from catalog' }));
    await screen.findByText('Product hidden from the catalog');
    expect(screen.getByTestId('menu-4')).toHaveFocus();
    clock.mockReturnValue(60_000);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    rerender(<Harness products={[]} />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Products' })).toHaveFocus());
  });

  it('leaves a focus the operator moved elsewhere, and stops watching', async () => {
    vi.spyOn(api, 'updateProduct').mockResolvedValue({ ...flask, is_active: false } as never);
    const elsewhere = document.createElement('button');
    elsewhere.textContent = 'Elsewhere';
    document.body.append(elsewhere);
    try {
      const { rerender } = render(<Harness products={[flask]} />);
      openMenu();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Hide from catalog' }));
      await screen.findByText('Product hidden from the catalog');
      const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
      act(() => elsewhere.focus());
      expect(disconnect).toHaveBeenCalled();
      rerender(<Harness products={[]} />);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(elsewhere).toHaveFocus();
    } finally {
      elsewhere.remove();
    }
  });

  it('stops watching when the page goes', async () => {
    vi.spyOn(api, 'updateProduct').mockResolvedValue({ ...flask, is_active: false } as never);
    const { unmount } = render(<Harness products={[flask]} />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide from catalog' }));
    await screen.findByText('Product hidden from the catalog');
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    unmount();
    expect(disconnect).toHaveBeenCalled();
  });
});
