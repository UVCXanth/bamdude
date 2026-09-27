import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from '../../utils';
import { api } from '../../../api/client';
import { StockParamsDialog } from '../../../components/stock/StockParamsDialog';
import { pipeItem } from './stockFixtures';

describe('StockParamsDialog', () => {
  it('saves the location and the minimum of the position', async () => {
    const update = vi.spyOn(api, 'updateStockItem').mockResolvedValue(pipeItem);
    const onClose = vi.fn();
    render(<StockParamsDialog item={pipeItem} onClose={onClose} />);
    expect(screen.getByLabelText('Location')).toHaveValue('A-1');
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'B-02' } });
    fireEvent.change(screen.getByLabelText('Minimum'), { target: { value: '10' } });
    fireEvent.click(screen.getByTestId('stock-params-submit'));
    await waitFor(() => expect(update).toHaveBeenCalledWith(5, { location: 'B-02', min_qty: 10 }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('an emptied location is «not assigned»', async () => {
    const update = vi.spyOn(api, 'updateStockItem').mockResolvedValue(pipeItem);
    render(<StockParamsDialog item={pipeItem} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: '  ' } });
    fireEvent.click(screen.getByTestId('stock-params-submit'));
    await waitFor(() => expect(update).toHaveBeenCalledWith(5, { location: null, min_qty: 0 }));
  });
});
