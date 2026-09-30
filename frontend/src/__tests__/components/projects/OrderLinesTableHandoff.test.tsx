/**
 * The step from «Edit line» (F03) into the configuration dialog (F05) hands over the
 * line AS THE ORDER HOLDS IT NOW — not the snapshot taken when «Edit line…» was
 * clicked (WS-13 E4 final review M2). The configuration dialog seeds its choices and
 * counts from the line it is given and PUTs the whole body, so a stale line would
 * write back a configuration somebody else has changed meanwhile.
 *
 * The configuration dialog is a stand-in here: what is under test is WHICH line the
 * table passes it, and its own behaviour has its own tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';
import { render } from '../../utils';
import { api } from '../../../api/client';
import type { ProjectLine } from '../../../api/client';
import { OrderLinesTable } from '../../../components/projects/OrderLinesTable';
import { makeLine, makeOrder } from '../../fixtures/orderDetail';

vi.mock('../../../components/projects/LineConfigDialog', () => ({
  LineConfigDialog: ({ line }: { line: ProjectLine }) => (
    <div data-testid="config-stub">{(line.configuration?.changed_parts ?? []).map((p) => `${p.part_id}:${p.qty}`).join(',')}</div>
  ),
}));

function partsLine(qty: number): ProjectLine {
  return makeLine({
    id: 20,
    mode: 'parts',
    product_id: 1,
    product_name: 'Flask',
    quantity: 1,
    configuration: { choices: [], changed_parts: [{ part_id: 1, name: 'body', qty, standard_qty: 1 }] },
  });
}

describe('OrderLinesTable · F03 → F05 hand-off (final review M2)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getProduct').mockResolvedValue({ id: 1, name: 'Flask', materials: [], colors: [] } as never);
    vi.spyOn(api, 'getProductStock').mockResolvedValue({ kits_available: 0, balances: [], movements: [] } as never);
    vi.spyOn(api, 'suggestStock').mockResolvedValue({ items: [] });
  });

  it('opens the configuration on the line as the order holds it now', async () => {
    const view = render(<OrderLinesTable order={makeOrder({ id: 1, status: 'active', lines: [partsLine(3)] })} canEdit />);
    fireEvent.click(screen.getByRole('button', { name: 'Line actions: Flask' }));
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Edit line…' }));
    await screen.findByRole('dialog', { name: 'Edit line' });

    // Another session changed the part count while «Edit line» was open.
    view.rerender(<OrderLinesTable order={makeOrder({ id: 1, status: 'active', lines: [partsLine(5)] })} canEdit />);
    fireEvent.click(screen.getByRole('button', { name: 'Change part quantities…' }));

    expect(await screen.findByTestId('config-stub')).toHaveTextContent('1:5');
  });
});
