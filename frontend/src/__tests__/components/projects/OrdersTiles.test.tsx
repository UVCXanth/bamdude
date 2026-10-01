import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils';
import { api } from '../../../api/client';
import { OrdersTiles } from '../../../components/projects/OrdersTiles';

const summary = { active: 4, overdue: 1, urgent: 2, printing: 3, queued: 7, remaining: 12, all_covered: 9, qc: 2 };

describe('OrdersTiles', () => {
  beforeEach(() => vi.restoreAllMocks());

  // WS-13 E7 C02: the fourth tile is the QC stage, never «all covered» (O02).
  it('counts the QC stage in the fourth tile, in the mockup words', async () => {
    vi.spyOn(api, 'getOrdersSummary').mockResolvedValue(summary);
    render(<OrdersTiles />);
    const qc = await screen.findByTestId('orders-tile-qc');
    expect(qc).toHaveTextContent('In quality control');
    await waitFor(() => expect(qc).toHaveTextContent('2'));
    expect(qc).not.toHaveTextContent('9');
    expect(screen.getByTestId('orders-tile-active')).toHaveTextContent('1 overdue · 2 urgent');
    expect(screen.getByTestId('orders-tile-printing')).toHaveTextContent('3 / 7');
    expect(screen.queryByTestId('orders-tile-covered')).not.toBeInTheDocument();
  });

  it('shows dashes and one retry when the summary could not be read', async () => {
    const get = vi.spyOn(api, 'getOrdersSummary').mockRejectedValue(new Error('down'));
    render(<OrdersTiles />);
    const retry = await screen.findByRole('button', { name: 'Retry' }, { timeout: 4000 });
    expect(screen.getByTestId('orders-tile-qc')).toHaveTextContent('—');
    get.mockResolvedValue(summary);
    await userEvent.click(retry);
    await waitFor(() => expect(screen.getByTestId('orders-tile-qc')).toHaveTextContent('2'));
  });
});
