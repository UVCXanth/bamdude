import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Routes } from 'react-router';
import { render } from '../../utils';
import { ApiError, api } from '../../../api/client';
import { formatDateTime } from '../../../utils/date';
import type { DispatchNote } from '../../../api/client';
import { DispatchNotePage } from '../../../pages/stock/DispatchNotePage';

const note: DispatchNote = {
  id: 42,
  code: 'DN-0042',
  created_at: '2026-09-28T09:30:00',
  project_id: 5,
  order_code: 'OR-0005',
  order_name: 'Hall lights',
  customer_id: 2,
  customer_name: 'ACME',
  units: 5,
  lines_count: 2,
  summary: [],
  recipient_name: 'Ivan',
  recipient_phone: '+380',
  delivery_method: 'Nova Poshta',
  delivery_details: 'Kyiv, branch 5',
  waybill: '2045',
  note: 'fragile',
  created_by_name: 'olena',
  supplier: { name: 'BamDude Workshop', address: 'Kyiv', phone: '', code: '1234', iban: '' },
  lines: [
    {
      position: 1,
      product_id: 1,
      product_name: 'Lamp',
      sku: 'LMP-1',
      configuration: {
        choices: [{ group_id: 1, group_name: 'Colour', option_id: 2, option_name: 'Black', is_default: false }],
        changed_parts: [],
      },
      part_name: null,
      quantity: 3,
    },
    {
      position: 2,
      product_id: null,
      product_name: 'Pipe',
      sku: null,
      configuration: { choices: [], changed_parts: [] },
      part_name: 'flask',
      quantity: 2,
    },
  ],
};

const renderAt = () => {
  window.history.pushState({}, '', '/stock/dispatch-notes/42');
  return render(
    <Routes>
      <Route path="/stock/dispatch-notes/:id" element={<DispatchNotePage />} />
    </Routes>,
  );
};

describe('DispatchNotePage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    window.history.pushState({}, '', '/');
  });

  it('draws the document from the snapshot', async () => {
    const get = vi.spyOn(api, 'getDispatchNote').mockResolvedValue(note);
    renderAt();
    const sheet = await screen.findByTestId('dispatch-note-sheet');
    expect(get).toHaveBeenCalledWith(42);
    expect(within(sheet).getByText(/Dispatch note № DN-0042/)).toBeInTheDocument();
    expect(within(sheet).getAllByText('BamDude Workshop').length).toBeGreaterThan(0);
    expect(within(sheet).getByText('Code: 1234')).toBeInTheDocument();
    expect(within(sheet).getByText('ACME')).toBeInTheDocument();
    expect(within(sheet).getByText('Order OR-0005')).toBeInTheDocument();
    expect(within(sheet).getByText('Hall lights')).toBeInTheDocument();
    expect(within(sheet).getByText('Colour: Black')).toBeInTheDocument();
    expect(within(sheet).getByText('flask — for Pipe')).toBeInTheDocument();
    expect(within(sheet).getAllByText('pcs')).toHaveLength(2);
    expect(within(sheet).getByTestId('dispatch-note-total')).toHaveTextContent('5');
    expect(within(sheet).getByText('Items in total: 2')).toBeInTheDocument();
    expect(within(sheet).getByText('olena')).toBeInTheDocument();
    expect(within(sheet).getByText('Waybill 2045')).toBeInTheDocument();
    expect(within(sheet).getByText('fragile')).toBeInTheDocument();
  });

  it('is a white sheet marked for print, and the controls above it do not print', async () => {
    vi.spyOn(api, 'getDispatchNote').mockResolvedValue(note);
    renderAt();
    const sheet = await screen.findByTestId('dispatch-note-sheet');
    expect(sheet.className).toContain('bg-white');
    expect(sheet).toHaveAttribute('data-print-sheet');
    expect(screen.getByTestId('dispatch-note-controls').className).toContain('print:hidden');
  });

  it('prints with the browser', async () => {
    vi.spyOn(api, 'getDispatchNote').mockResolvedValue(note);
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    renderAt();
    fireEvent.click(await screen.findByRole('button', { name: 'Print' }));
    expect(print).toHaveBeenCalled();
  });

  it('says «issue from stock» without an order, and «—» without a supplier', async () => {
    vi.spyOn(api, 'getDispatchNote').mockResolvedValue({
      ...note,
      project_id: null,
      order_code: null,
      order_name: null,
      supplier: { name: '', address: '', phone: '', code: '', iban: '' },
    });
    renderAt();
    const sheet = await screen.findByTestId('dispatch-note-sheet');
    expect(within(sheet).getByText('Issue from stock')).toBeInTheDocument();
    expect(within(sheet).getByTestId('dispatch-note-supplier')).toHaveTextContent('—');
  });

  it('says so when the note does not exist, with the way back to the notes', async () => {
    vi.spyOn(api, 'getDispatchNote').mockRejectedValue(new ApiError('Dispatch note not found', 404));
    renderAt();
    expect(await screen.findByText('Dispatch note not found.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the notes' })).toHaveAttribute('href', '/stock?tab=notes');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a failure that is not «not found» is an alert with its retry (final review M4, E12 J04)', async () => {
    const get = vi.spyOn(api, 'getDispatchNote').mockRejectedValueOnce(new ApiError('Internal Server Error', 500));
    renderAt();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load the dispatch note.');
    expect(screen.queryByText('Dispatch note not found.')).not.toBeInTheDocument();
    get.mockResolvedValue(note);
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('dispatch-note-sheet')).toBeInTheDocument();
  });

  describe('the page around the sheet (WS-13 E12 J04)', () => {
    it('the first read is a skeleton', async () => {
      vi.spyOn(api, 'getDispatchNote').mockReturnValue(new Promise(() => {}) as never);
      renderAt();
      expect(await screen.findByTestId('dispatch-note-skeleton')).toHaveAttribute('role', 'status');
    });

    it('is a Workshop page: the heading, the date · order · name · customer — linked only where they exist', async () => {
      vi.spyOn(api, 'getSettings').mockResolvedValue({} as never);
      vi.spyOn(api, 'getDispatchNote').mockResolvedValue(note);
      renderAt();
      const controls = await screen.findByTestId('dispatch-note-controls');
      expect(controls.closest('.workshop')).not.toBeNull();
      expect(within(controls).getByRole('heading', { level: 1, name: 'Dispatch note DN-0042' })).toBeInTheDocument();
      const sub = within(controls).getByTestId('dispatch-note-subtitle');
      expect(sub).toHaveTextContent(`${formatDateTime('2026-09-28T09:30:00')} · OR-0005 · Hall lights · ACME`);
      expect(within(sub).getByRole('link', { name: 'OR-0005' })).toHaveAttribute('href', '/projects/5');
      expect(within(sub).getByRole('link', { name: 'ACME' })).toHaveAttribute('href', '/customers/2');
    });

    // Final review M5 (K): a re-read that failed keeps the note and says so, above the sheet.
    it('a re-read that failed keeps the note and says so above it', async () => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      vi.spyOn(api, 'getDispatchNote').mockResolvedValueOnce(note).mockRejectedValue(new Error('HTTP 500'));
      window.history.pushState({}, '', '/stock/dispatch-notes/42');
      render(
        <QueryClientProvider client={client}>
          <Routes>
            <Route path="/stock/dispatch-notes/:id" element={<DispatchNotePage />} />
          </Routes>
        </QueryClientProvider>,
      );
      await screen.findByTestId('dispatch-note-sheet');
      await act(async () => {
        await client.invalidateQueries({ queryKey: ['dispatch-note'] });
      });
      const controls = screen.getByTestId('dispatch-note-controls');
      expect(await within(controls).findByText('Could not refresh')).toBeInTheDocument();
      expect(screen.getByTestId('dispatch-note-sheet')).toBeInTheDocument();
    });

    it('a deleted order and customer are named, not linked', async () => {
      vi.spyOn(api, 'getDispatchNote').mockResolvedValue({ ...note, project_id: null, customer_id: null });
      renderAt();
      const sub = await screen.findByTestId('dispatch-note-subtitle');
      expect(sub).toHaveTextContent('OR-0005');
      expect(within(sub).queryAllByRole('link')).toHaveLength(0);
    });

    it('the waybill row carries its editor above the sheet', async () => {
      vi.spyOn(api, 'getDispatchNote').mockResolvedValue(note);
      const update = vi.spyOn(api, 'updateStockIssue').mockResolvedValue({ ...note, waybill: '3000' } as never);
      renderAt();
      const controls = await screen.findByTestId('dispatch-note-controls');
      expect(within(controls).getByText('Waybill 2045')).toBeInTheDocument();
      fireEvent.click(within(controls).getByRole('button', { name: 'Edit the waybill' }));
      fireEvent.change(within(controls).getByLabelText('Waybill no.'), { target: { value: '3000' } });
      fireEvent.click(within(controls).getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(update).toHaveBeenCalledWith(42, { waybill: '3000' }));
    });

    it('the sheet names the configuration in full — every changed part by name and count (R07)', async () => {
      vi.spyOn(api, 'getDispatchNote').mockResolvedValue({
        ...note,
        lines: [
          {
            ...note.lines[0],
            configuration: {
              choices: [{ group_id: 1, group_name: 'Colour', option_id: 2, option_name: 'Black', is_default: false }],
              changed_parts: [{ part_id: 9, name: 'Lid', qty: 2, standard_qty: 1 }],
            },
          },
        ],
      });
      renderAt();
      const sheet = await screen.findByTestId('dispatch-note-sheet');
      expect(within(sheet).getByText('Colour: Black · Lid × 2')).toBeInTheDocument();
      expect(within(sheet).queryByText(/part changed/)).toBeNull();
    });

    // E12 pilot (390 px): the sheet widened the whole page. It scrolls in a region of its own.
    it('a narrow screen scrolls the sheet, never the page', async () => {
      vi.spyOn(api, 'getDispatchNote').mockResolvedValue(note);
      renderAt();
      const sheet = await screen.findByTestId('dispatch-note-sheet');
      const region = screen.getByRole('region', { name: 'Dispatch note DN-0042' });
      expect(region).toContainElement(sheet);
      expect(region.className).toContain('overflow-x-auto');
      expect(sheet.className).toContain('print:min-w-0');
    });

    it('the parties, the header and the signatures are kept whole on paper', async () => {
      vi.spyOn(api, 'getDispatchNote').mockResolvedValue(note);
      renderAt();
      const sheet = await screen.findByTestId('dispatch-note-sheet');
      expect(sheet.querySelectorAll('[data-print-keep]').length).toBeGreaterThanOrEqual(3);
    });
  });

  it('heads the page with the date and time and the way back to the stock (final review M3)', async () => {
    vi.spyOn(api, 'getSettings').mockResolvedValue({} as never);
    vi.spyOn(api, 'getDispatchNote').mockResolvedValue(note);
    renderAt();
    const controls = await screen.findByTestId('dispatch-note-controls');
    expect(within(controls).getByText(formatDateTime('2026-09-28T09:30:00'))).toBeInTheDocument();
    expect(within(controls).getByRole('link', { name: 'Stock' })).toHaveAttribute('href', '/stock');
    expect(within(controls).getByRole('link', { name: 'Dispatch notes' })).toHaveAttribute('href', '/stock?tab=notes');
  });

  it('links a product that still exists, and names the parts a line changed (final review M10, M11)', async () => {
    vi.spyOn(api, 'getDispatchNote').mockResolvedValue({
      ...note,
      lines: [
        {
          ...note.lines[0],
          configuration: {
            choices: [],
            changed_parts: [{ part_id: 9, name: 'shade', qty: 2, standard_qty: 1 }],
          },
        },
        note.lines[1],
      ],
    });
    renderAt();
    const sheet = await screen.findByTestId('dispatch-note-sheet');
    expect(within(sheet).getByRole('link', { name: 'Lamp' })).toHaveAttribute('href', '/products/1');
    // The deleted product (product_id null) is text, not a link.
    expect(within(sheet).queryByRole('link', { name: /Pipe/ })).toBeNull();
    expect(within(sheet).getByText('shade × 2')).toBeInTheDocument();
  });
});
