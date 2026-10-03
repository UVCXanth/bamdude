/**
 * The dispatch notes' table (WS-13 E12 J01) and its waybill editor (J03, R08): the
 * mockup's eight columns, the configuration beside the name, «+N more» from the line
 * count, «Open» — and the waybill written under the code in a full edit cycle.
 */

import { useRef } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '../../utils';
import { api, ApiError } from '../../../api/client';
import type { StockIssueRow } from '../../../api/client';
import { DispatchNotesTable } from '../../../components/stock/DispatchNotesTable';
import { WaybillEditor } from '../../../components/stock/WaybillEditor';
import { DispatchNotesList } from '../../../components/stock/DispatchNotesList';

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const headers = () =>
  screen
    .getAllByRole('columnheader')
    .map((th) => (th.getAttribute('aria-label') ?? th.textContent ?? '').replace(/[▲▼]/g, '').trim());

describe('DispatchNotesTable (J01)', () => {
  const table = (items: StockIssueRow[], over: Partial<Parameters<typeof DispatchNotesTable>[0]> = {}) => {
    const onSortChange = vi.fn();
    render(
      <DispatchNotesTable
        items={items}
        sort="created-desc"
        onSortChange={onSortChange}
        canEdit={false}
        footer={<div data-testid="page-bar" />}
        {...over}
      />,
    );
    return { onSortChange };
  };

  it("eight columns in the mockup's order, inside the panel's own scroll; the page bar outside it", () => {
    table([row({})]);
    expect(headers()).toEqual(['Note', 'Date', 'Recipient', 'Order', 'Issued', 'Qty', 'Issued by', 'Actions']);
    const region = screen.getByRole('region', { name: 'Dispatch notes' });
    expect(region).toContainElement(screen.getByRole('table'));
    expect(region).not.toContainElement(screen.getByTestId('page-bar'));
  });

  it("a customer's own list leaves the recipient out; an order's leaves the order out", () => {
    const { unmount } = render(
      <DispatchNotesTable items={[row({})]} sort="created-desc" onSortChange={() => {}} canEdit={false} hideCustomer />,
    );
    expect(headers()).not.toContain('Recipient');
    unmount();
    table([row({})], { hideOrder: true });
    expect(headers()).not.toContain('Order');
  });

  it('the code opens the note; under it the waybill — or that there is none', () => {
    table([row({ id: 3, code: 'DN-0003', waybill: '2045' }), row({ id: 4, code: 'DN-0004' })]);
    const three = screen.getByTestId('note-3');
    expect(within(three).getByRole('link', { name: 'DN-0003' })).toHaveAttribute('href', '/stock/dispatch-notes/3');
    expect(within(three).getByText('Waybill 2045')).toBeInTheDocument();
    expect(within(screen.getByTestId('note-4')).getByText('No waybill')).toBeInTheDocument();
  });

  it('the recipient: the customer linked, the person under it when there is one', () => {
    table([row({ id: 3 }), row({ id: 4, recipient_name: null, customer_id: null })]);
    const three = screen.getByTestId('note-3');
    expect(within(three).getByRole('link', { name: 'ACME' })).toHaveAttribute('href', '/customers/2');
    expect(within(three).getByText('Ivan')).toBeInTheDocument();
    const four = screen.getByTestId('note-4');
    expect(within(four).queryByRole('link', { name: 'ACME' })).toBeNull();
    expect(within(four).queryByText('Ivan')).toBeNull();
  });

  it('the order: linked, a deleted one by its code, or «without an order»', () => {
    table([
      row({ id: 3 }),
      row({ id: 4, project_id: null, order_code: 'OR-0009' }),
      row({ id: 5, project_id: null, order_code: null }),
    ]);
    expect(within(screen.getByTestId('note-3')).getByRole('link', { name: 'OR-0005' })).toHaveAttribute('href', '/projects/5');
    expect(within(screen.getByTestId('note-4')).getByText('OR-0009')).toBeInTheDocument();
    expect(within(screen.getByTestId('note-4')).queryByRole('link', { name: 'OR-0009' })).toBeNull();
    expect(within(screen.getByTestId('note-5')).getByText('without an order')).toBeInTheDocument();
  });

  it('what was issued: the configuration beside the name in its accent — the standard unwritten; a part for its product; «+N more» from the line count', () => {
    table([
      row({
        id: 3,
        lines_count: 5,
        summary: [
          {
            product_name: 'Lamp',
            part_name: null,
            quantity: 4,
            configuration: {
              choices: [{ group_id: 1, group_name: 'Shade', option_id: 12, option_name: 'Large', is_default: false }],
              changed_parts: [],
            },
          },
          {
            product_name: 'Vase',
            part_name: null,
            quantity: 1,
            configuration: {
              choices: [{ group_id: 2, group_name: 'Glaze', option_id: 20, option_name: 'Clear', is_default: true }],
              changed_parts: [],
            },
          },
          { product_name: 'Pipe', part_name: 'flask', quantity: 2, configuration: null },
        ],
      }),
    ]);
    const lines = screen.getByTestId('note-3-lines');
    const shown = Array.from(lines.querySelectorAll('[data-line]')).map((l) => l.textContent);
    expect(shown).toEqual(['Lamp Shade: Large × 4', 'Vase × 1', 'flask — for Pipe × 2']);
    expect(within(lines).getByText('Shade: Large')).toHaveAttribute('data-config-accent');
    expect(within(lines).queryByText(/standard/)).toBeNull();
    expect(within(lines).getByText('+2 more')).toBeInTheDocument();
  });

  it('«Open» opens the note; the headers sort on the server', () => {
    // Final review M10: every row's «Open» names its note.
    const { onSortChange } = table([row({ id: 3, code: 'DN-0003' })]);
    expect(within(screen.getByTestId('note-3')).getByRole('link', { name: 'Open DN-0003' })).toHaveAttribute(
      'href',
      '/stock/dispatch-notes/3',
    );
    fireEvent.click(screen.getByRole('button', { name: /^Qty/ }));
    expect(onSortChange).toHaveBeenCalledWith('units-desc');
    fireEvent.click(screen.getByRole('button', { name: /^Recipient/ }));
    expect(onSortChange).toHaveBeenCalledWith('customer-asc');
  });
});

describe('WaybillEditor (J03, R08)', () => {
  let update: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    update = vi.spyOn(api, 'updateStockIssue').mockResolvedValue(row({ waybill: '2045' }));
  });

  const pencil = () => screen.getByRole('button', { name: 'Edit the waybill' });
  const field = () => screen.getByLabelText('Waybill no.') as HTMLInputElement;

  it('a reader sees the waybill and no pencil', () => {
    render(<WaybillEditor noteId={1} waybill="2045" canEdit={false} />);
    expect(screen.getByText('Waybill 2045')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit the waybill' })).toBeNull();
  });

  it('the pencil opens the field with the current value, the cursor in it', () => {
    render(<WaybillEditor noteId={1} waybill="2045" canEdit />);
    fireEvent.click(pencil());
    expect(field()).toHaveValue('2045');
    expect(field()).toHaveAttribute('maxLength', '24');
    expect(field()).toHaveFocus();
  });

  it('the draft is taken once: a re-read under it does not overwrite what is typed', () => {
    const { rerender } = render(<WaybillEditor noteId={1} waybill="2045" canEdit />);
    fireEvent.click(pencil());
    fireEvent.change(field(), { target: { value: '99' } });
    rerender(<WaybillEditor noteId={1} waybill="3000" canEdit />);
    expect(field()).toHaveValue('99');
  });

  it('Enter sends one PATCH, trimmed; a second Enter under it sends nothing', async () => {
    const sent = deferred<StockIssueRow>();
    update.mockReturnValue(sent.promise);
    render(<WaybillEditor noteId={1} waybill={null} canEdit />);
    fireEvent.click(pencil());
    fireEvent.change(field(), { target: { value: ' 2045 ' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    fireEvent.keyDown(field(), { key: 'Enter' });
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith(1, { waybill: '2045' });
    await act(async () => sent.resolve(row({ waybill: '2045' })));
  });

  // Final review M11: the saved waybill is what the row says at once — not the old one until
  // the list is read again; a later answer of the list still wins.
  it('after a save the new waybill shows at once, and the next answer of the list wins', async () => {
    update.mockResolvedValue(row({ waybill: '2045' }));
    const { rerender } = render(<WaybillEditor noteId={1} waybill={null} canEdit />);
    fireEvent.click(pencil());
    fireEvent.change(field(), { target: { value: '2045' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(await screen.findByText('Waybill 2045')).toBeInTheDocument();
    rerender(<WaybillEditor noteId={1} waybill="3000" canEdit />);
    expect(screen.getByText('Waybill 3000')).toBeInTheDocument();
  });

  it('an emptied field sends null', async () => {
    render(<WaybillEditor noteId={1} waybill="2045" canEdit />);
    fireEvent.click(pencil());
    fireEvent.change(field(), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(1, { waybill: null }));
  });

  it('an unchanged waybill sends nothing; the editor closes and the pencil has the focus', async () => {
    render(<WaybillEditor noteId={1} waybill="2045" canEdit />);
    fireEvent.click(pencil());
    fireEvent.change(field(), { target: { value: ' 2045' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(update).not.toHaveBeenCalled();
    await waitFor(() => expect(pencil()).toHaveFocus());
  });

  it('under the request the field is read-only, its buttons aria-disabled, and Escape does nothing', async () => {
    const sent = deferred<StockIssueRow>();
    update.mockReturnValue(sent.promise);
    render(<WaybillEditor noteId={1} waybill={null} canEdit />);
    fireEvent.click(pencil());
    fireEvent.change(field(), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(field()).toHaveAttribute('readOnly'));
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(field()).toBeInTheDocument();
    await act(async () => sent.resolve(row({ waybill: '7' })));
  });

  it('a refusal is said under the field in the system language; the text stays and the cursor is in it', async () => {
    update.mockRejectedValue(new ApiError('The waybill is at most 24 characters', 422));
    render(<WaybillEditor noteId={1} waybill={null} canEdit />);
    fireEvent.click(pencil());
    fireEvent.change(field(), { target: { value: 'ABC' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The waybill is at most 24 characters');
    expect(field()).toHaveValue('ABC');
    expect(field()).not.toHaveAttribute('readOnly');
    await waitFor(() => expect(field()).toHaveFocus());
  });

  it('a success refreshes the lists and the document, closes the editor and gives the focus to the pencil', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    render(
      <QueryClientProvider client={client}>
        <WaybillEditor noteId={1} waybill={null} canEdit />
      </QueryClientProvider>,
    );
    fireEvent.click(pencil());
    fireEvent.change(field(), { target: { value: '2045' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByLabelText('Waybill no.')).toBeNull());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['dispatch-notes'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['dispatch-note', 1] });
    await waitFor(() => expect(pencil()).toHaveFocus());
  });

  it('Escape and «Cancel» close the editor only — the focus goes back to the pencil', async () => {
    const outer = vi.fn();
    window.addEventListener('keydown', outer);
    render(<WaybillEditor noteId={1} waybill="2045" canEdit />);
    fireEvent.click(pencil());
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(screen.queryByLabelText('Waybill no.')).toBeNull();
    await waitFor(() => expect(pencil()).toHaveFocus());
    expect(outer).not.toHaveBeenCalled();
    window.removeEventListener('keydown', outer);
    fireEvent.click(pencil());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Waybill no.')).toBeNull();
    await waitFor(() => expect(pencil()).toHaveFocus());
    expect(update).not.toHaveBeenCalled();
  });
});

describe('DispatchNotesList — a row that leaves after its waybill changed (J03)', () => {
  function Harness() {
    const heading = useRef<HTMLHeadingElement>(null);
    return (
      <>
        <h1 ref={heading} tabIndex={-1}>
          Notes
        </h1>
        <DispatchNotesList
          params={{ q: 'OLD', sort_by: 'created-desc', page: 1, per_page: 24 }}
          sort="created-desc"
          onSortChange={() => {}}
          perPage={24}
          onPageChange={() => {}}
          onPerPageChange={() => {}}
          canEdit
          empty={<p>No notes</p>}
          fallbackRef={heading}
        />
      </>
    );
  }

  it('the focus goes to the stable heading when the search no longer holds the row', async () => {
    vi.restoreAllMocks();
    const list = vi
      .spyOn(api, 'getDispatchNotes')
      .mockResolvedValueOnce({ items: [row({ id: 3, waybill: 'OLD' })], meta: { total: 1, current_page: 1, per_page: 24, last_page: 1 } })
      .mockResolvedValue({ items: [], meta: { total: 0, current_page: 1, per_page: 24, last_page: 1 } });
    vi.spyOn(api, 'updateStockIssue').mockResolvedValue(row({ id: 3, waybill: 'NEW' }));
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit the waybill' }));
    fireEvent.change(screen.getByLabelText('Waybill no.'), { target: { value: 'NEW' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('note-3')).toBeNull());
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Notes' })).toHaveFocus());
  });
});
