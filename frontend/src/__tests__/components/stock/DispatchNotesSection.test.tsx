import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '../../utils';
import { api } from '../../../api/client';
import type { StockIssueRow } from '../../../api/client';
import { DispatchNotesSection } from '../../../components/stock/DispatchNotesSection';
import { formatDateTime } from '../../../utils/date';

const row = (over: Partial<StockIssueRow>): StockIssueRow => ({
  id: 1,
  code: 'DN-0001',
  created_at: '2026-09-27T10:00:00',
  project_id: 5,
  order_code: 'OR-0005',
  order_name: 'Hall lights',
  customer_id: 2,
  customer_name: 'ACME',
  units: 4,
  lines_count: 1,
  summary: [{ product_name: 'Lamp', part_name: null, quantity: 4, configuration: { choices: [], changed_parts: [] } }],
  recipient_name: 'Ivan',
  recipient_phone: '+380',
  delivery_method: 'Nova Poshta',
  delivery_details: null,
  waybill: null,
  note: null,
  created_by_name: 'olena',
  ...over,
});
const page = (items: StockIssueRow[], total = items.length, last = 1) => ({
  items,
  meta: { total, current_page: 1, per_page: 24, last_page: last },
});
const held = () => {
  let answer: (v: unknown) => void = () => {};
  let refuse: (e: Error) => void = () => {};
  const promise = new Promise((resolve, reject) => {
    answer = resolve;
    refuse = reject;
  });
  return { promise, answer, refuse };
};

describe('DispatchNotesSection', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps its heading and wrapper on the customer page — the tab mode is opt-in (WS-13 E3 R04)', async () => {
    vi.spyOn(api, 'getDispatchNotes').mockResolvedValue(page([row({})]));
    render(<DispatchNotesSection customerId={2} canEdit={false} />);
    expect(await screen.findByRole('heading', { name: 'Issues' })).toBeInTheDocument();
  });

  it('in the order’s tab a failed refresh of an empty list says so, with a retry (the V03 class)', async () => {
    const get = vi.spyOn(api, 'getDispatchNotes').mockResolvedValue(page([]));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    render(
      <QueryClientProvider client={client}>
        <DispatchNotesSection projectId={5} canEdit={false} inTab />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('No issues yet')).toBeInTheDocument();
    get.mockRejectedValue(new Error('boom'));
    await act(() => client.refetchQueries());
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByText(/Could not refresh/)).toBeInTheDocument();
  });

  it('in the order’s tab a failed read says so, with a retry — not «no issues»', async () => {
    const get = vi.spyOn(api, 'getDispatchNotes').mockRejectedValue(new Error('boom'));
    render(<DispatchNotesSection projectId={5} canEdit={false} inTab />);
    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(screen.queryByText('No issues yet')).toBeNull();
    get.mockResolvedValue(page([]));
    fireEvent.click(retry);
    expect(await screen.findByText('No issues yet')).toBeInTheDocument();
  });

  it('in the order’s tab: no heading of its own, and the wait and the empty list in words', async () => {
    let answer: (value: never) => void = () => {};
    vi.spyOn(api, 'getDispatchNotes').mockReturnValue(new Promise((resolve) => (answer = resolve)) as never);
    render(<DispatchNotesSection projectId={5} canEdit={false} inTab />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    answer(page([]) as never);
    expect(await screen.findByText('No issues yet')).toBeInTheDocument();
    // WS-13 E4 G02: the empty tab says where issues come from.
    expect(
      screen.getByText('Goods are issued through «Stock & issue»: each batch gets its own dispatch note.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading')).toBeNull();
  });

  describe("the customer page's states, by the key on screen (WS-13 E11 E08 / E09, R02)", () => {
    it('the first read says it is reading — never nothing', async () => {
      vi.spyOn(api, 'getDispatchNotes').mockReturnValue(new Promise(() => {}) as never);
      render(<DispatchNotesSection customerId={2} canEdit={false} />);
      expect(await screen.findByText('Loading...')).toBeInTheDocument();
    });

    it('the page names the section and its caption', async () => {
      vi.spyOn(api, 'getDispatchNotes').mockResolvedValue(page([row({})]));
      render(<DispatchNotesSection customerId={2} canEdit={false} title="Issues from stock" caption="every note" />);
      expect(await screen.findByRole('heading', { level: 2, name: 'Issues from stock' })).toBeInTheDocument();
      expect(screen.getByText('every note')).toBeInTheDocument();
    });

    it('a page of A is never shown under B, and B starts on its first page', async () => {
      const b = held();
      const get = vi.spyOn(api, 'getDispatchNotes').mockImplementation(((params: { customer_id?: number }) =>
        params.customer_id === 2 ? Promise.resolve(page([row({ id: 7, code: 'DN-0007' })], 30, 2)) : b.promise) as never);
      const { rerender } = render(<DispatchNotesSection key={2} customerId={2} canEdit={false} />);
      await screen.findByTestId('note-7');
      fireEvent.click(screen.getByRole('button', { name: /next/i }));
      await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ customer_id: 2, page: 2 })));
      rerender(<DispatchNotesSection key={9} customerId={9} canEdit={false} />);
      await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ customer_id: 9, page: 1 })));
      expect(screen.queryByTestId('note-7')).toBeNull();
      expect(screen.getByText('Loading...')).toBeInTheDocument();
      await act(async () => b.answer(page([row({ id: 8, code: 'DN-0008' })])));
      expect(await screen.findByTestId('note-8')).toBeInTheDocument();
    });

    it('a page on its way keeps the previous one dimmed; a refused page is an alert without rows or pages, and its retry asks for it again', async () => {
      const second = held();
      const get = vi.spyOn(api, 'getDispatchNotes').mockImplementation(((params: { page: number }) =>
        params.page === 1 ? Promise.resolve(page([row({ id: 7, code: 'DN-0007' })], 30, 2)) : second.promise) as never);
      render(<DispatchNotesSection customerId={2} canEdit={false} />);
      await screen.findByTestId('note-7');
      fireEvent.click(screen.getByRole('button', { name: /next/i }));
      await waitFor(() => expect(screen.getByTestId('dispatch-notes-body')).toHaveAttribute('aria-busy', 'true'));
      expect(screen.getByTestId('note-7')).toBeInTheDocument();
      await act(async () => second.refuse(new Error('HTTP 500')));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Could not load the dispatch notes.');
      expect(screen.queryByTestId('note-7')).toBeNull();
      expect(screen.queryByRole('button', { name: /next/i })).toBeNull();
      get.mockResolvedValue(page([row({ id: 9, code: 'DN-0009' })], 30, 2) as never);
      fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 })));
      expect(await screen.findByTestId('note-9')).toBeInTheDocument();
    });

    it('a failed refresh over an empty answer keeps «No issues yet.» and says the refresh failed', async () => {
      const get = vi.spyOn(api, 'getDispatchNotes').mockResolvedValue(page([]));
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
      render(
        <QueryClientProvider client={client}>
          <DispatchNotesSection customerId={2} canEdit={false} />
        </QueryClientProvider>,
      );
      expect(await screen.findByText('No issues yet.')).toBeInTheDocument();
      get.mockRejectedValue(new Error('boom'));
      await act(() => client.refetchQueries());
      expect(await screen.findByText(/Could not refresh/)).toBeInTheDocument();
      expect(screen.getByText('No issues yet.')).toBeInTheDocument();
    });

    it('an answer with fewer pages brings the page back to the last one — only by its own key', async () => {
      const get = vi.spyOn(api, 'getDispatchNotes').mockImplementation(((params: { page: number }) =>
        Promise.resolve(
          params.page === 1
            ? page([row({ id: 7, code: 'DN-0007' })], 30, 2)
            : { items: [], meta: { total: 10, current_page: 2, per_page: 24, last_page: 1 } },
        )) as never);
      render(<DispatchNotesSection customerId={2} canEdit={false} />);
      await screen.findByTestId('note-7');
      fireEvent.click(screen.getByRole('button', { name: /next/i }));
      await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 })));
      await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1 })));
    });
  });

  it("in the order's tab the previous answer is kept only for the same order (R02)", async () => {
    vi.spyOn(api, 'getDispatchNotes').mockImplementation(((params: { project_id?: number }) =>
      params.project_id === 5 ? Promise.resolve(page([row({ id: 7, code: 'DN-0007' })])) : new Promise(() => {})) as never);
    const { rerender } = render(<DispatchNotesSection projectId={5} canEdit={false} inTab />);
    await screen.findByTestId('note-7');
    rerender(<DispatchNotesSection projectId={6} canEdit={false} inTab />);
    await waitFor(() => expect(screen.queryByTestId('note-7')).toBeNull());
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it("lists a customer's notes the server pages, with codes as links", async () => {
    const get = vi
      .spyOn(api, 'getDispatchNotes')
      .mockResolvedValue(
        page([row({ id: 3, code: 'DN-0003', project_id: null, order_code: null, units: 1 }), row({ id: 2, code: 'DN-0002' })], 30, 2),
      );
    render(<DispatchNotesSection customerId={2} canEdit />);
    const manual = await screen.findByTestId('note-3');
    expect(within(manual).getByRole('link', { name: 'DN-0003' })).toHaveAttribute('href', '/stock/dispatch-notes/3');
    expect(within(manual).getByText('without an order')).toBeInTheDocument();
    const fromOrder = screen.getByTestId('note-2');
    expect(within(fromOrder).getByRole('link', { name: 'OR-0005' })).toHaveAttribute('href', '/projects/5');
    expect(within(fromOrder).getByText('Lamp × 4')).toBeInTheDocument();
    expect(within(fromOrder).queryByText('ACME')).toBeNull(); // the customer's own page
    expect(get).toHaveBeenCalledWith({ customer_id: 2, sort_by: 'created-desc', page: 1, per_page: 24 });
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    await waitFor(() =>
      expect(get).toHaveBeenLastCalledWith({ customer_id: 2, sort_by: 'created-desc', page: 2, per_page: 24 }),
    );
  });

  it('names a deleted order by its code, without a link', async () => {
    vi.spyOn(api, 'getDispatchNotes').mockResolvedValue(page([row({ id: 4, project_id: null, order_code: 'OR-0009' })]));
    render(<DispatchNotesSection customerId={2} canEdit={false} />);
    const found = await screen.findByTestId('note-4');
    expect(within(found).getByText('OR-0009')).toBeInTheDocument();
    expect(within(found).queryByRole('link', { name: 'OR-0009' })).toBeNull();
  });

  it('names a part «for» its product and says «+N more» past the summary', async () => {
    vi.spyOn(api, 'getDispatchNotes').mockResolvedValue(
      page([row({ id: 5, lines_count: 5, summary: [{ product_name: 'Pipe', part_name: 'flask', quantity: 2, configuration: null }] })]),
    );
    render(<DispatchNotesSection customerId={2} canEdit={false} />);
    expect(await screen.findByText('flask — for Pipe × 2')).toBeInTheDocument();
    expect(screen.getByText('+4 more')).toBeInTheDocument();
  });

  it('writes the waybill in its row afterwards', async () => {
    vi.spyOn(api, 'getDispatchNotes').mockResolvedValue(page([row({ id: 2 })]));
    const update = vi.spyOn(api, 'updateStockIssue').mockResolvedValue(row({ id: 2, waybill: '2045' }));
    render(<DispatchNotesSection customerId={2} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit the waybill' }));
    const input = screen.getByLabelText('Waybill no.');
    expect(input).toHaveAttribute('maxLength', '24');
    fireEvent.change(input, { target: { value: ' 2045 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(2, { waybill: '2045' }));
  });

  it('sorts on the server by a header', async () => {
    const get = vi.spyOn(api, 'getDispatchNotes').mockResolvedValue(page([row({ id: 2 })]));
    render(<DispatchNotesSection customerId={2} canEdit={false} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Qty' }));
    await waitFor(() =>
      expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ sort_by: 'units-desc', page: 1 })),
    );
  });

  it("says so for a customer with none, and an order's empty section is not drawn", async () => {
    const get = vi.spyOn(api, 'getDispatchNotes').mockResolvedValue(page([]));
    const { unmount } = render(<DispatchNotesSection customerId={2} canEdit={false} />);
    expect(await screen.findByText('No issues yet.')).toBeInTheDocument();
    unmount();
    render(<DispatchNotesSection projectId={5} canEdit={false} hideWhenEmpty />);
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ project_id: 5 })));
    expect(screen.queryByTestId('dispatch-notes-section')).toBeNull();
  });

  it("an order's section leaves the order column out", async () => {
    vi.spyOn(api, 'getDispatchNotes').mockResolvedValue(page([row({ id: 2 })]));
    render(<DispatchNotesSection projectId={5} canEdit={false} hideWhenEmpty />);
    const found = await screen.findByTestId('note-2');
    expect(within(found).queryByText('OR-0005')).toBeNull();
    expect(within(found).getByRole('link', { name: 'ACME' })).toHaveAttribute('href', '/customers/2');
  });

  it('reads the server time as UTC, as the app does', async () => {
    vi.spyOn(api, 'getSettings').mockResolvedValue({} as never);
    vi.spyOn(api, 'getDispatchNotes').mockResolvedValue(page([row({ id: 2, created_at: '2026-09-27T10:00:00' })]));
    render(<DispatchNotesSection customerId={2} canEdit={false} />);
    const found = await screen.findByTestId('note-2');
    expect(within(found).getByText(formatDateTime('2026-09-27T10:00:00'))).toBeInTheDocument();
  });
});
