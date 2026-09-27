import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { render } from '../../utils';
import { api } from '../../../api/client';
import type { StockIssueRow } from '../../../api/client';
import { CustomerIssues } from '../../../components/customers/CustomerIssues';
import { formatDateTime } from '../../../utils/date';

const row = (over: Partial<StockIssueRow>): StockIssueRow => ({
  id: 1,
  created_at: '2026-09-27T10:00:00',
  project_id: 5,
  project_code: 'OR-0005',
  customer_id: 2,
  customer_name: 'ACME',
  units: 4,
  recipient_name: 'Ivan',
  recipient_phone: '+380',
  delivery_method: 'Nova Poshta',
  delivery_details: null,
  waybill: null,
  note: null,
  created_by_name: 'olena',
  ...over,
});

describe('CustomerIssues', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('lists the issues the server pages, an order code or «without an order»', async () => {
    const get = vi.spyOn(api, 'getCustomerIssues').mockResolvedValue({
      items: [row({ id: 3, project_id: null, project_code: null, units: 1 }), row({ id: 2 })],
      meta: { total: 30, current_page: 1, per_page: 20, last_page: 2 },
    });
    render(<CustomerIssues customerId={2} canEdit />);
    const manual = await screen.findByTestId('issue-3');
    expect(within(manual).getByText('without an order')).toBeInTheDocument();
    const fromOrder = screen.getByTestId('issue-2');
    expect(within(fromOrder).getByRole('link', { name: 'OR-0005' })).toHaveAttribute('href', '/projects/5');
    expect(within(fromOrder).getByText('Nova Poshta')).toBeInTheDocument();
    expect(within(fromOrder).getByText('olena')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith(2, { page: 1, per_page: 20 });
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(2, { page: 2, per_page: 20 }));
  });

  it('writes the waybill in its row afterwards', async () => {
    vi.spyOn(api, 'getCustomerIssues').mockResolvedValue({
      items: [row({ id: 2 })],
      meta: { total: 1, current_page: 1, per_page: 20, last_page: 1 },
    });
    const update = vi.spyOn(api, 'updateStockIssue').mockResolvedValue(row({ id: 2, waybill: '2045' }));
    render(<CustomerIssues customerId={2} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit the waybill' }));
    const input = screen.getByLabelText('Waybill no.');
    expect(input).toHaveAttribute('maxLength', '24');
    fireEvent.change(input, { target: { value: ' 2045 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(2, { waybill: '2045' }));
  });

  it('says so when there are none', async () => {
    vi.spyOn(api, 'getCustomerIssues').mockResolvedValue({
      items: [],
      meta: { total: 0, current_page: 1, per_page: 20, last_page: 1 },
    });
    render(<CustomerIssues customerId={2} canEdit={false} />);
    expect(await screen.findByText('No issues yet.')).toBeInTheDocument();
  });
});

describe('CustomerIssues · time', () => {
  it('reads the server time as UTC and formats it as the app does', async () => {
    vi.spyOn(api, 'getSettings').mockResolvedValue({} as never);
    vi.spyOn(api, 'getCustomerIssues').mockResolvedValue({
      items: [row({ id: 2, created_at: '2026-09-27T10:00:00' })],
      meta: { total: 1, current_page: 1, per_page: 20, last_page: 1 },
    });
    render(<CustomerIssues customerId={2} canEdit={false} />);
    const issue = await screen.findByTestId('issue-2');
    expect(within(issue).getByText(formatDateTime('2026-09-27T10:00:00'))).toBeInTheDocument();
  });
});
