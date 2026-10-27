/**
 * Spec part-thumbnails §12.2, plan E6 (task 44): the order's dialogs name their parts with pictures. The issue
 * dialog's table is read-only without the stock's move, and its pictures' buttons still work for the mouse,
 * a touch and the keyboard (D6). «Surplus to free stock» takes its pictures from the order read live by its
 * id — opened from the order page with a snapshot too (D8). The parts tab of «Add to order» shows them as well.
 */
import { useEffect, useRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { render } from '../../utils';
import { server } from '../../mocks/server';
import { api } from '../../../api/client';
import type { FulfilmentState, Order, PartFigures, PartImageRef, Permission } from '../../../api/client';
import { BankSurplusDialog } from '../../../components/projects/BankSurplusDialog';
import { AddToOrderDialog } from '../../../components/projects/add-to-order/AddToOrderDialog';
import { FulfilmentDialog } from '../../../components/projects/fulfilment/FulfilmentDialog';
import { toOrderRef, type OrderRef } from '../../../components/projects/orderActions/orderRef';
import { useOrderActions } from '../../../components/projects/orderActions/useOrderActions';
import { useOrderDetail } from '../../../hooks/useOrderDetail';
import { invalidatePartImageViews } from '../../../utils/queryInvalidation';
import { makeFigures, makeLine, makeOrder } from '../../fixtures/orderDetail';
import { pageOf, part, partsPage } from './add-to-order/fixtures';

const auth = vi.hoisted(() => ({ granted: null as Set<string> | null }));
// The test's handle on the page's client — set in an effect, as `partImagesEvent.test.tsx` does (E5).
const handle = vi.hoisted(() => ({ client: null as QueryClient | null }));

vi.mock('../../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../contexts/AuthContext')>();
  return {
    ...actual,
    useAuth: () => {
      const real = actual.useAuth();
      return { ...real, hasPermission: (p: Permission) => auth.granted?.has(p) ?? true };
    },
  };
});

const ready = (v: string): PartImageRef => ({ kind: 'render', status: 'ready', v });
const src = (id: number, v: string) => `/api/v1/product-parts/${id}/image?v=${v}&size=sm`;
const READ_ONLY = new Set(['orders:read', 'orders:update', 'stock:read']);

const REF: OrderRef = {
  id: 5,
  code: 'OR-0005',
  name: 'Pipes',
  status: 'active',
  customer_name: 'ACME',
  bankable_surplus: 0,
  due_date: null,
};

// A product line and a parts line: the table's every kind of field (WS-13 E13: numbers, «all parts» boxes).
const state: FulfilmentState = {
  lines: [
    {
      line_id: 7,
      product_name: 'Pipe',
      mode: 'product',
      ordered: 10,
      from_finished: 2,
      kits_reserved: 3,
      can_assemble: 3,
      can_receive: 5,
      held: 2,
      issued: 0,
      written_off: 0,
      parts: [],
      configuration: null,
      stock_position: null,
    },
    {
      line_id: 8,
      product_name: 'Lamp',
      mode: 'parts',
      ordered: 5,
      from_finished: 0,
      kits_reserved: 0,
      can_assemble: 0,
      can_receive: 0,
      held: 0,
      issued: 0,
      written_off: 0,
      parts: [
        { part_id: 31, name: 'shade', wanted: 3, can_receive: 3, held: 0, issued: 0, written_off: 0, image: ready('s31') },
        { part_id: 32, name: 'base', wanted: 2, can_receive: 1, held: 0, issued: 0, written_off: 0, image: null },
      ],
      configuration: null,
      stock_position: null,
    },
  ],
  ordered: 15,
  issued: 0,
  held: 2,
  fully_issued: false,
  can_assemble: 3,
  can_receive: 9,
  can_issue: 14,
  closes_to_stock: false,
  can_complete: false,
  recipient: { name: 'Ivan', phone: '+380501112233', delivery_method: 'Nova Poshta', delivery_details: 'Branch 5' },
};

/** Tab through the dialog (its trap brings Tab round) until `label` has the focus. */
async function tabTo(user: ReturnType<typeof userEvent.setup>, label: string) {
  for (let i = 0; i < 60 && document.activeElement?.getAttribute('aria-label') !== label; i++) await user.tab();
  return document.activeElement;
}

beforeEach(() => {
  vi.restoreAllMocks();
  auth.granted = null;
});

describe('the issue dialog’s parts line', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getFulfilment').mockResolvedValue(state);
    vi.spyOn(api, 'getDeliveryMethods').mockResolvedValue([]);
  });

  it('each part shows its picture, larger on a click', async () => {
    render(<FulfilmentDialog order={REF} onClose={() => {}} />);
    const button = await screen.findByRole('button', { name: 'Show shade larger' });
    expect(within(button).getByTestId('part-thumb-img')).toHaveAttribute('src', src(31, 's31'));
    fireEvent.click(button);
    expect(screen.getByTestId('part-thumb-zoom')).toBeInTheDocument();
  });

  it('a part’s name lines up with the row’s figures: the cells are top-aligned, so is the name beside its picture (final review)', async () => {
    render(<FulfilmentDialog order={REF} onClose={() => {}} />);
    const button = await screen.findByRole('button', { name: 'Show shade larger' });
    const cell = button.closest('td') as HTMLTableCellElement;
    expect(cell).toHaveClass('align-top');
    expect(button.closest('[data-testid="part-thumb"]')?.parentElement).toHaveClass('items-start');
  });

  it.each([
    ['with the right to move stock', null],
    ['read-only, without it', READ_ONLY],
  ])('%s, the keyboard opens the larger picture and Escape closes it alone (plan E6, D6)', async (_name, granted) => {
    auth.granted = granted;
    const user = userEvent.setup();
    render(<FulfilmentDialog order={REF} onClose={() => {}} />);
    await screen.findByLabelText('Receive printed — shade');
    expect((await tabTo(user, 'Show shade larger'))?.getAttribute('aria-label')).toBe('Show shade larger');
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('part-thumb-zoom')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('part-thumb-zoom')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('read-only, every number and «all parts» box of the table is disabled — the picture’s button is not (plan E6, D6)', async () => {
    auth.granted = READ_ONLY;
    render(<FulfilmentDialog order={REF} onClose={() => {}} />);
    const table = (await screen.findByLabelText('Receive printed — shade')).closest('table') as HTMLTableElement;
    const controls = [...table.querySelectorAll('input, button, select, textarea')];
    const doors = controls.filter((el) => el.closest('[data-testid="part-thumb"]'));
    const editing = controls.filter((el) => !el.closest('[data-testid="part-thumb"]'));
    // `:disabled` answers for a fieldset too — the guarantee the fieldset gave is asked of every field.
    expect(doors.map((el) => el.matches(':disabled'))).toEqual([false]);
    expect(editing.length).toBeGreaterThan(0);
    expect(editing.filter((el) => !el.matches(':disabled')).map((el) => el.getAttribute('aria-label'))).toEqual([]);
    // nothing in the table can be typed: the first focus is «Cancel» (WS-13 E16), never a picture
    await waitFor(() => expect(document.activeElement).toHaveTextContent('Cancel'));
  });

  it('with the right, the first focus is still the first number of the table (plan E6, D6)', async () => {
    render(<FulfilmentDialog order={REF} onClose={() => {}} />);
    await screen.findByLabelText('Assemble from kits — Pipe');
    await waitFor(() => expect(document.activeElement).toHaveAttribute('aria-label', 'Assemble from kits — Pipe'));
  });
});

const shadeWith = (image: PartImageRef | null): PartFigures => ({
  part_id: 1,
  name: 'shade',
  qty_per_unit: 1,
  need: 2,
  usable: 5,
  in_progress: 0,
  remaining: 0,
  surplus: 3,
  variant: false,
  queued: 0,
  bankable: 3,
  image,
});

const diffusers = (image: PartImageRef | null): Order =>
  makeOrder({
    id: 4,
    code: 'OR-0004',
    name: 'Diffusers',
    figures: makeFigures({ bankable_surplus: 3 }),
    lines: [makeLine({ id: 10, product_name: 'Diffuser', parts: [shadeWith(image)] })],
  });

/** The order page's own door (consilium r1, E6-R1): the page reads the order, the actions host opens the dialog. */
function OrderPageHost({ snapshot }: { snapshot: boolean }) {
  const qc = useQueryClient();
  useEffect(() => {
    handle.client = qc;
  }, [qc]);
  const query = useOrderDetail(4);
  const heading = useRef<HTMLHeadingElement>(null);
  const actions = useOrderActions({ fallbackFocusRef: heading });
  const order = query.data;
  return (
    <>
      <h1 ref={heading} tabIndex={-1}>
        Order
      </h1>
      <output data-testid="live-order-image">{order?.lines[0].parts[0].image?.v ?? 'pending'}</output>
      {order && (
        <button type="button" onClick={() => actions.run('bank', toOrderRef(order), snapshot ? { order } : {})}>
          Bank
        </button>
      )}
      {actions.dialogs}
    </>
  );
}

describe('«Surplus to free stock»', () => {
  it('each part to bank shows its picture', async () => {
    const order = diffusers(ready('s1'));
    vi.spyOn(api, 'getOrder').mockResolvedValue(order);
    render(<BankSurplusDialog order={toOrderRef(order)} detail={order} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: 'Surplus to free stock' });
    const row = within(dialog).getAllByRole('row')[1];
    expect(within(row).getByTestId('part-thumb-img')).toHaveAttribute('src', src(1, 's1'));
    expect(row.textContent).toBe('shadeDiffuser3');
  });

  it.each([
    ['opened with the page’s snapshot: a queued picture becomes ready', { kind: 'render', status: 'pending', v: null }, true],
    ['opened with the page’s snapshot: a photo is replaced', { kind: 'photo', status: 'ready', v: 'old.jpg' }, true],
    ['opened from a list, without one', { kind: 'render', status: 'pending', v: null }, false],
  ] as [string, PartImageRef, boolean][])('%s (plan E6, D8)', async (_name, image, snapshot) => {
    // The part's picture is read apart from the order (spec procurement-stock-images R5): first as the order has it.
    let picture: PartImageRef = image;
    server.use(
      http.get('/api/v1/product-parts/images', () => HttpResponse.json([{ part_id: 1, product_id: 7, image: picture }])),
    );
    const getOrder = vi.spyOn(api, 'getOrder').mockResolvedValue(diffusers(image));
    render(<OrderPageHost snapshot={snapshot} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Bank' }));
    const dialog = await screen.findByRole('dialog', { name: 'Surplus to free stock' });
    await waitFor(() => expect(within(dialog).getByTestId('part-thumb')).toHaveAttribute('data-state', image.status));
    const orderReads = getOrder.mock.calls.length;
    // What the author's own picture write does — and the socket for a picture-only `part_images_changed`.
    picture = { kind: 'photo', status: 'ready', v: 'fresh.jpg' };
    await act(async () => {
      invalidatePartImageViews(handle.client as QueryClient);
    });
    // the open dialog has the new picture, and the order — its figures — was not read again for it
    await waitFor(() =>
      expect(within(dialog).getByTestId('part-thumb-img')).toHaveAttribute('src', '/api/v1/product-parts/1/image?v=fresh.jpg&size=sm'),
    );
    expect(getOrder.mock.calls.length).toBe(orderReads);
    expect(screen.getByTestId('live-order-image')).not.toHaveTextContent('fresh.jpg');
  });
});

describe('the parts tab of «Add to order»', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getProductsPaged').mockResolvedValue(pageOf([], 0));
    vi.spyOn(api, 'getProductCategories').mockResolvedValue([]);
    vi.spyOn(api, 'getProductFacets').mockResolvedValue({ materials: [], colors: [], models: [] });
    vi.spyOn(api, 'getProductParts').mockResolvedValue(partsPage([part({ image: ready('t11') })]));
  });

  it('each part offered shows its picture', async () => {
    render(<AddToOrderDialog order={{ id: 5, code: 'OR-0005', name: 'Flasks for Acme', active: true }} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Parts of a product' }));
    const row = await screen.findByTestId('add-part-11');
    expect(within(row).getByTestId('part-thumb-img')).toHaveAttribute('src', src(11, 't11'));
  });
});
