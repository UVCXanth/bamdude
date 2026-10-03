/**
 * «Комірка й мінімум» — a position's storage settings (WS-13 E12 H01) in the narrow
 * Workshop dialog, with the move dialog's behaviour (G07).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from '../../utils';
import { api, ApiError } from '../../../api/client';
import { StockParamsDialog } from '../../../components/stock/StockParamsDialog';
import { pipeItem } from './stockFixtures';

const submit = () => screen.getByTestId('stock-params-submit');

describe('StockParamsDialog', () => {
  let update: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    update = vi.spyOn(api, 'updateStockItem').mockResolvedValue(pipeItem);
  });

  it('the narrow frame: «Storage settings» over the position, two fields side by side', async () => {
    render(<StockParamsDialog item={pipeItem} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog', { name: 'Storage settings' });
    expect(dialog).toHaveAccessibleDescription('Pipe · SK-0005 · standard');
    expect(dialog).toHaveStyle({ maxWidth: '448px' });
    const location = screen.getByLabelText('Location');
    expect(location).toHaveValue('A-1');
    expect(location).toHaveAttribute('placeholder', 'A-01');
    expect(location).toHaveAttribute('maxLength', '64');
    expect(screen.getByText('Empty — not assigned')).toBeInTheDocument();
    expect(screen.getByLabelText('Minimum stock, pcs')).toHaveValue(0);
    expect(submit()).toHaveTextContent('Save');
  });

  it('the cursor starts in the location', async () => {
    render(<StockParamsDialog item={pipeItem} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('Location')).toHaveFocus());
  });

  it('saves the location and the minimum of the position, says so and closes', async () => {
    const onClose = vi.fn();
    render(<StockParamsDialog item={pipeItem} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'B-02' } });
    fireEvent.change(screen.getByLabelText('Minimum stock, pcs'), { target: { value: '10' } });
    fireEvent.click(submit());
    await waitFor(() => expect(update).toHaveBeenCalledWith(5, { location: 'B-02', min_qty: 10 }));
    expect(await screen.findByText('The position was updated.')).toBeInTheDocument();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('an emptied location is «not assigned»', async () => {
    render(<StockParamsDialog item={pipeItem} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: '  ' } });
    fireEvent.click(submit());
    await waitFor(() => expect(update).toHaveBeenCalledWith(5, { location: null, min_qty: 0 }));
  });

  it.each(['-1', '1.5', ''])('a minimum of «%s» is not sent, and the field says why', async (value) => {
    render(<StockParamsDialog item={pipeItem} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Minimum stock, pcs'), { target: { value } });
    expect(submit()).toBeDisabled();
    expect(submit()).toHaveAccessibleDescription('A whole number from 0');
  });

  it('a refusal stays in the slot: the focus on the primary, the fields as typed; one press, one request', async () => {
    update.mockRejectedValue(new ApiError('The location is too long', 422));
    const onClose = vi.fn();
    render(<StockParamsDialog item={pipeItem} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'C-9' } });
    fireEvent.click(submit());
    fireEvent.click(submit());
    expect(await screen.findByRole('alert')).toHaveTextContent('The location is too long');
    expect(update).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(submit()).toHaveFocus());
    expect(screen.getByLabelText('Location')).toHaveValue('C-9');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('nothing closes the dialog while the save is on its way', async () => {
    let finish!: (value: typeof pipeItem) => void;
    update.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const onClose = vi.fn();
    render(<StockParamsDialog item={pipeItem} onClose={onClose} />);
    fireEvent.click(submit());
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => finish(pipeItem));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
