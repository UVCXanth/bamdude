import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from '../../utils';
import { api } from '../../../api/client';
import { AssembleDialog } from '../../../components/stock/AssembleDialog';
import { pipeDetail, pipeItem, pipeProduct } from './stockFixtures';

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

  // WS-13 E9 Codex review V01: a group with no standard option showed its first option
  // while the lookup and the assembly sent no choice at all.
  it('a group without a standard reads «No choice» and sends what it shows', async () => {
    const noStandard = { ...pipeProduct, variant_groups: pipeProduct.variant_groups.map((g) => ({ ...g, default_option_id: null })) };
    vi.spyOn(api, 'getProduct').mockResolvedValue(noStandard as never);
    const lookup = vi
      .spyOn(api, 'lookupStockItem')
      .mockResolvedValue({ item: null, configuration: { choices: [], changed_parts: [] }, can_assemble: 1, parts: [] });
    const send = vi.spyOn(api, 'assembleStock').mockResolvedValue(pipeItem);
    render(<AssembleDialog productId={1} onClose={() => {}} />);
    const select = (await screen.findByRole('combobox', { name: 'Tail' })) as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(select.selectedOptions[0]).toHaveTextContent('No choice');
    // The first option is a real choice: picking it sends its id.
    fireEvent.change(select, { target: { value: '100' } });
    await waitFor(() => expect(lookup).toHaveBeenLastCalledWith(1, [100]));
    // Back to «No choice»: the choice goes, never a 0.
    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() => expect(lookup).toHaveBeenLastCalledWith(1, []));
    await waitFor(() => expect(screen.getByTestId('assemble-submit')).toBeEnabled());
    fireEvent.click(screen.getByTestId('assemble-submit'));
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send.mock.calls[0][0]).toMatchObject({ product_id: 1, options: [] });
  });

  it('opened for one product: names it and reads no catalog', async () => {
    vi.spyOn(api, 'getProducts').mockResolvedValue([pipeProduct] as never);
    vi.spyOn(api, 'getProduct').mockResolvedValue(pipeProduct as never);
    vi.spyOn(api, 'lookupStockItem').mockResolvedValue({ item: null, configuration: pipeItem.configuration, can_assemble: 0, parts: [] });
    render(<AssembleDialog productId={1} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('stock-locked-product')).toHaveTextContent('PR-0001 · Pipe'));
    expect(api.getProducts).not.toHaveBeenCalled();
  });

  it('cannot assemble what the shelf does not hold', async () => {
    vi.spyOn(api, 'getStockItem').mockResolvedValue({ ...pipeDetail, can_assemble: 0 });
    render(<AssembleDialog item={pipeItem} onClose={() => {}} />);
    await screen.findByTestId('assemble-part-11');
    expect(screen.getByTestId('assemble-submit')).toBeDisabled();
  });
});
