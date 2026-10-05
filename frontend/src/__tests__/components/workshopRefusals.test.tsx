/**
 * The Workshop's writer dialogs answer a refusal one way (WS-13 E13 G04) — a sample,
 * one dialog per section, across 403 / 404 / 409 / 422:
 * - the server's sentence stands IN the dialog's slot (`role="alert"` inside it),
 *   shown verbatim — nothing is decided by its text;
 * - the dialog stays open and the draft typed into it is whole;
 * - the primary sends again;
 * - two presses in the same tick send ONE request (the synchronous guard).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { render } from '../utils';
import { api, ApiError } from '../../api/client';
import type { Customer, Product } from '../../api/client';
import { OrderModal } from '../../components/projects/OrderModal';
import { ProductCardDialog } from '../../components/products/ProductCardDialog';
import { CustomerModal } from '../../components/customers/CustomerModal';
import { StockMoveDialog } from '../../components/stock/StockMoveDialog';
import { BatchAssignOrderModal } from '../../components/projects/BatchAssignOrderModal';
import { LinkToProductsModal } from '../../components/products/LinkToProductsModal';
import { pipeDetail, pipeItem, pipeProduct } from './stock/stockFixtures';

/** The alert inside the (one) open dialog — never a toast beside it. */
async function slot(): Promise<HTMLElement> {
  return within(screen.getByRole('dialog')).findByRole('alert');
}

/** Two presses before React renders the first one's request. */
function pressTwiceInOneTick(button: HTMLElement) {
  act(() => {
    button.click();
    button.click();
  });
}

/** A promise that never settles: the request stays on its way. */
const pendingForever = () => new Promise<never>(() => {});

// ---------------------------------------------------------------------------- orders

const order = {
  id: 5,
  name: 'Ten flasks',
  customer_id: 2,
  customer_name: 'ACME',
  description: 'Existing description',
  color: '#00ae42',
  status: 'active',
  notes: null,
  attachments: null,
  tags: null,
  due_date: '2026-09-10T00:00:00',
  priority: 'normal',
  price: 120,
  url: 'https://example.com',
  cover_image_filename: null,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
  lines: [],
  procurement: [],
  figures: {},
  other_archive_ids: [],
} as never;

describe('orders — OrderModal (409)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getCustomers').mockResolvedValue([{ id: 2, name: 'ACME', figures: {} }] as never);
    vi.spyOn(api, 'getFulfilment').mockResolvedValue({
      lines: [],
      ordered: 10,
      issued: 0,
      held: 0,
      fully_issued: false,
      closes_to_stock: false,
      can_complete: false,
      can_assemble: 0,
      can_receive: 0,
      can_issue: 0,
      recipient: { name: null, phone: null, delivery_method: null, delivery_details: null },
    });
  });

  it('says the refusal in its slot, keeps the dialog and the draft, and sends again', async () => {
    const update = vi
      .spyOn(api, 'updateOrder')
      .mockRejectedValueOnce(new ApiError('The order changed while you were editing it', 409))
      .mockResolvedValueOnce(order);
    const onClose = vi.fn();
    render(<OrderModal order={order} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Twelve flasks' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(await slot()).toHaveTextContent('The order changed while you were editing it');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/name/i)).toHaveValue('Twelve flasks');

    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update).toHaveBeenLastCalledWith(5, { name: 'Twelve flasks' });
  });

  it('sends one request for two presses in one tick', async () => {
    const update = vi.spyOn(api, 'updateOrder').mockReturnValue(pendingForever());
    render(<OrderModal order={order} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Twelve flasks' } });
    pressTwiceInOneTick(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(update).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------- products

const product = {
  id: 7,
  code: 'PR-0007',
  name: 'Flask',
  is_active: true,
  sku: 'FLK-1',
  version: null,
  category: { id: 3, name: 'Hooks' },
  status: 'draft',
  has_cover: false,
  cover_image_filename: null,
  parts_count: 2,
  plates_count: 1,
  lines_count: 0,
  description: 'A flask',
  notes: null,
  designer: 'Ada',
  license: null,
  source_url: null,
  design_id: null,
  attachments: [],
  parts: [],
  library_file_ids: [],
  library_folder_ids: [],
  units_printed_total: 0,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
} as unknown as Product;

describe('products — ProductCardDialog (422)', () => {
  const primary = () => screen.getByRole('button', { name: /^save product$/i });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getProductCategories').mockResolvedValue([{ id: 3, name: 'Hooks', products_count: 1 }]);
    vi.spyOn(api, 'getProduct').mockResolvedValue(product);
  });

  it('says the refusal in its slot, keeps the dialog and the draft, and sends again', async () => {
    const update = vi
      .spyOn(api, 'updateProduct')
      .mockRejectedValueOnce(new ApiError('A product is ready to print only with a part and a plate', 422))
      .mockResolvedValueOnce(product);
    const onClose = vi.fn();
    render(<ProductCardDialog product={product} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Flask v2' } });
    fireEvent.click(primary());

    expect(await slot()).toHaveTextContent('A product is ready to print only with a part and a plate');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Name')).toHaveValue('Flask v2');

    fireEvent.click(primary());
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update).toHaveBeenLastCalledWith(7, expect.objectContaining({ name: 'Flask v2' }));
  });

  it('sends one request for two presses in one tick', async () => {
    const update = vi.spyOn(api, 'updateProduct').mockReturnValue(pendingForever());
    render(<ProductCardDialog product={product} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Flask v2' } });
    pressTwiceInOneTick(primary());
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(update).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------- customers

const blank = {
  role: null,
  phone: null,
  email: null,
  city: null,
  delivery_method_id: null,
  delivery_method_name: null,
  delivery_details: null,
  note: null,
};
const acme: Customer = {
  id: 1,
  code: 'CU-0001',
  name: 'ACME',
  kind: 'company',
  notes: null,
  created_at: '',
  updated_at: '',
  contacts: [{ ...blank, id: 10, code: 'CT-0010', name: 'Olena', orders_count: 0 }],
  figures: { projects: 0, active: 0, completed: 0, cancelled: 0, total_price: 0 },
};

describe('customers — CustomerModal (404)', () => {
  const primary = () => screen.getByRole('button', { name: /^(Save customer|Save anyway|Saving…)$/ });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getDeliveryMethods').mockResolvedValue([]);
  });

  it('says the refusal in its slot, keeps the dialog and the draft, and sends again', async () => {
    const update = vi
      .spyOn(api, 'updateCustomer')
      .mockRejectedValueOnce(new ApiError('Customer not found', 404))
      .mockResolvedValueOnce(acme);
    const onClose = vi.fn();
    render(<CustomerModal customer={acme} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'ACME Ltd' } });
    fireEvent.click(primary());

    expect(await slot()).toHaveTextContent('Customer not found');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Name')).toHaveValue('ACME Ltd');

    fireEvent.click(primary());
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update).toHaveBeenLastCalledWith(1, { name: 'ACME Ltd' });
  });

  it('sends one request for two presses in one tick', async () => {
    const update = vi.spyOn(api, 'updateCustomer').mockReturnValue(pendingForever());
    render(<CustomerModal customer={acme} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'ACME Ltd' } });
    pressTwiceInOneTick(primary());
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(update).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------- stock

describe('stock — StockMoveDialog, a receipt (409)', () => {
  const submit = () => screen.getByTestId('stock-move-submit');
  const qty = () => screen.getByLabelText('Quantity, pcs');

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getStockItem').mockResolvedValue(pipeDetail);
    vi.spyOn(api, 'getProducts').mockResolvedValue([pipeProduct] as never);
    vi.spyOn(api, 'getProduct').mockResolvedValue(pipeProduct as never);
    vi.spyOn(api, 'getCustomers').mockResolvedValue([] as never);
    vi.spyOn(api, 'getDeliveryMethods').mockResolvedValue([]);
  });

  it('says the refusal in its slot, keeps the dialog and the draft, and sends again', async () => {
    const move = vi
      .spyOn(api, 'moveStock')
      .mockRejectedValueOnce(new ApiError('The position changed — read it again', 409))
      .mockResolvedValueOnce({ ...pipeItem, moved: true } as never);
    const onClose = vi.fn();
    render(<StockMoveDialog kind="receipt" item={pipeItem} onClose={onClose} />);
    await waitFor(() => expect(submit()).toBeEnabled());
    fireEvent.change(qty(), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Basis / note'), { target: { value: 'from the night shift' } });
    fireEvent.click(submit());

    expect(await slot()).toHaveTextContent('The position changed — read it again');
    expect(onClose).not.toHaveBeenCalled();
    expect(qty()).toHaveValue(3);
    expect(screen.getByLabelText('Basis / note')).toHaveValue('from the night shift');

    await waitFor(() => expect(submit()).toBeEnabled());
    fireEvent.click(submit());
    await waitFor(() => expect(move).toHaveBeenCalledTimes(2));
  });

  it('sends one request for two presses in one tick', async () => {
    const move = vi.spyOn(api, 'moveStock').mockReturnValue(pendingForever());
    render(<StockMoveDialog kind="receipt" item={pipeItem} onClose={() => {}} />);
    await waitFor(() => expect(submit()).toBeEnabled());
    fireEvent.change(qty(), { target: { value: '3' } });
    pressTwiceInOneTick(submit());
    await waitFor(() => expect(move).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(move).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------- archives → order

describe('archives → order — BatchAssignOrderModal (403)', () => {
  const flasks = { id: 5, code: 'OR-0005', name: 'Flasks', status: 'active', customer_name: null, lines: [] };
  const assign = () => screen.getByRole('button', { name: 'Assign' });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getOrdersPaged').mockResolvedValue({
      items: [flasks],
      meta: { total: 1, current_page: 1, per_page: 20, last_page: 1 },
      totals: { active: 1, completed: 0, cancelled: 0, all: 1, stages: {} },
    } as never);
    vi.spyOn(api, 'getOrder').mockResolvedValue(flasks as never);
  });

  async function chooseFlasks() {
    await screen.findByRole('option', { name: 'OR-0005 · Flasks · no customer' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Order' }), { target: { value: '5' } });
    // «Assign» waits until the chosen order is read (WS-13 E13 T19).
    await waitFor(() => expect(screen.getByRole('button', { name: 'Assign' })).toBeEnabled());
  }

  it('says the refusal in its slot, keeps the dialog and the chosen order, and sends again', async () => {
    const add = vi
      .spyOn(api, 'addArchivesToOrder')
      .mockRejectedValueOnce(new ApiError('You can only update your own archives', 403))
      .mockResolvedValueOnce({} as never);
    const onClose = vi.fn();
    render(<BatchAssignOrderModal archiveIds={[3, 4]} onClose={onClose} />);
    await chooseFlasks();
    fireEvent.click(assign());

    expect(await slot()).toHaveTextContent('You can only update your own archives');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('combobox', { name: 'Order' })).toHaveValue('5');

    await waitFor(() => expect(assign()).toBeEnabled());
    fireEvent.click(assign());
    await waitFor(() => expect(add).toHaveBeenCalledTimes(2));
    expect(add).toHaveBeenLastCalledWith(5, [3, 4], null);
  });

  it('sends one request for two presses in one tick', async () => {
    const add = vi.spyOn(api, 'addArchivesToOrder').mockReturnValue(pendingForever());
    render(<BatchAssignOrderModal archiveIds={[3, 4]} onClose={() => {}} />);
    await chooseFlasks();
    pressTwiceInOneTick(assign());
    await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(add).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------- library

describe('library — LinkToProductsModal (404)', () => {
  const item = { id: 1, filename: 'clip.gcode.3mf', product_ids: [7] };
  const save = () => screen.getByRole('button', { name: /^save$/i });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getProducts').mockResolvedValue([
      { id: 7, name: 'Lamp', is_active: true },
      { id: 8, name: 'Vase', is_active: true },
    ] as never);
  });

  it('says the refusal in its slot, keeps the dialog and the chosen products, and sends again', async () => {
    const update = vi
      .spyOn(api, 'updateLibraryFile')
      .mockRejectedValueOnce(new ApiError('Product 8 not found', 404))
      .mockResolvedValueOnce({} as never);
    const onClose = vi.fn();
    render(<LinkToProductsModal kind="file" item={item} onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Vase' }));
    fireEvent.click(save());

    expect(await slot()).toHaveTextContent('Product 8 not found');
    expect(onClose).not.toHaveBeenCalled();
    // A chosen chip offers its removal: the pick survived the refusal.
    expect(screen.getByRole('button', { name: /Vase/ })).toHaveAttribute('title', 'Remove from Vase');

    await waitFor(() => expect(save()).toBeEnabled());
    fireEvent.click(save());
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update).toHaveBeenLastCalledWith(1, { product_ids: [7, 8] });
  });

  it('sends one request for two presses in one tick', async () => {
    const update = vi.spyOn(api, 'updateLibraryFile').mockReturnValue(pendingForever());
    render(<LinkToProductsModal kind="file" item={item} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Vase' }));
    pressTwiceInOneTick(save());
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(update).toHaveBeenCalledTimes(1);
  });
});
