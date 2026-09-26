import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { render } from '../../utils';
import { api } from '../../../api/client';
import type { Order } from '../../../api/client';
import { OrderStageStepper } from '../../../components/projects/OrderStageStepper';

const order = (over: Partial<Order>) => ({ id: 5, status: 'active', stage: 'printing', ...over }) as Order;

describe('OrderStageStepper', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('marks the current stage and sets another by hand — never «Done»', async () => {
    const set = vi.spyOn(api, 'setOrderStage').mockResolvedValue(order({ stage: 'qc' }));
    render(<OrderStageStepper order={order({})} canEdit />);
    const steps = screen.getByRole('list');
    expect(within(steps).getByText(/Printing/)).toHaveAttribute('aria-current', 'step');
    expect(within(steps).getAllByRole('listitem')).toHaveLength(4);
    const select = screen.getByLabelText('Stage');
    expect(within(select).queryByRole('option', { name: 'Done' })).not.toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'qc' } });
    await waitFor(() => expect(set).toHaveBeenCalledWith(5, 'qc'));
  });

  it('names its steps list, and marks a passed step by more than colour', () => {
    render(<OrderStageStepper order={order({ stage: 'qc' })} canEdit />);
    const steps = screen.getByRole('list', { name: 'Stages' });
    // Two steps behind «Quality check» carry a check mark a screen reader can hear.
    expect(within(steps).getAllByLabelText('passed')).toHaveLength(2);
  });

  it('holds the chosen stage while the request is in flight, and refreshes the order when it is refused', async () => {
    let refuse: (e: Error) => void = () => {};
    vi.spyOn(api, 'setOrderStage').mockReturnValue(new Promise((_, reject) => (refuse = reject)) as never);
    const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries');
    render(<OrderStageStepper order={order({})} canEdit />);
    const select = screen.getByLabelText('Stage');
    fireEvent.change(select, { target: { value: 'qc' } });
    expect(select).toHaveValue('qc'); // no snap back to «Printing» while waiting
    refuse(new Error('Only an active order has a stage'));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['project'] }));
    await waitFor(() => expect(select).toHaveValue('printing'));
  });

  it('a completed order stands at «Done» with nothing to choose', () => {
    render(<OrderStageStepper order={order({ status: 'completed', stage: 'done' })} canEdit />);
    expect(screen.getByText(/Done/)).toHaveAttribute('aria-current', 'step');
    expect(screen.queryByLabelText('Stage')).not.toBeInTheDocument();
  });

  it('a cancelled order has no stepper, and a reader gets the steps without the select', () => {
    const { container, rerender } = render(<OrderStageStepper order={order({ status: 'cancelled', stage: null })} canEdit />);
    expect(container).toBeEmptyDOMElement();
    rerender(<OrderStageStepper order={order({})} canEdit={false} />);
    expect(screen.getByRole('list')).toBeInTheDocument();
    expect(screen.queryByLabelText('Stage')).not.toBeInTheDocument();
  });
});
