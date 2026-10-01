import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { render } from '../../utils';
import { api } from '../../../api/client';
import type { OrderListItem, OrderListPage } from '../../../api/client';
import { OrdersWorkspace } from '../../../components/projects/OrdersWorkspace';
import { NO_ACTIONS, WithOrderActions } from '../../fixtures/orderActionsHost';
import { ORDER_ROW_DEFAULTS } from '../../wireDefaults';

const row = (over: Partial<OrderListItem>): OrderListItem => ({
  ...ORDER_ROW_DEFAULTS,
  id: 1, code: 'OR-0001', name: 'Ten flasks', customer_id: 2, customer_name: 'ACME', color: null, status: 'active',
  stage: 'prep', responsible_id: null, responsible_name: null, due_date: '2026-10-03T00:00:00', priority: 'normal',
  price: null, tags: null, cover_image_filename: null, created_at: '2026-09-01T00:00:00Z', lines_count: 1, ordered: 10,
  printed: 4, covered_units: 4, remaining: 6, from_stock_units: 0, progress: 0.4, prints_in_progress: 0,
  prints_queued: 0, line_products: [], ...over,
}) as OrderListItem;

const page = (items: OrderListItem[]): OrderListPage => ({
  items,
  meta: { total: items.length, current_page: 1, per_page: 24, last_page: 1 },
  totals: { active: items.length, completed: 0, cancelled: 0, all: items.length, stages: { prep: 0, printing: 0, qc: 0 } },
}) as OrderListPage;

const ROWS = [row({ id: 1 }), row({ id: 2, code: 'OR-0002', name: 'Lamp', stage: 'qc', customer_name: 'Globex' })];

/** The detail the right pane reads — only what its header needs to name the order. */
const detail = (id: number, name: string) => ({
  id, code: `OR-000${id}`, name, customer_id: 2, customer_name: 'ACME', description: null, color: null, status: 'active',
  stage: 'prep', responsible_id: null, responsible_name: null, notes: null, attachments: null, tags: null,
  due_date: null, priority: 'normal', price: null, url: null, cover_image_filename: null,
  created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z', procurement: [], other_archive_ids: [], counts: { prints: 0, issues: 0 },
  lines: [],
  figures: { ordered: 0, printed: 0, covered_units: 0, complete: 0, remaining: 0, total_time_seconds: 0,
    total_filament_grams: 0, total_cost: 0, defective: 0, margin: null, progress: 0, other_prints_count: 0,
    all_printed: false, bankable_surplus: 0 },
});

/** Two columns from a 761 px viewport (WS-13 E7 G01) — the mockup's and the spec's edge. */
function screenIsWide(wide: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: wide && query.includes('min-width: 761px'),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }) as unknown as MediaQueryList,
  );
}

const props = { isError: false, onRetry: () => {}, isPlaceholderData: false, perPage: 24, onPageChange: () => {}, onPerPageChange: () => {}, actions: NO_ACTIONS };

afterEach(() => {
  window.history.pushState({}, '', '/');
});

describe('OrdersWorkspace', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.pushState({}, '', '/projects');
    vi.spyOn(api, 'getOrder').mockImplementation(async (id: number) => detail(id, id === 2 ? 'Lamp' : 'Ten flasks') as never);
    vi.spyOn(api, 'getOrderPlan').mockResolvedValue({
      lines: [],
      totals: { rows: 0, prints: 0, print_time_seconds: 0, filament_used_grams: 0, cost: null },
    });
    screenIsWide(true);
  });
  it('shows the first order of the page when nothing is picked', async () => {
    render(<OrdersWorkspace data={page(ROWS)} {...props} picked={null} onPick={() => {}} />);
    expect(await screen.findByRole('heading', { name: 'Ten flasks' })).toBeInTheDocument();
  });
  it('shows the picked order, and the first one when the pick is not on this page', async () => {
    const { unmount } = render(<OrdersWorkspace data={page(ROWS)} {...props} picked={2} onPick={() => {}} />);
    expect(await screen.findByRole('heading', { name: 'Lamp' })).toBeInTheDocument();
    unmount();
    render(<OrdersWorkspace data={page(ROWS)} {...props} picked={99} onPick={() => {}} />);
    expect(await screen.findByRole('heading', { name: 'Ten flasks' })).toBeInTheDocument();
  });
  it('a click on a row picks it, and the picked row says so', async () => {
    const onPick = vi.fn();
    render(<OrdersWorkspace data={page(ROWS)} {...props} picked={1} onPick={onPick} />);
    const rows = await screen.findByRole('list', { name: 'Orders' });
    expect(within(rows).getByRole('button', { name: /Ten flasks/ })).toHaveAttribute('aria-current', 'true');
    fireEvent.click(within(rows).getByRole('button', { name: /Lamp/ }));
    expect(onPick).toHaveBeenCalledWith(2);
  });
  it('a row shows code, deadline, stage, name, customer and coverage', async () => {
    render(<OrdersWorkspace data={page(ROWS)} {...props} picked={null} onPick={() => {}} />);
    const lamp = within(await screen.findByRole('list', { name: 'Orders' })).getByRole('button', { name: /Lamp/ });
    expect(lamp).toHaveTextContent('OR-0002');
    expect(lamp).toHaveTextContent(new Date(2026, 9, 3).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }));
    expect(lamp).toHaveTextContent('Quality check');
    expect(lamp).toHaveTextContent('Globex');
    expect(within(lamp).getByText('4 / 10')).toBeInTheDocument();
  });
  // WS-13 E7 G06: at 760 and narrower the list stands above the shown order — not a list of links.
  it('on a narrow screen the list stands above the shown order, and a pick scrolls to it', async () => {
    screenIsWide(false);
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const onPick = vi.fn();
    const { rerender } = render(<OrdersWorkspace data={page(ROWS)} {...props} picked={null} onPick={onPick} />);
    const rows = await screen.findByRole('list', { name: 'Orders' });
    expect(within(rows).queryByRole('link')).not.toBeInTheDocument();
    const pane = await screen.findByRole('heading', { name: 'Ten flasks' });
    // The pane comes after the list in the document — stacked, not beside it.
    expect(rows.compareDocumentPosition(pane) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(within(rows).getByRole('button', { name: /Lamp/ }));
    expect(onPick).toHaveBeenCalledWith(2);
    rerender(<OrdersWorkspace data={page(ROWS)} {...props} picked={2} onPick={onPick} />);
    await screen.findByRole('heading', { name: 'Lamp' });
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    expect(within(rows).getByRole('button', { name: /Lamp/ })).toHaveAttribute('aria-current', 'true');
  });
  it('deleting the shown order moves the pane on to the next one at once', async () => {
    const onPick = vi.fn();
    vi.spyOn(api, 'deleteOrder').mockResolvedValue(undefined as never);
    // The delete runs through the PAGE's action host (WS-13 E6 B01) — the pane passes its own way out.
    // One answer of the list, as `useQuery` hands it: the skip of the deleted row is tied to it.
    const data = page(ROWS);
    render(<WithOrderActions>{(actions) => <OrdersWorkspace data={data} {...props} actions={actions} picked={null} onPick={onPick} />}</WithOrderActions>);
    await screen.findByRole('heading', { name: 'Ten flasks' });
    fireEvent.click(screen.getByRole('button', { name: /^Order actions/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /^delete$/i }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Delete order?' })).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(onPick).toHaveBeenCalledWith(null));
    // The list has not been read again yet — the deleted row is still in it — and the pane is already on the next.
    expect(await screen.findByRole('heading', { name: 'Lamp' })).toBeInTheDocument();
  });
  it('the next answer of the list ends the skip — an order that reuses the id shows', async () => {
    vi.spyOn(api, 'deleteOrder').mockResolvedValue(undefined as never);
    const hosted = (data: ReturnType<typeof page>, picked: number | null) => (
      <WithOrderActions>{(actions) => <OrdersWorkspace data={data} {...props} actions={actions} picked={picked} onPick={() => {}} />}</WithOrderActions>
    );
    const first = page(ROWS);
    const { rerender } = render(hosted(first, 2));
    await screen.findByRole('heading', { name: 'Lamp' });
    fireEvent.click(screen.getByRole('button', { name: /^Order actions/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /^delete$/i }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Delete order?' })).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.deleteOrder).toHaveBeenCalledWith(2));
    // SQLite without AUTOINCREMENT gives the newest id to the next order created.
    rerender(hosted(page([ROWS[0], row({ id: 2, code: 'OR-0002', name: 'Reborn' })]), null));
    expect(await within(screen.getByRole('list', { name: 'Orders' })).findByRole('button', { name: /Reborn/ })).toBeInTheDocument();
  });
  it('keeps an open action on its own order when the pane moves to another (WS-13 E6 R02)', async () => {
    // The host lives on the page, the pane is keyed by order: an action opened for
    // order 1 must not follow the pane to order 2, nor close when order 1 leaves the page.
    const state = vi.spyOn(api, 'getFulfilment').mockReturnValue(new Promise(() => {}));
    vi.spyOn(api, 'getDeliveryMethods').mockResolvedValue([]);
    const first = page(ROWS);
    const hosted = (data: ReturnType<typeof page>) => (
      <WithOrderActions>{(actions) => <OrdersWorkspace data={data} {...props} actions={actions} picked={null} onPick={() => {}} />}</WithOrderActions>
    );
    const { rerender } = render(hosted(first));
    await screen.findByRole('heading', { name: 'Ten flasks' });
    fireEvent.click(screen.getByRole('button', { name: 'Order actions OR-0001' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mark completed' }));
    expect(await screen.findByRole('dialog', { name: /Stock & issue/ })).toBeInTheDocument();

    // A refetch drops order 1 — the pane falls back to order 2.
    rerender(hosted(page([ROWS[1]])));
    await waitFor(() => expect(api.getOrder).toHaveBeenCalledWith(2));
    expect(screen.getByRole('dialog', { name: /Stock & issue/ })).toBeInTheDocument();
    expect(state).toHaveBeenCalledWith(1);
    expect(state).not.toHaveBeenCalledWith(2);
  });
  it('the pane is the order without the page chrome — no breadcrumb, not the page heading', async () => {
    render(<OrdersWorkspace data={page(ROWS)} {...props} picked={null} onPick={() => {}} />);
    const heading = await screen.findByRole('heading', { name: 'Ten flasks' });
    expect(heading.tagName).toBe('H2');
    expect(screen.queryByRole('navigation', { name: /breadcrumb/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Orders' })).not.toBeInTheDocument();
  });
  describe('WS-13 E7 G', () => {
    it('says so when the order the URL names is not on this page, and links to it', async () => {
      render(<OrdersWorkspace data={page(ROWS)} {...props} picked={99} onPick={() => {}} />);
      const note = await screen.findByTestId('workspace-fallback');
      expect(note).toHaveAttribute('role', 'status');
      expect(note).toHaveTextContent('The chosen order is not on this page — showing OR-0001');
      expect(within(note).getByRole('link', { name: 'Open the chosen order' })).toHaveAttribute('href', '/projects/99');
    });

    it('says nothing when the pick is on the page, when nothing is picked, or while the next page loads', async () => {
      const { unmount } = render(<OrdersWorkspace data={page(ROWS)} {...props} picked={2} onPick={() => {}} />);
      await screen.findByRole('heading', { name: 'Lamp' });
      expect(screen.queryByTestId('workspace-fallback')).not.toBeInTheDocument();
      unmount();
      const second = render(<OrdersWorkspace data={page(ROWS)} {...props} picked={null} onPick={() => {}} />);
      await screen.findByRole('heading', { name: 'Ten flasks' });
      expect(screen.queryByTestId('workspace-fallback')).not.toBeInTheDocument();
      second.unmount();
      render(<OrdersWorkspace data={page(ROWS)} {...props} isPlaceholderData picked={99} onPick={() => {}} />);
      await screen.findByRole('list', { name: 'Orders' });
      expect(screen.queryByTestId('workspace-fallback')).not.toBeInTheDocument();
    });

    it('a failed page is an alert with a retry — no rows, no pane', async () => {
      const retry = vi.fn();
      render(<OrdersWorkspace data={undefined} {...props} isError onRetry={retry} picked={1} onPick={() => {}} />);
      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent('Could not load the orders');
      fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
      expect(retry).toHaveBeenCalled();
      expect(screen.queryByRole('list', { name: 'Orders' })).not.toBeInTheDocument();
      expect(api.getOrder).not.toHaveBeenCalled();
    });

    it('a failed re-read keeps its rows and pane under a note', async () => {
      render(<OrdersWorkspace data={page(ROWS)} {...props} isError picked={null} onPick={() => {}} />);
      expect(await screen.findByRole('heading', { name: 'Ten flasks' })).toBeInTheDocument();
      expect(screen.getByText('Could not refresh')).toBeInTheDocument();
    });

    it('keeps the list in one sticky panel with its page bar pinned to the bottom of it', async () => {
      render(<OrdersWorkspace data={page(ROWS)} {...props} picked={null} onPick={() => {}} />);
      const panel = await screen.findByTestId('workspace-list');
      expect(panel.className).toContain('sticky');
      expect(panel.className).toContain('overflow-y-auto');
      const bar = within(panel).getByTestId('workspace-pager');
      expect(bar.className).toContain('sticky');
      expect(bar.className).toContain('bottom-0');
      const chosen = within(panel).getByRole('button', { name: /Ten flasks/ });
      expect(chosen).toHaveAttribute('aria-current', 'true');
      expect(chosen.className).toContain('shadow-[inset_3px_0_0');
    });
  });
});
