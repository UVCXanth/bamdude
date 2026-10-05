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
  it('offers to receive, to issue and to close — each through the issue dialog', async () => {
    const onFulfil = vi.fn();
    render(<CloseSuggestionBanner order={order} state={state} onFulfil={onFulfil} />);
    expect(screen.getByText('Issued 4 of 10 · on the shelf for the order 6')).toBeInTheDocument();
    // Receiving and issuing wait for the signed-in user's stock move (WS-13 E13 O06).
    fireEvent.click(await screen.findByRole('button', { name: 'Receive into stock (3)…' }));
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

  it('explains what closing to stock does, and says nothing about issuing (WS-13 E3 D04, E04)', () => {
    render(<CloseSuggestionBanner order={order} state={{ ...state, closes_to_stock: true }} onFulfil={() => {}} />);
    const banner = screen.getByTestId('close-suggestion');
    expect(banner).toHaveTextContent(/No customer — nothing is issued/);
    expect(banner).toHaveTextContent(/no dispatch note/);
  });
});

describe('CloseSuggestionBanner · one primary action (WS-13 E3 D04)', () => {
  const primaries = () => screen.getAllByRole('button').filter((b) => b.dataset.emphasis === 'primary');

  it('leads with receiving while there are prints to receive', async () => {
    render(<CloseSuggestionBanner order={order} state={state} onFulfil={() => {}} />);
    await screen.findByTestId('close-suggestion-receive');
    expect(primaries().map((b) => b.dataset.testid)).toEqual(['close-suggestion-receive']);
  });

  it('leads with issuing once nothing is left to receive', async () => {
    render(<CloseSuggestionBanner order={order} state={{ ...state, can_receive: 0 }} onFulfil={() => {}} />);
    await screen.findByTestId('close-suggestion-issue');
    expect(primaries().map((b) => b.dataset.testid)).toEqual(['close-suggestion-issue']);
  });

  it('leads with nothing while the order’s issue state is still being read', () => {
    render(<CloseSuggestionBanner order={order} state={undefined} onFulfil={() => {}} />);
    expect(primaries()).toHaveLength(0);
  });

  it('leads with completing when that is all there is left', () => {
    render(<CloseSuggestionBanner order={order} state={{ ...state, can_receive: 0, can_issue: 0 }} onFulfil={() => {}} />);
    expect(primaries().map((b) => b.dataset.testid)).toEqual(['close-suggestion-complete']);
  });
});
