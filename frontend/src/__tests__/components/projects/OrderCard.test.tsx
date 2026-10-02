import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { render } from '../../utils';
import { strayZeroTextNodes } from '../../domHelpers';
import type { OrderListItem } from '../../../api/client';
import { OrderCard } from '../../../components/projects/OrderCard';
import type { Readiness } from '../../../components/projects/orderRow/readiness';
import { ORDER_ROW_DEFAULTS } from '../../wireDefaults';

// Every entry of the card menu is permission-gated, and the render helper's
// real `AuthProvider` resolves an admin only once its own request has settled —
// which is after the synchronous clicks below. Only the hook is replaced.
vi.mock('../../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../contexts/AuthContext')>();
  return { ...actual, useAuth: () => ({ ...actual.useAuth(), hasPermission: () => true }) };
});

const base: OrderListItem = {
  ...ORDER_ROW_DEFAULTS,
  id: 1, code: 'OR-0001', name: 'Ten flasks', customer_id: 2, customer_name: 'ACME', color: '#00ae42', status: 'active',
  stage: 'printing', responsible_id: null, responsible_name: null, due_date: null, priority: 'normal', price: 120, tags: null,
  cover_image_filename: null, created_at: '2026-09-01T00:00:00Z', lines_count: 2, ordered: 10, printed: 4, covered_units: 4,
  remaining: 6, from_stock_units: 0, issued_units: 0, progress: 0.4, prints_in_progress: 2, prints_queued: 3, line_products: [],
  products: [{ product_id: 11, has_cover: true }, { product_id: 12, has_cover: false }],
};
const noop = () => {};
const actions = { run: noop, create: noop };
const eta: Readiness = { kind: 'eta', eta: '2026-10-06T09:00:00Z', late: false, after: null, reasons: [], assumptions: [] };
const card = (order: OrderListItem = base, readiness: Readiness = eta, act = actions) =>
  render(<OrderCard order={order} actions={act} readiness={readiness} />);

describe('OrderCard (WS-13 E7 E)', () => {
  it('reads top to bottom as the mockup: rail, thumbnails · code · stage, name, customer, coverage, 2×2, footer', () => {
    card();
    const parts = Array.from(screen.getByTestId('order-1-card').querySelectorAll('[data-part]')).map((el) => el.getAttribute('data-part'));
    expect(parts).toEqual(['rail', 'top', 'name', 'customer', 'coverage', 'meta', 'footer']);
    const top = screen.getByTestId('order-1-card').querySelector('[data-part="top"]') as HTMLElement;
    expect(within(top).getByTestId('order-1-thumbs')).toBeInTheDocument();
    expect(top).toHaveTextContent('OR-0001');
    expect(top).toHaveTextContent('Printing');
  });

  it('draws the order colour as a 3 px rail, a neutral one without a colour', () => {
    const { unmount } = card();
    const rail = screen.getByTestId('order-1-card').querySelector('[data-part="rail"]') as HTMLElement;
    expect(rail).toHaveStyle({ backgroundColor: '#00ae42' });
    expect(rail.className).toContain('h-[3px]');
    unmount();
    card({ ...base, color: null });
    const plain = screen.getByTestId('order-1-card').querySelector('[data-part="rail"]') as HTMLElement;
    expect(plain.className).toContain('bg-bambu-dark-tertiary');
  });

  it('links the whole card to the order through an overlay named by the order', () => {
    card();
    expect(screen.getByRole('link')).toHaveAttribute('href', '/projects/1');
    expect(screen.getByRole('link')).toHaveAccessibleName('Ten flasks');
    expect(screen.getByRole('heading', { name: 'Ten flasks' })).toBeInTheDocument();
  });

  it('shows due, ready ≈, print / queue and what is left in a 2×2 block', () => {
    card({ ...base, due_date: '2099-10-07T00:00:00' });
    const meta = within(screen.getByTestId('order-1-card').querySelector('[data-part="meta"]') as HTMLElement);
    expect(meta.getAllByRole('term').map((t) => t.textContent)).toEqual(['Due', 'Ready ≈', 'Print / queue', 'Left']);
    const values = meta.getAllByRole('definition');
    expect(values[1]).toHaveTextContent(new Date(2026, 9, 6).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }));
    expect(values[2]).toHaveTextContent('2 / 3');
    expect(values[3]).toHaveTextContent('6 units');
  });

  it('names the customer or says there is none, with a non-normal priority beside it', () => {
    const { unmount } = card({ ...base, priority: 'urgent' });
    const customer = screen.getByTestId('order-1-card').querySelector('[data-part="customer"]') as HTMLElement;
    expect(customer).toHaveTextContent('ACME');
    expect(customer).toHaveTextContent('Urgent');
    unmount();
    card({ ...base, customer_id: null, customer_name: null });
    expect(screen.getByTestId('order-1-card').querySelector('[data-part="customer"]')).toHaveTextContent('No customer');
  });

  it('puts the responsible person left and the menu right in the footer', () => {
    const { unmount } = card({ ...base, responsible_name: 'ira' });
    const footer = within(screen.getByTestId('order-1-card').querySelector('[data-part="footer"]') as HTMLElement);
    expect(footer.getByText('ira')).toBeInTheDocument();
    expect(footer.getByTestId('order-1-menu')).toBeInTheDocument();
    unmount();
    card();
    expect(screen.getByText('unassigned')).toBeInTheDocument();
  });

  it('shows three tiles at most and an honest «+N» for the rest', () => {
    const many = [11, 12, 13, 14, 15].map((product_id) => ({ product_id, has_cover: false }));
    card({ ...base, products: many });
    expect(screen.getAllByTestId('product-cover-placeholder')).toHaveLength(3);
    expect(screen.getByLabelText('2 more products')).toHaveTextContent('+2');
  });

  it('an order with nothing ordered yet shows no bar and no stray zero', () => {
    card({ ...base, ordered: 0, printed: 0, covered_units: 0, remaining: 0, progress: 0, lines_count: 0, products: [] }, { kind: 'closed' });
    expect(screen.queryByTestId('order-1-progress')).not.toBeInTheDocument();
    expect(strayZeroTextNodes(screen.getByTestId('order-1-card'))).toHaveLength(0);
  });

  // V04 (Codex r1): the assumptions' hint sits in the «Ready ≈» cell, above the card's overlay link.
  it('hints the forecast’s assumptions in «Ready ≈», above the overlay link', () => {
    card(base, { ...eta, assumptions: ['stagger'] });
    const hint = screen.getByLabelText(/^Not counted in this estimate:/);
    expect(hint.closest('[data-part="meta"]')).not.toBeNull();
    expect(hint.className).toContain('z-10');
  });

  it('flags an overdue active order beside its deadline', () => {
    card({ ...base, due_date: '2020-01-02T00:00:00' });
    expect(screen.getByTestId('order-1-due')).toHaveTextContent('· overdue');
  });

  it('a closed card carries its own status and no estimate', () => {
    card({ ...base, status: 'completed', stage: 'done' }, { kind: 'closed' });
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.getByTestId('order-1-ready-value')).toHaveTextContent('—');
  });

  describe('actions menu', () => {
    it('renders the open menu outside the card anchor, on document.body', () => {
      card();
      fireEvent.click(screen.getByTestId('order-1-menu'));
      const panel = screen.getByRole('menu');
      expect(panel.parentElement).toBe(document.body);
      expect(screen.getByRole('link').contains(panel)).toBe(false);
      expect(screen.getByTestId('order-1-card').querySelector('[role="menu"]')).toBeNull();
    });

    it('acts on the item that was clicked, and closes', () => {
      const run = vi.fn();
      card(base, eta, { run, create: noop });
      fireEvent.click(screen.getByTestId('order-1-menu'));
      fireEvent.click(screen.getByRole('menuitem', { name: /edit/i }));
      expect(run).toHaveBeenCalledWith('edit', expect.objectContaining({ id: 1, code: 'OR-0001' }), { order: base });
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    it('closes on Escape', () => {
      card();
      fireEvent.click(screen.getByTestId('order-1-menu'));
      expect(screen.getByRole('menu')).toBeInTheDocument();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    it('names the trigger as a menu before it is opened', () => {
      card();
      const trigger = screen.getByTestId('order-1-menu');
      expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
      fireEvent.click(trigger);
      expect(trigger).toHaveAttribute('aria-expanded', 'true');
    });
  });
});
