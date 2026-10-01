/**
 * «Duplicate order» (WS-13 E6 §D): a named copy, prefilled and held within the 255-
 * character column (R05), what is copied said as the server copies it, a warning
 * when the original's deadline has passed whatever its status (R07), one request
 * per press, a refusal kept in the dialog, and the copy opened as soon as it exists.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from '../../utils';
import { api, ApiError } from '../../../api/client';
import { DuplicateOrderModal } from '../../../components/projects/DuplicateOrderModal';
import type { OrderRef } from '../../../components/projects/orderActions/orderRef';
import { makeOrder } from '../../fixtures/orderDetail';

const REF: OrderRef = {
  id: 5,
  code: 'OR-0005',
  name: 'Ten flasks',
  status: 'active',
  customer_name: 'ACME',
  bankable_surplus: 0,
  due_date: null,
};

const localMidnight = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T00:00:00`;
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, 'getSettings').mockResolvedValue({} as never);
});

describe('DuplicateOrderModal', () => {
  it('names the original, offers its name with «(copy)» and says what is copied', () => {
    render(<DuplicateOrderModal order={REF} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: 'Duplicate order' });
    expect(dialog).toHaveTextContent('OR-0005 · Ten flasks');
    expect(screen.getByLabelText('Name of the copy')).toHaveValue('Ten flasks (copy)');
    expect(dialog).toHaveTextContent('lines with their configuration');
    expect(dialog).toHaveTextContent('Stays with the original: prints, queue, procurement, stock reservations and movements, issues');
  });

  it('keeps the prefilled name within 255 characters, cutting the original’s (R05)', () => {
    render(<DuplicateOrderModal order={{ ...REF, name: 'n'.repeat(255) }} onClose={() => {}} />);
    const value = (screen.getByLabelText('Name of the copy') as HTMLInputElement).value;
    expect(value.length).toBeLessThanOrEqual(255);
    expect(value.endsWith(' (copy)')).toBe(true);
    expect(screen.getByRole('button', { name: 'Duplicate' })).toBeEnabled();
  });

  it('will not duplicate under a blank name', () => {
    render(<DuplicateOrderModal order={REF} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Name of the copy'), { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Duplicate' })).toBeDisabled();
  });

  it('sends one request however often it is pressed, and opens the copy', async () => {
    const dup = vi.spyOn(api, 'duplicateOrder').mockResolvedValue(makeOrder({ id: 77 }));
    const onClose = vi.fn();
    render(<DuplicateOrderModal order={REF} onClose={onClose} />);
    const go = screen.getByRole('button', { name: 'Duplicate' });
    fireEvent.click(go);
    fireEvent.click(go);
    fireEvent.submit(screen.getByLabelText('Name of the copy').closest('form') as HTMLFormElement);
    await waitFor(() => expect(window.location.pathname).toBe('/projects/77'));
    expect(dup).toHaveBeenCalledTimes(1);
    expect(dup).toHaveBeenCalledWith(5, 'Ten flasks (copy)');
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps a refusal in the dialog with what was typed', async () => {
    vi.spyOn(api, 'duplicateOrder').mockRejectedValue(new ApiError('Project not found', 404));
    render(<DuplicateOrderModal order={REF} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Name of the copy'), { target: { value: 'Second batch' } });
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Project not found');
    expect(screen.getByLabelText('Name of the copy')).toHaveValue('Second batch');
  });

  it('warns that the deadline has passed even when the original is closed (R07)', () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    render(<DuplicateOrderModal order={{ ...REF, status: 'completed', due_date: localMidnight(yesterday) }} onClose={() => {}} />);
    expect(screen.getByRole('dialog')).toHaveTextContent('has passed — change it in the copy');
  });

  it('says nothing of a deadline of today', () => {
    render(<DuplicateOrderModal order={{ ...REF, status: 'cancelled', due_date: localMidnight(new Date()) }} onClose={() => {}} />);
    expect(screen.getByRole('dialog')).not.toHaveTextContent('has passed');
  });
});
