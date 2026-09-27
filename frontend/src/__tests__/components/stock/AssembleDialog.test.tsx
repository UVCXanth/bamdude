import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from '../../utils';
import { api } from '../../../api/client';
import { AssembleDialog } from '../../../components/stock/AssembleDialog';
import { pipeDetail, pipeItem } from './stockFixtures';

describe('AssembleDialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the kit against the shelf and sends the position and the count', async () => {
    vi.spyOn(api, 'getStockItem').mockResolvedValue(pipeDetail);
    const assemble = vi.spyOn(api, 'assembleStock').mockResolvedValue(pipeItem);
    render(<AssembleDialog item={pipeItem} onClose={() => {}} />);
    expect(await screen.findByTestId('assemble-part-11')).toHaveTextContent('flask');
    expect(screen.getByText('up to 1')).toBeInTheDocument();
    expect(screen.getByTestId('assemble-shelf-12')).not.toHaveClass('text-status-warning');
    fireEvent.change(screen.getByLabelText('How many'), { target: { value: '2' } });
    expect(screen.getByTestId('assemble-shelf-12')).toHaveClass('text-status-warning');
    fireEvent.change(screen.getByLabelText('How many'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('assemble-submit'));
    await waitFor(() => expect(assemble).toHaveBeenCalledWith({ item_id: 5, qty: 1 }));
  });

  it('cannot assemble what the shelf does not hold', async () => {
    vi.spyOn(api, 'getStockItem').mockResolvedValue({ ...pipeDetail, can_assemble: 0 });
    render(<AssembleDialog item={pipeItem} onClose={() => {}} />);
    await screen.findByTestId('assemble-part-11');
    expect(screen.getByTestId('assemble-submit')).toBeDisabled();
  });
});
