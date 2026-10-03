import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from '../../utils';
import { api, ApiError } from '../../../api/client';
import { StockMoveDialog } from '../../../components/stock/StockMoveDialog';
import { pipeItem, pipeProduct } from './stockFixtures';

describe('StockMoveDialog', () => {
  let move: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    move = vi.spyOn(api, 'moveStock').mockResolvedValue({ ...pipeItem, moved: true });
    vi.spyOn(api, 'getProducts').mockResolvedValue([pipeProduct] as never);
    vi.spyOn(api, 'getProduct').mockResolvedValue(pipeProduct as never);
    vi.spyOn(api, 'getCustomers').mockResolvedValue([{ id: 9, code: 'CU-0009', name: 'ACME' }] as never);
  });

  it('a receipt from a position sends the position, the quantity and the note', async () => {
    const onClose = vi.fn();
    render(<StockMoveDialog kind="receipt" item={pipeItem} onClose={onClose} />);
    expect(screen.getByText('SK-0005')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('stock-move-submit'));
    await waitFor(() => expect(move).toHaveBeenCalledWith({ kind: 'receipt', item_id: 5, qty: 3, note: 'x' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('from the header: a product, a select per group, and the server says whether the position exists', async () => {
    const lookup = vi.spyOn(api, 'lookupStockItem').mockResolvedValue({
      item: null,
      configuration: pipeItem.configuration,
      can_assemble: 0,
      parts: [],
    });
    render(<StockMoveDialog kind="receipt" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'PR-0001 · Pipe' }));
    const tail = await screen.findByLabelText('Tail');
    fireEvent.change(tail, { target: { value: '101' } });
    await waitFor(() => expect(lookup).toHaveBeenLastCalledWith(1, [101]));
    expect(await screen.findByText('A new position will be created.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '2' } });
    fireEvent.click(screen.getByTestId('stock-move-submit'));
    await waitFor(() =>
      expect(move).toHaveBeenCalledWith({ kind: 'receipt', product_id: 1, options: [101], qty: 2 }),
    );
  });

  // WS-13 E9 final review: from the product page the product is NAMED, not picked out of
  // a greyed-out catalog list it may be scrolled away in.
  it('opened for one product: names it, reads no catalog, and only its configuration is picked', async () => {
    const lookup = vi.spyOn(api, 'lookupStockItem').mockResolvedValue({
      item: null,
      configuration: pipeItem.configuration,
      can_assemble: 0,
      parts: [],
    });
    render(<StockMoveDialog kind="receipt" productId={1} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('stock-locked-product')).toHaveTextContent('PR-0001 · Pipe'));
    expect(screen.queryByRole('button', { name: 'PR-0001 · Pipe' })).not.toBeInTheDocument();
    expect(api.getProducts).not.toHaveBeenCalled();
    fireEvent.change(await screen.findByLabelText('Tail'), { target: { value: '101' } });
    await waitFor(() => expect(lookup).toHaveBeenLastCalledWith(1, [101]));
  });

  it('a stocktake sends the counted quantity, not a change', async () => {
    render(<StockMoveDialog kind="stocktake" item={pipeItem} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Counted on the shelf'), { target: { value: '7' } });
    expect(screen.getByText('+2')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('stock-move-submit'));
    await waitFor(() => expect(move).toHaveBeenCalledWith({ kind: 'stocktake', item_id: 5, counted: 7 }));
  });

  it('an issue names its customer, takes the main contact as the recipient and sends the waybill', async () => {
    vi.spyOn(api, 'getDeliveryMethods').mockResolvedValue([{ id: 1, name: 'Nova Poshta', position: 0, contacts_count: 1 }]);
    vi.spyOn(api, 'getCustomer').mockResolvedValue({
      id: 9,
      name: 'ACME',
      contacts: [
        { id: 1, name: 'Ivan', phone: '+380', delivery_method_name: 'Nova Poshta', delivery_details: 'Branch 5' },
        { id: 2, name: 'Olena', phone: null, delivery_method_name: null, delivery_details: null },
      ],
    } as never);
    render(<StockMoveDialog kind="issue" item={pipeItem} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '1' } });
    // An issue is an issue TO somebody (spec workshop-order-issue, rule 16).
    expect(screen.getByTestId('stock-move-submit')).toBeDisabled();
    const customer = screen.getByLabelText('Customer');
    await screen.findByRole('option', { name: 'CU-0009 · ACME' });
    fireEvent.change(customer, { target: { value: '9' } });
    await waitFor(() => expect(screen.getByLabelText('Recipient name')).toHaveValue('Ivan'));
    expect(screen.getByLabelText('Delivery method')).toHaveValue('Nova Poshta');
    expect(screen.getByLabelText('Waybill no.')).toHaveAttribute('maxLength', '24');
    fireEvent.change(screen.getByLabelText('Waybill no.'), { target: { value: '2045' } });
    fireEvent.click(screen.getByLabelText('From the reservation'));
    fireEvent.click(screen.getByTestId('stock-move-submit'));
    await waitFor(() =>
      expect(move).toHaveBeenCalledWith({
        kind: 'issue',
        item_id: 5,
        qty: 1,
        customer_id: 9,
        from_reserve: true,
        recipient: { name: 'Ivan', phone: '+380', delivery_method: 'Nova Poshta', delivery_details: 'Branch 5' },
        waybill: '2045',
      }),
    );
  });

  it('an issue names the dispatch note it made', async () => {
    // spec workshop-dispatch-notes, rule 24.
    move.mockResolvedValue({ ...pipeItem, moved: true, issue_id: 7, issue_code: 'DN-0007' });
    vi.spyOn(api, 'getCustomer').mockResolvedValue({ id: 9, name: 'ACME', contacts: [] } as never);
    const onClose = vi.fn();
    render(<StockMoveDialog kind="issue" item={pipeItem} onClose={onClose} />);
    const customer = screen.getByLabelText('Customer');
    await screen.findByRole('option', { name: 'CU-0009 · ACME' });
    fireEvent.change(customer, { target: { value: '9' } });
    fireEvent.click(screen.getByTestId('stock-move-submit'));
    expect(await screen.findByRole('dialog', { name: 'Dispatch note issued' })).toHaveTextContent('DN-0007');
    expect(onClose).not.toHaveBeenCalled();
  });

  // E6-V01 (Codex): the note's window names the units the request SENT — the field stays
  // editable while the issue is on its way, and what is typed then was never issued.
  it.each(['3', '9'])('the note names the issued quantity when the field reads %s by the answer', async (typedMeanwhile) => {
    vi.spyOn(api, 'getCustomer').mockResolvedValue({ id: 9, name: 'ACME', contacts: [] } as never);
    vi.spyOn(api, 'getDeliveryMethods').mockResolvedValue([]);
    let finish!: (value: never) => void;
    move.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    render(<StockMoveDialog kind="issue" item={pipeItem} onClose={() => {}} />);
    await screen.findByRole('option', { name: 'CU-0009 · ACME' });
    fireEvent.change(screen.getByLabelText('Customer'), { target: { value: '9' } });
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '3' } });
    fireEvent.click(screen.getByTestId('stock-move-submit'));
    await waitFor(() => expect(move).toHaveBeenCalledWith(expect.objectContaining({ qty: 3 })));
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: typedMeanwhile } });
    await act(async () => finish({ ...pipeItem, moved: true, issue_id: 7, issue_code: 'DN-0007' } as never));
    expect(await screen.findByRole('dialog', { name: 'Dispatch note issued' })).toHaveTextContent('DN-0007 · 3 pcs');
    expect(move).toHaveBeenCalledTimes(1);
  });

  it('a count that matches the shelf says nothing moved', async () => {
    move.mockResolvedValue({ ...pipeItem, moved: false });
    render(<StockMoveDialog kind="stocktake" item={pipeItem} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Counted on the shelf'), { target: { value: '5' } });
    fireEvent.click(screen.getByTestId('stock-move-submit'));
    expect(await screen.findByText('Nothing changed — the count matches the shelf.')).toBeInTheDocument();
    expect(screen.queryByText('The stock was updated.')).not.toBeInTheDocument();
  });

  it('a zero count of a configuration with no position is not offered — it would move nothing', async () => {
    vi.spyOn(api, 'lookupStockItem').mockResolvedValue({
      item: null,
      configuration: pipeItem.configuration,
      can_assemble: 0,
      parts: [],
    });
    render(<StockMoveDialog kind="stocktake" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'PR-0001 · Pipe' }));
    await screen.findByText('A new position will be created.');
    fireEvent.change(screen.getByLabelText('Counted on the shelf'), { target: { value: '0' } });
    expect(screen.getByTestId('stock-move-submit')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Counted on the shelf'), { target: { value: '2' } });
    expect(screen.getByTestId('stock-move-submit')).toBeEnabled();
  });

  it('a refusal re-reads what the dialog shows', async () => {
    const lookup = vi.spyOn(api, 'lookupStockItem').mockResolvedValue({
      item: pipeItem,
      configuration: pipeItem.configuration,
      can_assemble: 0,
      parts: [],
    });
    move.mockRejectedValue(new ApiError('Only 3 available', 409));
    render(<StockMoveDialog kind="reserve" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'PR-0001 · Pipe' }));
    await waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '9' } });
    fireEvent.click(screen.getByTestId('stock-move-submit'));
    expect(await screen.findByText('Only 3 available')).toBeInTheDocument();
    await waitFor(() => expect(lookup).toHaveBeenCalledTimes(2));
  });

  it('a refusal is the server sentence in a toast, and the dialog stays', async () => {
    move.mockRejectedValue(new ApiError('Only 3 available', 409));
    const onClose = vi.fn();
    render(<StockMoveDialog kind="reserve" item={pipeItem} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '9' } });
    fireEvent.click(screen.getByTestId('stock-move-submit'));
    expect(await screen.findByText('Only 3 available')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
