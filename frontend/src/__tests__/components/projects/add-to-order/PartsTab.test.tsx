import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { render } from '../../../utils';
import { api } from '../../../../api/client';
import { AddToOrderDialog } from '../../../../components/projects/add-to-order/AddToOrderDialog';
import { pageOf, part, partsPage } from './fixtures';

describe('the parts tab of «Add to order»', () => {
  let getParts: ReturnType<typeof vi.spyOn>;
  let add: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getProductsPaged').mockResolvedValue(pageOf([], 0));
    vi.spyOn(api, 'getProductCategories').mockResolvedValue([]);
    vi.spyOn(api, 'getProductFacets').mockResolvedValue({ materials: [], colors: [], models: ['P1S', 'X1C'] });
    getParts = vi.spyOn(api, 'getProductParts').mockResolvedValue(
      partsPage([
        part({}),
        part({ part_id: 12, name: 'Elbow', variant: { group: 'Tail', option: 'angled' } }),
        part({ part_id: 21, name: 'Shade', product: { id: 2, code: 'PR-0002', name: 'Lamp', sku: null }, models: [] }),
      ]),
    );
    add = vi.spyOn(api, 'addOrderLines').mockResolvedValue({ order: { id: 5, lines: [] } as never, results: [] });
  });

  function open() {
    render(<AddToOrderDialog orderId={5} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Parts of a product' }));
  }

  it('lists a server page of parts, searched and filtered by printer model', async () => {
    open();
    expect(await screen.findByTestId('add-part-11')).toBeInTheDocument();
    expect(getParts).toHaveBeenLastCalledWith({ page: 1, per_page: 24 });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'elbow' } });
    await waitFor(() => expect(getParts).toHaveBeenLastCalledWith({ page: 1, per_page: 24, q: 'elbow' }));
    fireEvent.change(await screen.findByLabelText('Printer model'), { target: { value: 'X1C' } });
    await waitFor(() => expect(getParts).toHaveBeenLastCalledWith({ page: 1, per_page: 24, q: 'elbow', model: 'X1C' }));
  });

  it('names the option a part belongs to and the product it comes from', async () => {
    open();
    const elbow = await screen.findByTestId('add-part-12');
    expect(within(elbow).getByText('Tail: angled')).toBeInTheDocument();
    expect(within(elbow).getByText('Pipe · PP-1 · PR-0001')).toBeInTheDocument();
    expect(within(screen.getByTestId('add-part-21')).getByText('Lamp · PR-0002')).toBeInTheDocument();
  });

  it('parts of one product become one line', async () => {
    open();
    for (const id of [11, 12, 21]) fireEvent.click(within(await screen.findByTestId(`add-part-${id}`)).getByRole('checkbox'));
    fireEvent.change(within(screen.getByTestId('add-part-12')).getByLabelText('Pieces'), { target: { value: '3' } });
    expect(screen.getByText('Selected parts: 3 · 5 pcs')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add parts' }));
    await waitFor(() =>
      expect(add).toHaveBeenCalledWith(5, [
        { kind: 'parts', product_id: 1, part_counts: { 11: 1, 12: 3 } },
        { kind: 'parts', product_id: 2, part_counts: { 21: 1 } },
      ]),
    );
  });

  it('orders at least one piece', async () => {
    open();
    const row = await screen.findByTestId('add-part-11');
    fireEvent.click(within(row).getByRole('checkbox'));
    fireEvent.change(within(row).getByLabelText('Pieces'), { target: { value: '0' } });
    expect(within(row).getByLabelText('Pieces')).toHaveValue(1);
  });
});
