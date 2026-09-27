/**
 * The edges of a line's configuration the WS-08 review found, on the page:
 * a completed order is not reconfigured, Save waits for the warning, and the
 * kits offered from the shelf are the chosen configuration's.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { render } from '../../utils';
import { api } from '../../../api/client';
import type { Order, Product, ProjectLine } from '../../../api/client';
import { LineConfigDialog } from '../../../components/projects/LineConfigDialog';
import { OrderLinesTable } from '../../../components/projects/OrderLinesTable';
import { AddLineRow } from '../../../components/projects/AddLineRow';

const product = {
  id: 7,
  name: 'Pipe',
  parts: [
    { id: 5, kind: 'printed', name: 'Колба', qty_per_unit: 1, sort_order: 0, variant_option_id: null },
    { id: 6, kind: 'printed', name: 'straight tail', qty_per_unit: 1, sort_order: 1, variant_option_id: 11 },
    { id: 8, kind: 'printed', name: 'angled tail', qty_per_unit: 1, sort_order: 2, variant_option_id: 12 },
  ],
  variant_groups: [
    {
      id: 3,
      name: 'Хвіст',
      position: 0,
      default_option_id: 11,
      options: [
        { id: 11, name: 'прямий', position: 0, lines_count: 1, parts_count: 1 },
        { id: 12, name: 'кутовий', position: 1, lines_count: 0, parts_count: 1 },
      ],
    },
  ],
} as unknown as Product;

const line = {
  id: 21,
  product_id: 7,
  product_name: 'Pipe',
  quantity: 4,
  material: null,
  color: null,
  note: null,
  sort_order: 0,
  units_printed: 0,
  from_stock_units: 1,
  covered_units: 1,
  progress: 0.25,
  archive_ids: [],
  parts: [],
  mode: 'product',
  config_key: '3=12',
  configuration: {
    choices: [{ group_id: 3, group_name: 'Хвіст', option_id: 12, option_name: 'кутовий', is_default: false }],
    changed_parts: [],
  },
} as unknown as ProjectLine;

describe('a completed order', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('does not offer to reconfigure its lines, and says why', () => {
    render(<OrderLinesTable order={{ id: 9, status: 'completed', lines: [line] } as unknown as Order} canEdit />);
    const button = screen.getByTestId('line-21-configure');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', expect.stringMatching(/reopen/i));
  });
});

describe('LineConfigDialog · save waits for the warning', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getProduct').mockResolvedValue(product);
  });

  it('keeps Save disabled until the impact is on screen', async () => {
    let answer: (v: unknown) => void = () => {};
    vi.spyOn(api, 'previewLineConfiguration').mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }) as never,
    );
    render(<LineConfigDialog orderId={9} line={line} onClose={() => {}} />);
    fireEvent.change(await screen.findByLabelText('Хвіст'), { target: { value: '11' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    answer({ reserved_before: 1, reserved_after: 1, dropping: [] });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
  });
});

describe('kits offered from the shelf', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getProducts').mockResolvedValue([{ id: 7, code: 'PR-0007', name: 'Pipe', is_active: true }] as never);
    vi.spyOn(api, 'getProduct').mockResolvedValue(product);
    vi.spyOn(api, 'getProductStock').mockResolvedValue({ kits_available: 5, balances: [], movements: [] });
  });

  it('are the chosen configuration’s when adding a line', async () => {
    const kits = vi.spyOn(api, 'getConfigurationKits').mockResolvedValue({ kits_available: 2 });
    render(
      <table>
        <tbody>
          <AddLineRow orderId={1} />
        </tbody>
      </table>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'PR-0007 · Pipe' }));
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: '9' } });
    expect(((await screen.findByTestId('add-line-from-stock')) as HTMLInputElement).value).toBe('5');
    fireEvent.change(await screen.findByLabelText('Хвіст'), { target: { value: '12' } });
    await waitFor(() => expect(kits).toHaveBeenCalledWith(7, { options: [12], counts: {} }));
    await waitFor(() => expect((screen.getByTestId('add-line-from-stock') as HTMLInputElement).value).toBe('2'));
  });

  it('are the line’s own configuration’s when editing it', async () => {
    const kits = vi.spyOn(api, 'getConfigurationKits').mockResolvedValue({ kits_available: 2 });
    render(<OrderLinesTable order={{ id: 9, status: 'active', lines: [line] } as unknown as Order} canEdit />);
    fireEvent.click(screen.getByTestId('line-21-edit'));
    await waitFor(() => expect(kits).toHaveBeenCalledWith(7, { options: [12], counts: {} }));
    // Two free kits of the angled configuration plus the one this line holds.
    await waitFor(() => expect(screen.getByTestId('line-21-from-stock')).toHaveAttribute('max', '3'));
  });
});
