import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { render } from '../../utils';
import type { FulfilmentState, Order } from '../../../api/client';
import { CloseSuggestionBanner } from '../../../components/projects/CloseSuggestionBanner';

const order = { id: 1, status: 'active', figures: { all_printed: true } } as unknown as Order;
const state: FulfilmentState = {
  lines: [],
  ordered: 10,
  issued: 4,
  held: 6,
  fully_issued: false,
  can_assemble: 0,
  can_receive: 3,
  can_issue: 9,
  closes_to_stock: false,
  can_complete: false,
  recipient: { name: null, phone: null, delivery_method: null, delivery_details: null },
};

describe('CloseSuggestionBanner', () => {
  it('offers to receive, to issue and to close — each through the issue dialog', () => {
    const onFulfil = vi.fn();
    render(<CloseSuggestionBanner order={order} state={state} onFulfil={onFulfil} />);
    expect(screen.getByText('Issued 4 of 10 · on the shelf for the order 6')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Receive into stock (3)…' }));
    expect(onFulfil).toHaveBeenLastCalledWith('receive', false);
    fireEvent.click(screen.getByRole('button', { name: 'Issue to the customer (9)…' }));
    expect(onFulfil).toHaveBeenLastCalledWith('all', false);
    fireEvent.click(screen.getByTestId('close-suggestion-complete'));
    expect(onFulfil).toHaveBeenLastCalledWith('all', true);
  });

  it('offers only what there is to do', () => {
    render(
      <CloseSuggestionBanner order={order} state={{ ...state, can_receive: 0, can_issue: 0 }} onFulfil={() => {}} />,
    );
    expect(screen.queryByRole('button', { name: /Receive into stock/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Issue to the customer/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('close-suggestion-complete')).toBeInTheDocument();
  });

  it('says nothing on a closed order', () => {
    render(
      <CloseSuggestionBanner order={{ ...order, status: 'completed' } as Order} state={state} onFulfil={() => {}} />,
    );
    expect(screen.queryByTestId('close-suggestion')).not.toBeInTheDocument();
  });
});

describe('CloseSuggestionBanner · an order without a customer', () => {
  it('is offered «Close to stock» and no issue button', () => {
    const onFulfil = vi.fn();
    render(<CloseSuggestionBanner order={order} state={{ ...state, closes_to_stock: true }} onFulfil={onFulfil} />);
    expect(screen.queryByTestId('close-suggestion-issue')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close to stock' }));
    expect(onFulfil).toHaveBeenCalledWith('all', true);
  });
});
