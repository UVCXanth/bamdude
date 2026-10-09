import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { render } from '../../utils';
import { api } from '../../../api/client';
import { makeOrder } from '../../fixtures/orderDetail';
import { OrderAutoEject } from '../../../components/projects/OrderAutoEject';
import { AutoEjectBadge } from '../../../components/AutoEjectBadge';

afterEach(() => vi.restoreAllMocks());

function openConfirmation() {
  fireEvent.click(screen.getByRole('checkbox', { name: 'Auto-eject after printing' }));
  return within(screen.getByRole('dialog', { name: 'Enable auto-eject for this order?' }));
}

function acknowledgeAndEnable() {
  const dialog = openConfirmation();
  fireEvent.click(dialog.getByRole('checkbox'));
  fireEvent.click(dialog.getByRole('button', { name: 'Enable auto-eject' }));
}

describe('Order auto-eject MVP', () => {
  it('is off by default and writes only the order flag', async () => {
    const order = makeOrder({ name: 'Product A order' });
    const update = vi.spyOn(api, 'updateOrder').mockResolvedValue({ ...order, auto_eject_enabled: true });
    render(<OrderAutoEject order={order} canEdit />);
    const toggle = screen.getByRole('checkbox', { name: 'Auto-eject after printing' });
    expect(toggle).not.toBeChecked();
    const dialog = openConfirmation();
    expect(update).not.toHaveBeenCalled();
    expect(toggle).not.toBeChecked();
    const confirm = dialog.getByRole('button', { name: 'Enable auto-eject' });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(update).not.toHaveBeenCalled();
    fireEvent.click(dialog.getByRole('checkbox'));
    fireEvent.click(confirm);
    await waitFor(() => expect(update).toHaveBeenCalledWith(order.id, { auto_eject_enabled: true }));
    expect(screen.queryByText(/Apply mode to pending/)).not.toBeInTheDocument();
  });

  it('readers and closed orders cannot change the setting', () => {
    render(<OrderAutoEject order={makeOrder({ name: 'Product B order', auto_eject_enabled: true })} canEdit={false} />);
    expect(screen.getByRole('checkbox')).toBeChecked();
    expect(screen.getByRole('checkbox')).toBeDisabled();
  });

  it('shows a save failure and keeps the server value', async () => {
    vi.spyOn(api, 'updateOrder').mockRejectedValue(new Error('Synthetic refusal'));
    render(<OrderAutoEject order={makeOrder()} canEdit />);
    acknowledgeAndEnable();
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic refusal');
    expect(screen.getByRole('checkbox', { name: 'Auto-eject after printing' })).not.toBeChecked();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('cancels without writing and requires a new acknowledgement on reopen', () => {
    const update = vi.spyOn(api, 'updateOrder');
    render(<OrderAutoEject order={makeOrder()} canEdit />);
    let dialog = openConfirmation();
    fireEvent.click(dialog.getByRole('checkbox'));
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
    dialog = openConfirmation();
    expect(dialog.getByRole('checkbox')).not.toBeChecked();
    expect(dialog.getByRole('button', { name: 'Enable auto-eject' })).toBeDisabled();
  });

  it('disables an enabled order immediately without another confirmation', async () => {
    const order = makeOrder({ auto_eject_enabled: true });
    const update = vi.spyOn(api, 'updateOrder').mockResolvedValue({ ...order, auto_eject_enabled: false });
    render(<OrderAutoEject order={order} canEdit />);
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(update).toHaveBeenCalledWith(order.id, { auto_eject_enabled: false }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('names the reference profile, links its source and explains the limits', () => {
    render(<OrderAutoEject order={makeOrder()} canEdit />);
    const dialog = openConfirmation();
    expect(dialog.getByText(/Infinity Flow 3D Tilt Kit/)).toBeInTheDocument();
    expect(dialog.getByText(/2025-10-08/)).toBeInTheDocument();
    expect(dialog.getByText(/greater than 5.5 mm/)).toBeInTheDocument();
    expect(dialog.getByText(/outside the image or selected region/)).toBeInTheDocument();
    expect(dialog.getByText(/including P1S/)).toBeInTheDocument();
    expect(dialog.getByRole('link')).toHaveAttribute('href',
      'https://infinityflow3d.com/pages/free-3d-printer-auto-clearing-cad-and-g-code');
    expect(dialog.getByText(/does not validate the preset/)).toBeInTheDocument();
  });

  it('does not submit twice while saving and cannot be cancelled mid-save', async () => {
    const order = makeOrder();
    let resolve!: (value: typeof order) => void;
    const update = vi.spyOn(api, 'updateOrder').mockImplementation(() => new Promise((done) => { resolve = done; }));
    render(<OrderAutoEject order={order} canEdit />);
    const dialog = openConfirmation();
    fireEvent.click(dialog.getByRole('checkbox'));
    const confirm = dialog.getByRole('button', { name: 'Enable auto-eject' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(dialog.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(dialog.getByRole('checkbox')).toBeDisabled();
    resolve({ ...order, auto_eject_enabled: true });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('cannot confirm for another order after navigation', () => {
    const update = vi.spyOn(api, 'updateOrder');
    const { rerender } = render(<OrderAutoEject order={makeOrder({ id: 1 })} canEdit />);
    const dialog = openConfirmation();
    fireEvent.click(dialog.getByRole('checkbox'));
    rerender(<OrderAutoEject order={makeOrder({ id: 2 })} canEdit />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });

  it('closes the confirmation if the order becomes read-only', () => {
    const update = vi.spyOn(api, 'updateOrder');
    const order = makeOrder();
    const { rerender } = render(<OrderAutoEject order={order} canEdit />);
    openConfirmation();
    rerender(<OrderAutoEject order={order} canEdit={false} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(update).not.toHaveBeenCalled();
  });

  it('badge represents the stored job flag', () => {
    const { rerender } = render(<AutoEjectBadge mode={false} />);
    expect(screen.queryByText('Auto-eject')).not.toBeInTheDocument();
    rerender(<AutoEjectBadge mode />);
    expect(screen.getByText('Auto-eject')).toBeInTheDocument();
  });
});
