/**
 * Which order (WS-13 E13 D01 / D01a): a server search over ACTIVE orders with real
 * paging, and the chosen order — chosen here or already bound, whatever its status —
 * shown under its own label wherever the results are. A closed order is never
 * offered for a new choice; one already bound stays visible, named with its status.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from '../../utils';
import { api } from '../../../api/client';
import { OrderChoice } from '../../../components/pickers/OrderChoice';

type Row = { id: number; code: string; name: string; status: string; customer_name: string | null };

const row = (id: number, name: string, status = 'active'): Row => ({
  id,
  code: `OR-${String(id).padStart(4, '0')}`,
  name,
  status,
  customer_name: null,
});

function page(items: Row[], current = 1, last = 1, total = items.length) {
  return {
    items,
    meta: { total, current_page: current, per_page: 20, last_page: last },
    totals: { active: total, completed: 0, cancelled: 0, all: total, stages: {} },
  } as never;
}

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const select = () => screen.getByRole('combobox', { name: 'Order' }) as HTMLSelectElement;
const selectedText = () => select().selectedOptions[0]?.textContent ?? '';

describe('OrderChoice', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('asks the server for active orders only, one page at a time', async () => {
    const get = vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(page([row(5, 'Flasks'), row(6, 'Spares')]));
    render(<OrderChoice value={null} onChange={() => {}} />);
    expect(await screen.findByRole('option', { name: 'OR-0005 · Flasks · no customer' })).toBeInTheDocument();
    expect(get).toHaveBeenLastCalledWith({ status: 'active', page: 1, per_page: 20 });
  });

  it('shows a chosen order beyond the first page under its own label, read on its own', async () => {
    vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(page([row(5, 'Flasks')], 1, 3, 41));
    vi.spyOn(api, 'getOrder').mockResolvedValue(row(42, 'Far away') as never);
    render(<OrderChoice value={42} onChange={() => {}} />);
    await waitFor(() => expect(selectedText()).toBe('OR-0042 · Far away'));
    expect(select().value).toBe('42');
  });

  it('names a bound closed order with its status and offers no closed one', async () => {
    vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(page([row(5, 'Flasks')]));
    vi.spyOn(api, 'getOrder').mockResolvedValue(row(9, 'Shipped', 'completed') as never);
    render(<OrderChoice value={9} onChange={() => {}} />);
    await waitFor(() => expect(selectedText()).toBe('OR-0009 · Shipped · Completed'));
  });

  it('keeps the chosen order when a search no longer lists it', async () => {
    const get = vi.spyOn(api, 'getOrdersPaged').mockImplementation(async (params) =>
      params.q ? page([]) : page([row(5, 'Flasks'), row(6, 'Spares')]),
    );
    const onChange = vi.fn();
    const { rerender } = render(<OrderChoice value={null} onChange={onChange} />);
    await screen.findByRole('option', { name: 'OR-0006 · Spares · no customer' });
    fireEvent.change(select(), { target: { value: '6' } });
    expect(onChange).toHaveBeenLastCalledWith({ id: 6, code: 'OR-0006', name: 'Spares' });
    rerender(<OrderChoice value={6} onChange={onChange} />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find an order…' }), { target: { value: 'zzz' } });
    await waitFor(() => expect(get).toHaveBeenLastCalledWith({ status: 'active', q: 'zzz', page: 1, per_page: 20 }));
    expect(await screen.findByText('Nothing found')).toBeInTheDocument();
    expect(select().value).toBe('6');
    expect(selectedText()).toBe('OR-0006 · Spares · no customer');
  });

  it('pages through the orders, and a new search starts again at the first page', async () => {
    const get = vi.spyOn(api, 'getOrdersPaged').mockImplementation(async (params) =>
      params.page === 2 ? page([row(30, 'Second')], 2, 2, 21) : page([row(5, 'First')], 1, 2, 21),
    );
    render(<OrderChoice value={null} onChange={() => {}} />);
    expect(await screen.findByText('Page 1 of 2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('option', { name: 'OR-0030 · Second · no customer' })).toBeInTheDocument();
    expect(get).toHaveBeenLastCalledWith({ status: 'active', page: 2, per_page: 20 });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find an order…' }), { target: { value: 'fi' } });
    await waitFor(() => expect(get).toHaveBeenLastCalledWith({ status: 'active', q: 'fi', page: 1, per_page: 20 }));
  });

  it('says a page could not be read, offers a retry, and keeps the choice', async () => {
    let fail = true;
    const get = vi.spyOn(api, 'getOrdersPaged').mockImplementation(async (params) => {
      if (params.page === 2 && fail) throw new Error('HTTP 500');
      return params.page === 2 ? page([row(30, 'Second')], 2, 2, 21) : page([row(5, 'First')], 1, 2, 21);
    });
    render(<OrderChoice value={5} onChange={() => {}} />);
    await screen.findByText('Page 1 of 2');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the orders');
    expect(select().value).toBe('5');
    expect(selectedText()).toBe('OR-0005 · First · no customer');
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('option', { name: 'OR-0030 · Second · no customer' })).toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('never lets a late answer of the previous search replace the current one', async () => {
    const slow = deferred<never>();
    vi.spyOn(api, 'getOrdersPaged').mockImplementation(async (params) => {
      if (params.q === 'a') return slow.promise;
      if (params.q === 'ab') return page([row(7, 'Abacus')]);
      return page([row(5, 'Flasks')]);
    });
    render(<OrderChoice value={null} onChange={() => {}} />);
    await screen.findByRole('option', { name: 'OR-0005 · Flasks · no customer' });
    const box = screen.getByRole('searchbox', { name: 'Find an order…' });
    fireEvent.change(box, { target: { value: 'a' } });
    await waitFor(() => expect(api.getOrdersPaged).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'a' })));
    fireEvent.change(box, { target: { value: 'ab' } });
    expect(await screen.findByRole('option', { name: 'OR-0007 · Abacus · no customer' })).toBeInTheDocument();
    slow.resolve(page([row(8, 'Apple')]));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('option', { name: /Apple/ })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'OR-0007 · Abacus · no customer' })).toBeInTheDocument();
  });

  it('offers «No order» as a choice only where the caller allows one', async () => {
    vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(page([row(5, 'Flasks')]));
    const onChange = vi.fn();
    const { unmount } = render(<OrderChoice value={5} onChange={onChange} allowNone />);
    await screen.findByRole('option', { name: 'OR-0005 · Flasks · no customer' });
    fireEvent.change(select(), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(screen.getByRole('option', { name: 'No order' })).toBeInTheDocument();
    unmount();
    render(<OrderChoice value={null} onChange={() => {}} />);
    await screen.findByRole('option', { name: 'OR-0005 · Flasks · no customer' });
    expect(screen.queryByRole('option', { name: 'No order' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Choose an active order' })).toBeInTheDocument();
  });
});
