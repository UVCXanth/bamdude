/**
 * The archive editor and the print's order (WS-13 E13 D01–D04, B06):
 * - the order and the line are the shared server-side pickers, read-only without
 *   `projects:update`;
 * - a save that did not touch them sends no binding at all — an unread or
 *   unreadable picker can never write an empty one;
 * - a refusal stays in the dialog, in the server's words;
 * - «Count into stock» refreshes the catalog through its one helper.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from '../utils';
import { api, ApiError } from '../../api/client';
import type { Permission } from '../../api/client';
import { EditArchiveModal } from '../../components/EditArchiveModal';

const auth = vi.hoisted(() => ({ granted: new Set<string>() }));
const inval = vi.hoisted(() => ({ catalog: vi.fn() }));

vi.mock('../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../contexts/AuthContext')>();
  return {
    ...actual,
    useAuth: () => ({ ...actual.useAuth(), hasPermission: (p: Permission) => auth.granted.has(p) }),
  };
});

vi.mock('../../utils/queryInvalidation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/queryInvalidation')>();
  return {
    ...actual,
    invalidateProductCatalog: (...args: Parameters<typeof actual.invalidateProductCatalog>) => {
      inval.catalog();
      actual.invalidateProductCatalog(...args);
    },
  };
});

const archive = {
  id: 7,
  printer_id: null,
  project_id: 1,
  project_line_id: 10,
  project_name: 'Alpha',
  filename: 'flask.gcode.3mf',
  print_name: 'Flask',
  status: 'completed',
  tags: '',
  notes: '',
  quantity: 1,
  defective_count: 0,
  photos: null,
  failure_reason: null,
  external_url: null,
  created_at: '2026-01-01T00:00:00Z',
};

const alpha = {
  id: 1,
  code: 'OR-0001',
  name: 'Alpha',
  status: 'active',
  customer_name: null,
  lines: [{ id: 10, product_name: 'Flask', quantity: 2, mode: 'product', configuration: { choices: [], changed_parts: [] } }],
};

describe('EditArchiveModal — the print’s order', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    inval.catalog.mockClear();
    auth.granted = new Set(['projects:update', 'archives:update_all']);
    vi.spyOn(api, 'getPrinters').mockResolvedValue([] as never);
    vi.spyOn(api, 'getTags').mockResolvedValue([] as never);
    vi.spyOn(api, 'getOrdersPaged').mockResolvedValue({
      items: [alpha],
      meta: { total: 1, current_page: 1, per_page: 20, last_page: 1 },
      totals: { active: 1, completed: 0, cancelled: 0, all: 1, stages: {} },
    } as never);
    vi.spyOn(api, 'getOrder').mockResolvedValue(alpha as never);
  });

  it('sends no binding when only a note changed', async () => {
    const patch = vi.spyOn(api, 'updateArchive').mockResolvedValue({} as never);
    render(<EditArchiveModal archive={archive as never} onClose={() => {}} />);
    await screen.findByRole('option', { name: 'Flask × 2' });
    fireEvent.change(screen.getByPlaceholderText(/notes/i), { target: { value: 'checked' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(patch).toHaveBeenCalled());
    const body = patch.mock.calls[0][1] as Record<string, unknown>;
    expect(body.notes).toBe('checked');
    expect('project_id' in body).toBe(false);
    expect('project_line_id' in body).toBe(false);
  });

  it('sends no binding when the lines could not be read', async () => {
    vi.spyOn(api, 'getOrder').mockRejectedValue(new Error('HTTP 500'));
    const patch = vi.spyOn(api, 'updateArchive').mockResolvedValue({} as never);
    render(<EditArchiveModal archive={archive as never} onClose={() => {}} />);
    expect(await screen.findByText('Could not read the order’s lines')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(patch).toHaveBeenCalled());
    const body = patch.mock.calls[0][1] as Record<string, unknown>;
    expect('project_id' in body).toBe(false);
    expect('project_line_id' in body).toBe(false);
  });

  it('shows the order and the line read-only without the right to change orders', async () => {
    auth.granted = new Set(['archives:update_all']);
    render(<EditArchiveModal archive={archive as never} onClose={() => {}} />);
    const order = screen.getByRole('combobox', { name: 'Order' }) as HTMLSelectElement;
    await waitFor(() => expect(order.selectedOptions[0]).toHaveTextContent('OR-0001 · Alpha'));
    expect(order).toBeDisabled();
    expect(screen.getByRole('searchbox', { name: 'Find an order…' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: /line/i })).toBeDisabled();
  });

  it('keeps a refusal in the dialog, in the server’s words', async () => {
    vi.spyOn(api, 'updateArchive').mockRejectedValue(new ApiError('You can only update your own archives', 403));
    const onClose = vi.fn();
    render(<EditArchiveModal archive={archive as never} onClose={onClose} />);
    await screen.findByRole('option', { name: 'Flask × 2' });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You can only update your own archives');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('refreshes the catalog through its helper after counting a print into stock', async () => {
    vi.spyOn(api, 'countArchiveIntoStock').mockResolvedValue([] as never);
    render(<EditArchiveModal archive={{ ...archive, project_id: null, project_line_id: null } as never} onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId('archive-count-into-stock'));
    await waitFor(() => expect(inval.catalog).toHaveBeenCalled());
  });
});
