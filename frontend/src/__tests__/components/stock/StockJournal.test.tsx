import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { render } from '../../utils';
import { api, STOCK_ITEM_KINDS, STOCK_REASONS } from '../../../api/client';
import en from '../../../i18n/locales/en';
import uk from '../../../i18n/locales/uk';
import type { StockJournalPage } from '../../../api/client';
import { StockJournal } from '../../../components/stock/StockJournal';

const page1: StockJournalPage = {
  items: [
    {
      book: 'finished', id: 4, created_at: '2026-09-27T10:00:00', product_id: 1, product_name: 'Pipe',
      item: { id: 5, code: 'SK-0005', configuration: { choices: [], changed_parts: [] } },
      part_name: null, kind: 'issue', delta: 0, delta_on_hand: -2, delta_reserved: -2, note: null,
      customer: { id: 9, name: 'ACME' }, project: null, user: { id: 3, username: 'olena' },
    },
    {
      book: 'parts', id: 8, created_at: '2026-09-27T09:00:00', product_id: 1, product_name: 'Pipe',
      item: null, part_name: 'flask', kind: 'manual', delta: 3, delta_on_hand: 0, delta_reserved: 0,
      note: 'counted_by_operator', customer: null, project: null, user: null,
    },
  ],
  next_cursor: 'c1',
  meta: null,
};
const page2: StockJournalPage = {
  items: [
    {
      book: 'finished', id: 1, created_at: '2026-09-20T09:00:00', product_id: 1, product_name: 'Pipe',
      item: { id: 5, code: 'SK-0005', configuration: { choices: [], changed_parts: [] } },
      part_name: null, kind: 'receipt', delta: 0, delta_on_hand: 5, delta_reserved: 0, note: 'first batch',
      customer: null, project: null, user: null,
    },
  ],
  next_cursor: null,
  meta: null,
};

describe('StockJournal', () => {
  let get: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    get = vi.spyOn(api, 'getStockJournal').mockImplementation(async (params) => (params?.cursor ? page2 : page1));
    vi.spyOn(api, 'getProducts').mockResolvedValue([]);
    vi.spyOn(api, 'getSettings').mockResolvedValue({ date_format: 'system' } as never);
  });

  it('reads both ledgers as one feed, with who did it and for whom', async () => {
    render(<StockJournal />);
    const issue = await screen.findByTestId('journal-row-finished-4');
    expect(get).toHaveBeenLastCalledWith({ book: 'both', cursor: null, limit: 50 });
    expect(within(issue).getByText('SK-0005')).toBeInTheDocument();
    expect(within(issue).getByText('olena')).toBeInTheDocument();
    expect(within(issue).getByText(/ACME/)).toBeInTheDocument();
    expect(within(issue).getByText('Issued')).toBeInTheDocument();
    const part = screen.getByTestId('journal-row-parts-8');
    expect(within(part).getByText('flask')).toBeInTheDocument();
    expect(within(part).getByText('+3')).toBeInTheDocument();
    expect(within(part).getByText(/counted by the operator/)).toBeInTheDocument();
  });

  it("links an issue's movement to its dispatch note", async () => {
    // spec workshop-dispatch-notes, rule 23.
    get.mockResolvedValue({ items: [{ ...page1.items[0], issue: { id: 7, code: 'DN-0007' } }], next_cursor: null });
    render(<StockJournal />);
    const row = await screen.findByTestId('journal-row-finished-4');
    expect(within(row).getByRole('link', { name: 'DN-0007' })).toHaveAttribute('href', '/stock/dispatch-notes/7');
  });

  it('a finished-goods note is shown as typed, even when it spells a server token', async () => {
    get.mockResolvedValue({
      items: [{ ...page1.items[0], note: 'assembled' }],
      next_cursor: null,
    });
    render(<StockJournal />);
    const row = await screen.findByTestId('journal-row-finished-4');
    expect(within(row).getByText('assembled')).toBeInTheDocument();
    expect(within(row).queryByText('assembled into a stock position')).not.toBeInTheDocument();
  });

  it('the ledger filter asks the server again', async () => {
    render(<StockJournal />);
    await screen.findByTestId('journal-row-finished-4');
    fireEvent.change(screen.getByLabelText('Ledger'), { target: { value: 'finished' } });
    await waitFor(() => expect(get).toHaveBeenLastCalledWith({ book: 'finished', cursor: null, limit: 50 }));
  });

  it('«Show older» continues from the server cursor, and says when the ledger is done', async () => {
    render(<StockJournal />);
    await screen.findByTestId('journal-row-finished-4');
    fireEvent.click(screen.getByRole('button', { name: /show older/i }));
    expect(await screen.findByTestId('journal-row-finished-1')).toBeInTheDocument();
    expect(get).toHaveBeenLastCalledWith({ book: 'both', cursor: 'c1', limit: 50 });
    expect(await screen.findByText(/whole ledger/i)).toBeInTheDocument();
  });

  it('a position page asks for that position only', async () => {
    render(<StockJournal itemId={5} />);
    await screen.findByTestId('journal-row-finished-4');
    expect(get).toHaveBeenLastCalledWith({ book: 'both', item_id: 5, cursor: null, limit: 50 });
    expect(screen.queryByLabelText('Product')).not.toBeInTheDocument();
  });
});

describe('the stock journal · every kind and reason has a label', () => {
  it('names each movement of both books in both languages', () => {
    // The backend's closed lists — models/finished_stock.py::MOVEMENT_KINDS and
    // services/part_stock.py::REASONS (spec workshop-order-issue, rules 5–6).
    expect([...STOCK_ITEM_KINDS]).toEqual([
      'receipt',
      'stocktake',
      'assembled',
      'produced',
      'reserve',
      'release',
      'issue',
      'written_off',
    ]);
    for (const bundle of [en, uk]) {
      for (const kind of STOCK_ITEM_KINDS) expect(bundle.stock.journal.kind[kind]).toBeTruthy();
      for (const reason of STOCK_REASONS) expect(bundle.stock.reason[reason]).toBeTruthy();
    }
  });
});
