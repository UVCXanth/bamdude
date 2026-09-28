import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { render } from '../../utils';
import { api } from '../../../api/client';
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

  it('says so when the note does not exist', async () => {
    vi.spyOn(api, 'getDispatchNote').mockRejectedValue(new Error('Dispatch note not found'));
    renderAt();
    expect(await screen.findByText('Dispatch note not found.')).toBeInTheDocument();
  });
});
