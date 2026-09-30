/**
 * The two rules the checklist must not break: it disappears entirely when the
 * order buys nothing, and `remaining` is the SERVER's number — typing into
 * "acquired" patches and then waits, it never subtracts on screen. A checklist
 * that recomputes its own remainder tells the operator a different story from
 * the one the order page's figures tell, and only one of them is the truth.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { render } from '../../utils';
import { api } from '../../../api/client';
import type { Order } from '../../../api/client';
import { ProcurementChecklist } from '../../../components/projects/ProcurementChecklist';

describe('ProcurementChecklist', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing without purchased parts and PATCHes acquired on blur', async () => {
    const { rerender } = render(
      <ProcurementChecklist order={{ id: 1, procurement: [] } as unknown as Order} canEdit />,
    );
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    const patch = vi.spyOn(api, 'updateOrderProcurement').mockResolvedValue({} as Order);
    // ⚠️ `remaining` is deliberately NOT `need - acquired`. A self-consistent
    // fixture is passed by an implementation that quietly subtracts, which is
    // exactly the bug this test exists to catch: the server owns the number
    // (a part shared by two lines does not remain what the arithmetic says).
    rerender(
      <ProcurementChecklist
        order={
          {
            id: 1,
            procurement: [{ part_id: 4, name: 'M3 screw', need: 40, acquired: 10, remaining: 7 }],
          } as unknown as Order
        }
        canEdit
      />,
    );

    const input = screen.getByTestId('procurement-4-acquired') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '25' } });
    fireEvent.blur(input);

    await waitFor(() => expect(patch).toHaveBeenCalledWith(1, 4, 25));
    // Server value until refetch — never recomputed on the client.
    expect(screen.getByTestId('procurement-4-remaining').textContent).toBe('7');
  });

  it('puts the number back when the server refuses the commit', async () => {
    // The input is UNCONTROLLED and keyed on the server's `acquired`, so a
    // rejected PATCH re-renders nothing: without an explicit restore the box
    // sits there showing 25 while the server still holds 10, and the row reads
    // as saved for as long as the page stays open. The same argument the
    // component already makes for a cleared or negative field — "and the box
    // has to say so" — is what a 4xx needs too.
    const patch = vi
      .spyOn(api, 'updateOrderProcurement')
      .mockRejectedValue(new Error('Part not found'));

    render(
      <ProcurementChecklist
        order={
          {
            id: 1,
            procurement: [{ part_id: 4, name: 'M3 screw', need: 40, acquired: 10, remaining: 30 }],
          } as unknown as Order
        }
        canEdit
      />,
    );

    const input = () => screen.getByTestId('procurement-4-acquired') as HTMLInputElement;
    fireEvent.change(input(), { target: { value: '25' } });
    fireEvent.blur(input());

    await waitFor(() => expect(patch).toHaveBeenCalledWith(1, 4, 25));
    // The failure is reported...
    expect(await screen.findByText('Part not found')).toBeInTheDocument();
    // ...and the box no longer claims the number the server refused.
    await waitFor(() => expect(input().value).toBe('10'));
  });

  const row = (over: Record<string, unknown> = {}) => ({
    part_id: 4,
    name: 'M3 screw',
    need: 40,
    acquired: 10,
    remaining: 30,
    unit_price: 0.5,
    sourcing_url: null,
    planned_cost: 20,
    acquired_cost: 5,
    ...over,
  });
  const withRows = (...rows: ReturnType<typeof row>[]) => ({ id: 1, procurement: rows }) as unknown as Order;

  it('heads five columns: part, need, acquired, remaining and price (E4 G01)', () => {
    render(<ProcurementChecklist order={withRows(row())} canEdit />);
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      'Part',
      'Need',
      'Acquired',
      'Remaining',
      'Price',
    ]);
  });

  it('links a part to its supplier, and prices it — or says the price is unknown', () => {
    render(
      <ProcurementChecklist
        order={withRows(
          row({ sourcing_url: 'https://example.com/m3' }),
          row({ part_id: 5, name: 'Magnet', planned_cost: null, unit_price: null }),
        )}
        canEdit
      />,
    );
    const link = screen.getByRole('link', { name: 'Open the supplier page for «M3 screw»' });
    expect(link).toHaveAttribute('href', 'https://example.com/m3');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByTestId('procurement-4-price')).toHaveTextContent(/20/);
    const unknown = screen.getByTestId('procurement-5-price');
    expect(unknown).toHaveTextContent('—');
    expect(unknown).toHaveTextContent('price unknown');
    expect(screen.queryAllByRole('link')).toHaveLength(1);
  });

  it('says there is nothing to buy in words, instead of an empty table', () => {
    render(<ProcurementChecklist order={withRows()} canEdit />);
    expect(screen.getByText('No purchased parts')).toBeInTheDocument();
    expect(screen.getByText('This order’s products are made of printed parts only.')).toBeInTheDocument();
  });

  it('commits once for Enter, even when a blur follows while the first write is in flight (R07)', async () => {
    const patch = vi.spyOn(api, 'updateOrderProcurement').mockReturnValue(new Promise(() => {}) as never);
    render(<ProcurementChecklist order={withRows(row())} canEdit />);
    const input = screen.getByTestId('procurement-4-acquired') as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: '25' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(document.activeElement).not.toBe(input);
    // Tab / a click elsewhere blurs again with the same number while the PATCH flies.
    input.focus();
    fireEvent.blur(input);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith(1, 4, 25);
  });

  // Codex review V01: the «last sent» record lives for ITS write — until the order is
  // read again after it — and never comes back just because the number matches again.
  it('sends the same number again after a confirmed write was reversed elsewhere (V01)', async () => {
    const patch = vi.spyOn(api, 'updateOrderProcurement').mockResolvedValue({} as Order);
    const { rerender } = render(<ProcurementChecklist order={withRows(row({ acquired: 10 }))} canEdit />);
    const field = () => screen.getByTestId('procurement-4-acquired') as HTMLInputElement;
    fireEvent.change(field(), { target: { value: '25' } });
    fireEvent.blur(field());
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    // The re-read confirms 25, then another operator puts 10 back.
    rerender(<ProcurementChecklist order={withRows(row({ acquired: 25 }))} canEdit />);
    rerender(<ProcurementChecklist order={withRows(row({ acquired: 10 }))} canEdit />);
    expect(field().value).toBe('10');
    fireEvent.change(field(), { target: { value: '25' } });
    fireEvent.blur(field());
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    expect(patch).toHaveBeenLastCalledWith(1, 4, 25);
  });

  it('sends the same number again when the re-read after a write still says the old one (V01)', async () => {
    // The write was accepted, but by the time the order was read again somebody had put
    // 10 back: the server's number never moved on screen, and the record must not
    // outlive its write anyway.
    const patch = vi.spyOn(api, 'updateOrderProcurement').mockResolvedValue({} as Order);
    render(<ProcurementChecklist order={withRows(row({ acquired: 10 }))} canEdit />);
    const field = () => screen.getByTestId('procurement-4-acquired') as HTMLInputElement;
    fireEvent.change(field(), { target: { value: '25' } });
    fireEvent.blur(field());
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.focus(field());
    fireEvent.blur(field());
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
  });

  it('leaves the numbers read-only without the permission', () => {
    render(
      <ProcurementChecklist
        order={
          {
            id: 1,
            procurement: [{ part_id: 4, name: 'M3 screw', need: 40, acquired: 10, remaining: 30 }],
          } as unknown as Order
        }
        canEdit={false}
      />,
    );

    expect(screen.getByTestId('procurement-4-acquired')).toBeDisabled();
  });
});
