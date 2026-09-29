import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { render } from '../../utils';
import { api } from '../../../api/client';
import type { OrderListItem, OrderListPage } from '../../../api/client';
import { OrdersWorkspace } from '../../../components/projects/OrdersWorkspace';

const row = (over: Partial<OrderListItem>): OrderListItem => ({
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
  created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z', procurement: [], other_archive_ids: [],
  lines: [],
  figures: { ordered: 0, printed: 0, covered_units: 0, complete: 0, remaining: 0, total_time_seconds: 0,
    total_filament_grams: 0, total_cost: 0, defective: 0, margin: null, progress: 0, other_prints_count: 0,
    all_printed: false, bankable_surplus: 0 },
});

/** Tailwind's `lg` — the workspace has two columns only from there (spec rule 13). */
function screenIsWide(wide: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: wide && query.includes('min-width: 1024px'),
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

const props = { isLoading: false, isPlaceholderData: false, perPage: 24, onPageChange: () => {}, onPerPageChange: () => {} };

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
    expect(lamp).toHaveTextContent(new Date('2026-10-03T00:00:00').toLocaleDateString());
    expect(lamp).toHaveTextContent('Quality check');
    expect(lamp).toHaveTextContent('Globex');
    expect(within(lamp).getByText('4 / 10')).toBeInTheDocument();
  });
  it('on a narrow screen a row is a link to the order page and nothing is fetched beside it', async () => {
    screenIsWide(false);
    render(<OrdersWorkspace data={page(ROWS)} {...props} picked={null} onPick={() => {}} />);
    const rows = await screen.findByRole('list', { name: 'Orders' });
    expect(within(rows).getByRole('link', { name: /Lamp/ })).toHaveAttribute('href', '/projects/2');
    expect(api.getOrder).not.toHaveBeenCalled();
  });
  it('deleting the shown order moves the pane on to the next one at once', async () => {
    const onPick = vi.fn();
    vi.spyOn(api, 'deleteOrder').mockResolvedValue(undefined as never);
    render(<OrdersWorkspace data={page(ROWS)} {...props} picked={null} onPick={onPick} />);
    await screen.findByRole('heading', { name: 'Ten flasks' });
    fireEvent.click(screen.getByRole('button', { name: /^Order actions/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /^delete$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^confirm$/i }));
    await waitFor(() => expect(onPick).toHaveBeenCalledWith(null));
    // The list has not been read again yet — the deleted row is still in it — and the pane is already on the next.
    expect(await screen.findByRole('heading', { name: 'Lamp' })).toBeInTheDocument();
  });
  it('the next answer of the list ends the skip — an order that reuses the id shows', async () => {
    vi.spyOn(api, 'deleteOrder').mockResolvedValue(undefined as never);
    const { rerender } = render(<OrdersWorkspace data={page(ROWS)} {...props} picked={2} onPick={() => {}} />);
    await screen.findByRole('heading', { name: 'Lamp' });
    fireEvent.click(screen.getByRole('button', { name: /^Order actions/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /^delete$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^confirm$/i }));
    await waitFor(() => expect(api.deleteOrder).toHaveBeenCalledWith(2));
    // SQLite without AUTOINCREMENT gives the newest id to the next order created.
    rerender(<OrdersWorkspace data={page([ROWS[0], row({ id: 2, code: 'OR-0002', name: 'Reborn' })])} {...props} picked={null} onPick={() => {}} />);
    expect(await within(screen.getByRole('list', { name: 'Orders' })).findByRole('button', { name: /Reborn/ })).toBeInTheDocument();
  });
  it('the pane is the order without the page chrome — no breadcrumb, not the page heading', async () => {
    render(<OrdersWorkspace data={page(ROWS)} {...props} picked={null} onPick={() => {}} />);
    const heading = await screen.findByRole('heading', { name: 'Ten flasks' });
    expect(heading.tagName).toBe('H2');
    expect(screen.queryByRole('navigation', { name: /breadcrumb/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Orders' })).not.toBeInTheDocument();
  });
});
