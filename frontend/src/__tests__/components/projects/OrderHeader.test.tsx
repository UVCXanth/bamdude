/**
 * The order header (WS-13 E3 §C): a compact meta line, the title, one row of
 * facts in a fixed order, and the actions — a few visible, the rest in one menu.
 *
 * ⚠️ «Bank the surplus» is shown only while there is something to bank (E3 C03,
 * spec D02 «conditional surplus action»). Its gate is `figures.bankable_surplus`
 * — the surplus MINUS what the order has already banked, summed by the server
 * (Ruling 30); a gate on the surplus itself stayed lit for ever, because banking
 * never lowers it. The header asks the server nothing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';
import { render } from '../../utils';
import { api } from '../../../api/client';
import type { Order, Permission } from '../../../api/client';
import { OrderHeader } from '../../../components/projects/OrderHeader';
import { makeFigures, makeOrder } from '../../fixtures/orderDetail';

const auth = vi.hoisted(() => ({ granted: null as Set<string> | null }));

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

const noop = () => {};

function mount(
  order: Order,
  { run = noop, embedded = false, fulfilment }: {
    /** The page's action host (WS-13 E6 B01) — every button and menu item runs through it. */
    run?: (...args: unknown[]) => void;
    embedded?: boolean;
    fulfilment?: { primary: boolean };
  } = {},
) {
  render(
    <OrderHeader
      order={order}
      actions={{ run, create: noop }}
      extra={{ order }}
      embedded={embedded}
      fulfilment={fulfilment}
    />,
  );
}

const withBankable = (bankable: number) => makeOrder({ figures: makeFigures({ bankable_surplus: bankable }) });

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'Order actions OR-0001' }));
  return screen.getByRole('menu');
}

beforeEach(() => {
  vi.restoreAllMocks();
  auth.granted = null;
  vi.spyOn(api, 'getSettings').mockResolvedValue({ currency: 'USD' } as never);
});

describe('OrderHeader · meta line and title', () => {
  it('puts the code and the day the order was made above the title', () => {
    mount(makeOrder());
    expect(screen.getByTestId('order-meta')).toHaveTextContent(/^OR-0001 · created /);
    expect(screen.getByRole('heading', { level: 1, name: 'Ten flasks' })).toBeInTheDocument();
  });

  it('is an h2 inside the workspace, where the page has its own h1', () => {
    mount(makeOrder(), { embedded: true });
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'Ten flasks' })).toBeInTheDocument();
  });
});

describe('OrderHeader · facts', () => {
  it('lists the facts in the fixed order, each only when there is something to say', () => {
    mount(
      makeOrder({
        contact_id: 10,
        contact: { id: 10, code: 'CT-0010', name: 'Olena', role: null, phone: null, email: null },
        priority: 'high',
        due_date: '2099-01-10',
        responsible_id: 2,
        responsible_name: 'ira',
        url: 'https://example.com/brief',
        tags: 'series, PETG',
      }),
    );
    const facts = screen.getByTestId('order-facts');
    expect([...facts.querySelectorAll<HTMLElement>('[data-fact]')].map((el) => el.dataset.fact)).toEqual([
      'customer',
      'contact',
      'status',
      'priority',
      'due',
      'responsible',
      'price',
      'url',
      'tags',
    ]);
  });

  it('shows the lifecycle status, not the stage — the stage row says that', () => {
    mount(makeOrder({ stage: 'qc' }));
    const facts = screen.getByTestId('order-facts');
    expect(within(facts).getByText('Active')).toBeInTheDocument();
    expect(within(facts).queryByText('Quality check')).toBeNull();
  });

  it('marks an overdue deadline and says so in words, not only in red', () => {
    mount(makeOrder({ due_date: '2020-01-10' }));
    const due = screen.getByTestId('order-facts').querySelector('[data-fact="due"]') as HTMLElement;
    expect(due).toHaveAttribute('data-overdue', 'true');
    expect(due).toHaveTextContent(/overdue/);
  });

  it('writes a dash for a missing deadline and «not assigned» for nobody responsible', () => {
    mount(makeOrder({ due_date: null, responsible_id: null, responsible_name: null }));
    const facts = screen.getByTestId('order-facts');
    expect(facts.querySelector('[data-fact="due"]')).toHaveTextContent('Deadline —');
    expect(facts.querySelector('[data-fact="responsible"]')).toHaveTextContent('not assigned');
  });

  it('shows the margin of the price over the cost WITH purchases', () => {
    mount(makeOrder({ price: 120, figures: makeFigures({ margin: 112, margin_with_procurement: 100 }) }));
    const price = screen.getByTestId('order-facts').querySelector('[data-fact="price"]') as HTMLElement;
    expect(price).toHaveTextContent('$120.00');
    expect(price).toHaveTextContent('$100.00');
    expect(price).not.toHaveTextContent('$112.00');
  });

  it('writes a dash for a margin it cannot know, and says why', () => {
    mount(
      makeOrder({
        price: 120,
        figures: makeFigures({ procurement_partial: true, cost_with_procurement: null, margin_with_procurement: null }),
      }),
    );
    const margin = screen.getByTestId('order-margin');
    expect(margin).toHaveTextContent('—');
    expect(margin).toHaveAttribute('title', expect.stringMatching(/purchased parts/i));
  });

  it('says nothing about price or margin for an order without a price', () => {
    mount(makeOrder({ price: null }));
    expect(screen.getByTestId('order-facts').querySelector('[data-fact="price"]')).toBeNull();
  });

  it('writes each tag as #tag', () => {
    mount(makeOrder({ tags: 'series, PETG' }));
    const tags = screen.getByTestId('order-facts').querySelector('[data-fact="tags"]') as HTMLElement;
    expect(tags).toHaveTextContent('#series');
    expect(tags).toHaveTextContent('#PETG');
  });
});

describe('OrderHeader · description', () => {
  it('shows the description under the facts, keeping its line breaks', () => {
    mount(makeOrder({ description: 'Line one\nLine two' }));
    const text = screen.getByTestId('order-description');
    expect(text).toHaveTextContent('Line one Line two');
    expect(text).toHaveClass('whitespace-pre-line');
  });

  it('draws nothing for an empty or blank description', () => {
    mount(makeOrder({ description: '  \n ' }));
    expect(screen.queryByTestId('order-description')).not.toBeInTheDocument();
  });
});

describe('OrderHeader · contact person', () => {
  it('shows who receives it, with a phone link', () => {
    mount(
      makeOrder({
        contact_id: 10,
        contact: { id: 10, code: 'CT-0010', name: 'Olena', role: null, phone: '+380 1', email: null },
      }),
    );
    expect(screen.getByText(/contact: Olena/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '+380 1' })).toHaveAttribute('href', 'tel:+3801');
  });

  it('names a nameless contact by its role, as the customer pages do', () => {
    mount(
      makeOrder({
        contact_id: 11,
        contact: { id: 11, code: 'CT-0011', name: null, role: 'Warehouse', phone: null, email: null },
      }),
    );
    expect(screen.getByText(/contact: Warehouse/)).toBeInTheDocument();
  });

  it('says nothing about a contact when the order has none', () => {
    mount(makeOrder({ contact_id: null, contact: null }));
    expect(screen.queryByText(/contact:/)).not.toBeInTheDocument();
  });
});

describe('OrderHeader · bank the surplus', () => {
  it('is not offered while there is nothing to bank', () => {
    mount(withBankable(0));
    expect(screen.queryByTestId('order-bank-surplus')).not.toBeInTheDocument();
  });

  it('is offered with the count while there is, and hands the press up', () => {
    const run = vi.fn();
    mount(withBankable(5), { run });

    const button = screen.getByTestId('order-bank-surplus');
    expect(button).toHaveTextContent('(5)');
    fireEvent.click(button);
    // ⚠️ The header does not POST: the page's action host owns the call (E6 B01).
    expect(run).toHaveBeenCalledWith('bank', expect.objectContaining({ id: 1, bankable_surplus: 5 }), expect.anything());
  });

  it('is not offered to a reader, whatever the count (spec §I1, R08)', () => {
    auth.granted = new Set(['orders:read', 'products:read', 'customers:read', 'stock:read']);
    mount(withBankable(5));
    expect(screen.queryByTestId('order-bank-surplus')).not.toBeInTheDocument();
  });
});

describe('OrderHeader · actions', () => {
  it('shows Edit and the issue dialog, and opens the dialog', () => {
    const run = vi.fn();
    mount(makeOrder(), { run, fulfilment: { primary: true } });

    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('order-fulfilment'));
    // The visible button asks for no close (E6 B04, R09): the dialog's own rule decides.
    expect(run).toHaveBeenCalledWith('fulfil', expect.objectContaining({ id: 1 }), expect.objectContaining({ mode: 'all', complete: false }));
  });

  it('draws no issue button when there is nothing to do', () => {
    mount(makeOrder());
    expect(screen.queryByTestId('order-fulfilment')).not.toBeInTheDocument();
  });

  it('keeps the rest of an active order’s actions in one menu, and nothing about an «auto» stage', () => {
    mount(makeOrder());
    const menu = openMenu();
    // The one order menu of WS-13 E6 B02 — «Stock & issue…» joined it (O10).
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Edit',
      'Duplicate…',
      'Stock & issue…',
      'Mark completed',
      'Cancel',
      'Cover…',
      'Delete',
    ]);
    expect(within(menu).queryByRole('menuitem', { name: /auto/i })).toBeNull();
  });

  it('offers Reopen instead of Complete / Cancel on a closed order', () => {
    mount(makeOrder({ status: 'completed', stage: 'done' }));
    const items = within(openMenu()).getAllByRole('menuitem').map((item) => item.textContent);
    expect(items).toContain('Reopen');
    expect(items).not.toContain('Mark completed');
    expect(items).not.toContain('Cancel');
  });

  it('hands «Cover…» up to the page', () => {
    const run = vi.fn();
    mount(makeOrder(), { run });
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'Cover…' }));
    expect(run).toHaveBeenCalledWith('cover', expect.objectContaining({ id: 1 }), expect.objectContaining({ order: expect.anything() }));
  });

  it('gives a reader no actions at all — no buttons and no menu', () => {
    auth.granted = new Set(['orders:read', 'products:read', 'customers:read', 'stock:read']);
    mount(makeOrder());
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Order actions OR-0001' })).toBeNull();
  });

  it('opens the full page from the workspace, with a name that says so', () => {
    mount(makeOrder(), { embedded: true });
    const open = screen.getByRole('link', { name: 'Open the full page of order OR-0001' });
    expect(open).toHaveAttribute('href', '/projects/1');
    expect(open).toHaveTextContent('Open');
  });

  it('offers no such link on the page itself', () => {
    mount(makeOrder());
    expect(screen.queryByRole('link', { name: /full page/ })).toBeNull();
  });
});

describe('OrderHeader · cover', () => {
  it('shows the cover as a small picture that opens the cover dialog for an editor', () => {
    const run = vi.fn();
    mount(makeOrder({ cover_image_filename: 'cover.png' }), { run });
    fireEvent.click(screen.getByRole('button', { name: 'Change cover' }));
    expect(run).toHaveBeenCalledWith('cover', expect.objectContaining({ id: 1 }), expect.anything());
    expect(screen.getByTestId('order-cover-image')).toHaveAttribute('src', api.getProjectCoverImageUrl(1));
  });

  it('shows a reader the picture alone, named', () => {
    auth.granted = new Set(['orders:read', 'products:read', 'customers:read', 'stock:read']);
    mount(makeOrder({ cover_image_filename: 'cover.png' }));
    expect(screen.queryByRole('button', { name: 'Change cover' })).toBeNull();
    expect(screen.getByRole('img', { name: 'Cover of Ten flasks' })).toBeInTheDocument();
  });

  it('draws no picture when there is no cover', () => {
    mount(makeOrder());
    expect(screen.queryByTestId('order-cover-image')).toBeNull();
  });
});
