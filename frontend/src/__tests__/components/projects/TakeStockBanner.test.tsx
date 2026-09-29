import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from '../../utils';
import { api } from '../../../api/client';
import { TakeStockBanner } from '../../../components/projects/TakeStockBanner';

const offers = [
  { line_id: 7, product_name: 'Pipe', from_finished: 2, kits: 3 },
  { line_id: 8, product_name: 'Lamp', from_finished: 0, kits: 1 },
];

describe('TakeStockBanner', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getStockOffers').mockResolvedValue(offers);
  });

  it('lists what the shelves hold for the order', async () => {
    render(<TakeStockBanner orderId={5} />);
    expect(await screen.findByText('«Pipe» — 2 ready + 3 kits')).toBeInTheDocument();
    expect(screen.getByText('«Lamp» — 0 ready + 1 kits')).toBeInTheDocument();
  });

  it('takes exactly what it showed', async () => {
    const take = vi.spyOn(api, 'takeStock').mockResolvedValue({
      order: { id: 5 } as never,
      results: [
        { line_id: 7, asked_finished: 2, got_finished: 2, asked_kits: 3, got_kits: 3 },
        { line_id: 8, asked_finished: 0, got_finished: 0, asked_kits: 1, got_kits: 1 },
      ],
    });
    render(<TakeStockBanner orderId={5} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Take from stock' }));
    await waitFor(() =>
      expect(take).toHaveBeenCalledWith(5, {
        lines: [
          { line_id: 7, from_finished: 2, kits: 3 },
          { line_id: 8, from_finished: 0, kits: 1 },
        ],
      }),
    );
    expect(await screen.findByText('Taken from stock')).toBeInTheDocument();
  });

  it('says so when the shelf gave less than it showed', async () => {
    vi.spyOn(api, 'takeStock').mockResolvedValue({
      order: { id: 5 } as never,
      results: [
        { line_id: 7, asked_finished: 2, got_finished: 1, asked_kits: 3, got_kits: 3 },
        { line_id: 8, asked_finished: 0, got_finished: 0, asked_kits: 1, got_kits: 1 },
      ],
    });
    render(<TakeStockBanner orderId={5} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Take from stock' }));
    expect(await screen.findByText(/The shelf changed: Pipe: ready 1 of 2/)).toBeInTheDocument();
  });

  it('says the offers in one sentence, the way the mockup does (WS-13 E3 D05)', async () => {
    vi.spyOn(api, 'getStockOffers').mockResolvedValue([
      { line_id: 1, product_name: 'Lamp', from_finished: 2, kits: 2 },
      { line_id: 2, product_name: 'Base', from_finished: 0, kits: 1 },
    ]);
    render(<TakeStockBanner orderId={1} />);
    const banner = await screen.findByTestId('take-stock');
    expect(banner.querySelector('ul')).toBeNull();
    expect(banner).toHaveTextContent('In stock for this order: «Lamp» — 2 ready + 2 kits; «Base» — 0 ready + 1 kits. Take it — and print less.');
  });

  it('draws nothing when there is nothing to take', async () => {
    vi.spyOn(api, 'getStockOffers').mockResolvedValue([]);
    render(<TakeStockBanner orderId={5} />);
    await waitFor(() => expect(api.getStockOffers).toHaveBeenCalled());
    expect(screen.queryByTestId('take-stock')).not.toBeInTheDocument();
  });
});
