/**
 * Which line of the order (WS-13 E13 D02): «product × quantity · configuration»,
 * «No line» as an explicit choice, and a read that has not answered — or failed —
 * never mistaken for an order without lines: the bound line stays until a SUCCESSFUL
 * answer for the current order no longer has it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from '../../utils';
import { api } from '../../../api/client';
import { OrderLinePicker } from '../../../components/pickers/OrderLinePicker';

const line = (id: number, product: string, quantity: number, choices: { name: string; option: string; std?: boolean }[] = []) => ({
  id,
  product_name: product,
  quantity,
  material: 'PETG',
  mode: 'product',
  configuration: {
    choices: choices.map((c, i) => ({
      group_id: i + 1,
      group_name: c.name,
      option_id: i + 10,
      option_name: c.option,
      is_default: c.std ?? false,
    })),
    changed_parts: [],
  },
});

const order = (id: number, lines: unknown[]) => ({ id, lines }) as never;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const combo = () => screen.getByRole('combobox') as HTMLSelectElement;

describe('OrderLinePicker', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('is disabled until an order is chosen', () => {
    render(<OrderLinePicker orderId={null} value={null} onChange={() => {}} />);
    expect(combo()).toBeDisabled();
    expect(screen.getByRole('option', { name: 'Choose an order first' })).toBeInTheDocument();
  });

  it('names a line by its product, quantity and configuration', async () => {
    vi.spyOn(api, 'getOrder').mockResolvedValue(
      order(5, [line(11, 'Flask', 2, [{ name: 'Colour', option: 'Red' }]), line(12, 'Lid', 4)]),
    );
    const onChange = vi.fn();
    render(<OrderLinePicker orderId={5} value={null} onChange={onChange} />);
    expect(await screen.findByRole('option', { name: 'Flask × 2 · Colour: Red' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Lid × 4' })).toBeInTheDocument();
    fireEvent.change(combo(), { target: { value: '12' } });
    expect(onChange).toHaveBeenCalledWith(12);
  });

  it('says it is reading, and keeps the bound line meanwhile', async () => {
    const answer = deferred<never>();
    vi.spyOn(api, 'getOrder').mockReturnValue(answer.promise);
    const onChange = vi.fn();
    render(<OrderLinePicker orderId={5} value={11} onChange={onChange} />);
    expect(combo()).toBeDisabled();
    expect(combo().selectedOptions[0]).toHaveTextContent('Reading the lines…');
    answer.resolve(order(5, [line(11, 'Flask', 2)]));
    await waitFor(() => expect(combo().selectedOptions[0]).toHaveTextContent('Flask × 2'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('says the lines could not be read, offers a retry, and keeps the bound line', async () => {
    const get = vi.spyOn(api, 'getOrder').mockRejectedValueOnce(new Error('HTTP 500'));
    const onChange = vi.fn();
    render(<OrderLinePicker orderId={5} value={11} onChange={onChange} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not read the order’s lines');
    expect(combo().value).toBe('11');
    expect(onChange).not.toHaveBeenCalled();
    get.mockResolvedValue(order(5, [line(11, 'Flask', 2)]));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(combo().selectedOptions[0]).toHaveTextContent('Flask × 2'));
  });

  it('offers only «No line» for an order without lines', async () => {
    vi.spyOn(api, 'getOrder').mockResolvedValue(order(5, []));
    render(<OrderLinePicker orderId={5} value={null} onChange={() => {}} />);
    await waitFor(() => expect(combo()).not.toBeDisabled());
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['No line']);
  });

  it('takes «No line» as a choice of its own', async () => {
    vi.spyOn(api, 'getOrder').mockResolvedValue(order(5, [line(11, 'Flask', 2)]));
    const onChange = vi.fn();
    render(<OrderLinePicker orderId={5} value={11} onChange={onChange} />);
    await waitFor(() => expect(combo()).not.toBeDisabled());
    fireEvent.change(combo(), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('lets go of a line that a successful answer no longer has', async () => {
    vi.spyOn(api, 'getOrder').mockResolvedValue(order(5, [line(12, 'Lid', 4)]));
    const onChange = vi.fn();
    render(<OrderLinePicker orderId={5} value={11} onChange={onChange} />);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(null));
  });

  it('shows the new order’s lines, never a late answer about the previous one', async () => {
    const first = deferred<never>();
    vi.spyOn(api, 'getOrder').mockImplementation((id: number) =>
      id === 1 ? first.promise : Promise.resolve(order(2, [line(20, 'Lid', 1)])),
    );
    const { rerender } = render(<OrderLinePicker orderId={1} value={null} onChange={() => {}} />);
    rerender(<OrderLinePicker orderId={2} value={null} onChange={() => {}} />);
    expect(await screen.findByRole('option', { name: 'Lid × 1' })).toBeInTheDocument();
    first.resolve(order(1, [line(10, 'Flask', 2)]));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('option', { name: 'Flask × 2' })).not.toBeInTheDocument();
  });
});
