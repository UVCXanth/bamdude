import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { render } from '../../../utils';
import { api } from '../../../../api/client';
import { AddToOrderDialog } from '../../../../components/projects/add-to-order/AddToOrderDialog';
import { lamp, pageOf, pipe, pipeDetail, suggestion, vase } from './fixtures';

describe('the products tab of «Add to order»', () => {
  let getPage: ReturnType<typeof vi.spyOn>;
  let suggest: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    getPage = vi
      .spyOn(api, 'getProductsPaged')
      .mockImplementation(async (params) => (params.page === 2 ? pageOf([vase], 30, 2) : pageOf([pipe, lamp], 30)));
    vi.spyOn(api, 'getProduct').mockResolvedValue(pipeDetail as never);
    vi.spyOn(api, 'getProductCategories').mockResolvedValue([{ id: 7, name: 'Pipes', products_count: 1 }]);
    vi.spyOn(api, 'getProductFacets').mockResolvedValue({ materials: [], colors: [], models: ['P1S', 'X1C'] });
    suggest = vi.spyOn(api, 'suggestStock').mockImplementation(async (items) => ({
      items: items.map((item) =>
        item.product_id === 1
          ? suggestion({ from_finished: Math.min(2, item.quantity), from_kits: Math.min(3, Math.max(0, item.quantity - 2)), to_print: Math.max(0, item.quantity - 5) })
          : suggestion({ product_id: item.product_id, finished_free: 0, kits_free: 1, from_finished: 0, from_kits: 1, to_print: item.quantity - 1, position_id: null, position_code: null }),
      ),
    }));
  });

  it('lists a server page, searched and filtered on the server', async () => {
    render(<AddToOrderDialog orderId={5} onClose={() => {}} />);
    expect(await screen.findByTestId('add-product-1')).toBeInTheDocument();
    expect(getPage).toHaveBeenLastCalledWith({ page: 1, per_page: 24, active: true });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'pip' } });
    await waitFor(() => expect(getPage).toHaveBeenLastCalledWith({ page: 1, per_page: 24, active: true, q: 'pip' }));
    fireEvent.change(screen.getByLabelText('Printer model'), { target: { value: 'X1C' } });
    await waitFor(() =>
      expect(getPage).toHaveBeenLastCalledWith({ page: 1, per_page: 24, active: true, q: 'pip', model: 'X1C' }),
    );
  });

  it('a ticked row gets its quantity, configuration, material and colour', async () => {
    render(<AddToOrderDialog orderId={5} onClose={() => {}} />);
    const row = await screen.findByTestId('add-product-1');
    expect(within(row).getByLabelText('Quantity')).toBeDisabled();
    fireEvent.click(within(row).getByRole('checkbox'));
    expect(within(row).getByLabelText('Quantity')).toBeEnabled();
    expect(await within(row).findByLabelText('Tail')).toHaveValue('100');
    expect(within(row).getByLabelText('Material')).toHaveValue('');
    expect(within(row).getByRole('option', { name: 'PETG' })).toBeInTheDocument();
  });

  it('the stock is the server proposal — ready units first, then kits, the rest to print', async () => {
    render(<AddToOrderDialog orderId={5} onClose={() => {}} />);
    const row = await screen.findByTestId('add-product-1');
    fireEvent.click(within(row).getByRole('checkbox'));
    fireEvent.change(within(row).getByLabelText('Quantity'), { target: { value: '6' } });
    await waitFor(() => expect(within(row).getByLabelText('Ready units')).toHaveValue(2));
    expect(within(row).getByLabelText('Kits')).toHaveValue(3);
    expect(within(row).getByText('to print: 1')).toBeInTheDocument();
    expect(within(row).getByText('picked automatically')).toBeInTheDocument();
    const last = suggest.mock.calls.at(-1)?.[0] ?? [];
    expect(last).toEqual([{ product_id: 1, options: [], quantity: 6 }]);
  });

  it('a changed number is the operator’s until «pick» hands it back', async () => {
    render(<AddToOrderDialog orderId={5} onClose={() => {}} />);
    const row = await screen.findByTestId('add-product-1');
    fireEvent.click(within(row).getByRole('checkbox'));
    fireEvent.change(within(row).getByLabelText('Quantity'), { target: { value: '6' } });
    await waitFor(() => expect(within(row).getByLabelText('Ready units')).toHaveValue(2));
    fireEvent.change(within(row).getByLabelText('Ready units'), { target: { value: '1' } });
    expect(within(row).getByLabelText('Ready units')).toHaveValue(1);
    fireEvent.click(within(row).getByRole('button', { name: 'pick' }));
    await waitFor(() => expect(within(row).getByLabelText('Ready units')).toHaveValue(2));
  });

  it('the selection survives another page and another search', async () => {
    render(<AddToOrderDialog orderId={5} onClose={() => {}} />);
    fireEvent.click(within(await screen.findByTestId('add-product-1')).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /next page/i }));
    expect(await screen.findByTestId('add-product-3')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /previous page/i }));
    expect(within(await screen.findByTestId('add-product-1')).getByRole('checkbox')).toBeChecked();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'x' } });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
    expect(within(await screen.findByTestId('add-product-1')).getByRole('checkbox')).toBeChecked();
  });

  it('marks a draft, and shows what an unticked row has in stock', async () => {
    render(<AddToOrderDialog orderId={5} onClose={() => {}} />);
    const lampRow = await screen.findByTestId('add-product-2');
    expect(within(lampRow).getByText('Draft')).toBeInTheDocument();
    expect(within(screen.getByTestId('add-product-1')).getByText('ready 2 · kits 3')).toBeInTheDocument();
  });

  it('an order that is not active takes nothing from stock', async () => {
    render(<AddToOrderDialog orderId={5} orderActive={false} onClose={() => {}} />);
    const row = await screen.findByTestId('add-product-1');
    fireEvent.click(within(row).getByRole('checkbox'));
    expect(within(row).queryByLabelText('Ready units')).not.toBeInTheDocument();
    expect(suggest).not.toHaveBeenCalled();
  });
});
