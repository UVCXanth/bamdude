/**
 * The archive editor files a print under an ORDER and, optionally, one LINE
 * of it.
 *
 * ⚠️ The server rejects (400) a line that belongs to a different order than
 * the one being set, so the modal resets the line whenever the order changes:
 * the mismatch can then never be submitted. Kept in its own file so the older
 * EditArchiveModal suite's MSW-based mocks stay untouched.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from '../utils';
import { api } from '../../api/client';
import { EditArchiveModal } from '../../components/EditArchiveModal';

const archive = {
  id: 7,
  printer_id: null,
  project_id: 1,
  project_line_id: 10,
  project_name: 'A',
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

describe('EditArchiveModal — order and line', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getPrinters').mockResolvedValue([] as never);
    vi.spyOn(api, 'getTags').mockResolvedValue([] as never);
  });

  it('offers the lines of the chosen order and resets the line when the order changes', async () => {
    vi.spyOn(api, 'getOrdersPaged').mockResolvedValue({
      items: [
        { id: 1, code: 'OR-0001', name: 'A', status: 'active', customer_name: null },
        { id: 2, code: 'OR-0002', name: 'B', status: 'active', customer_name: null },
      ],
      meta: { total: 2, current_page: 1, per_page: 20, last_page: 1 },
    } as never);
    vi.spyOn(api, 'getOrder').mockImplementation(
      async (id: number) =>
        ({
          id,
          lines:
            id === 1
              ? [{ id: 10, product_name: 'Flask', quantity: 2, material: null }]
              : [{ id: 20, product_name: 'Lid', quantity: 1, material: null }],
        }) as never,
    );
    const patch = vi.spyOn(api, 'updateArchive').mockResolvedValue({} as never);

    render(<EditArchiveModal archive={archive as never} onClose={() => {}} />);

    expect(await screen.findByRole('option', { name: 'Flask × 2' })).toBeInTheDocument();

    await screen.findByRole('option', { name: 'OR-0002 · B · no customer' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Order' }), { target: { value: '2' } });

    expect(await screen.findByRole('option', { name: 'Lid × 1' })).toBeInTheDocument();
    expect((screen.getByRole('combobox', { name: 'Line' }) as HTMLSelectElement).value).toBe('');

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(7, expect.objectContaining({ project_id: 2, project_line_id: null })),
    );
  });

  it('keeps the bound line when nothing is touched — and sends no binding at all (E13 D02)', async () => {
    vi.spyOn(api, 'getOrdersPaged').mockResolvedValue({
      items: [{ id: 1, code: 'OR-0001', name: 'A', status: 'active', customer_name: null }],
      meta: { total: 1, current_page: 1, per_page: 20, last_page: 1 },
    } as never);
    vi.spyOn(api, 'getOrder').mockResolvedValue({
      id: 1,
      lines: [{ id: 10, product_name: 'Flask', quantity: 2, material: null }],
    } as never);
    const patch = vi.spyOn(api, 'updateArchive').mockResolvedValue({} as never);

    render(<EditArchiveModal archive={archive as never} onClose={() => {}} />);

    expect(await screen.findByRole('option', { name: 'Flask × 2' })).toBeInTheDocument();
    expect((screen.getByRole('combobox', { name: 'Line' }) as HTMLSelectElement).value).toBe('10');
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(patch).toHaveBeenCalled());
    const body = patch.mock.calls[0][1] as Record<string, unknown>;
    expect('project_id' in body).toBe(false);
    expect('project_line_id' in body).toBe(false);
  });
});
