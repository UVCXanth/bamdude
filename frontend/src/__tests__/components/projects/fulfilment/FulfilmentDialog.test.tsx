import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { render } from '../../../utils';
import { api, ApiError } from '../../../../api/client';
import type { FulfilmentState } from '../../../../api/client';
import { FulfilmentDialog } from '../../../../components/projects/fulfilment/FulfilmentDialog';
import {
  clampDraft,
  completesOrder,
  draftFrom,
  issuingUnits,
  requestFrom,
} from '../../../../components/projects/fulfilment/fulfilmentState';

// The spec's line (10 ordered: 2 ready, 3 kits, 5 printed) and a parts line.
const state: FulfilmentState = {
  lines: [
    {
      line_id: 7,
      product_name: 'Pipe',
      mode: 'product',
      ordered: 10,
      from_finished: 2,
      kits_reserved: 3,
      can_assemble: 3,
      can_receive: 5,
      held: 2,
      issued: 0,
      parts: [],
    },
    {
      line_id: 8,
      product_name: 'Lamp',
      mode: 'parts',
      ordered: 5,
      from_finished: 0,
      kits_reserved: 0,
      can_assemble: 0,
      can_receive: 0,
      held: 0,
      issued: 0,
      parts: [
        { part_id: 31, name: 'shade', wanted: 3, can_receive: 3, held: 0, issued: 0 },
        { part_id: 32, name: 'base', wanted: 2, can_receive: 1, held: 0, issued: 0 },
      ],
    },
  ],
  ordered: 15,
  issued: 0,
  held: 2,
  fully_issued: false,
  can_assemble: 3,
  can_receive: 9,
  can_issue: 14,
  recipient: { name: 'Ivan', phone: '+380501112233', delivery_method: 'Nova Poshta', delivery_details: 'Branch 5' },
};

describe('fulfilmentState', () => {
  it('fills everything, or receives only', () => {
    const all = draftFrom(state, 'all');
    expect(all[7]).toEqual({ assemble: 3, receive: 5, issue: 10, parts: {} });
    expect(all[8].parts).toEqual({ 31: { receive: 3, issue: 3 }, 32: { receive: 1, issue: 1 } });
    const receive = draftFrom(state, 'receive');
    expect(receive[7].issue).toBe(0);
    expect(receive[8].parts[31]).toEqual({ receive: 3, issue: 0 });
  });

  it('issues no more than lies on the shelf after assembling and receiving', () => {
    const draft = draftFrom(state, 'all');
    draft[7] = { ...draft[7], receive: 1 };
    expect(clampDraft(draft, state)[7].issue).toBe(6); // 2 held + 3 assembled + 1 received
  });

  it('asks for what is not zero and knows when the order would be complete', () => {
    const draft = draftFrom(state, 'all');
    expect(issuingUnits(draft)).toBe(14);
    expect(completesOrder(state, draft)).toBe(false); // the base: 1 of 2
    expect(requestFrom(draftFrom(state, 'receive'))).toEqual([
      { line_id: 7, assemble: 3, receive: 5, issue: 0 },
      {
        line_id: 8,
        parts: [
          { part_id: 31, receive: 3, issue: 0 },
          { part_id: 32, receive: 1, issue: 0 },
        ],
      },
    ]);
  });
});

describe('FulfilmentDialog', () => {
  let fulfil: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getFulfilment').mockResolvedValue(state);
    vi.spyOn(api, 'getDeliveryMethods').mockResolvedValue([
      { id: 1, name: 'Nova Poshta', position: 0, contacts_count: 1 },
      { id: 2, name: 'Pickup', position: 1, contacts_count: 0 },
    ]);
    fulfil = vi.spyOn(api, 'fulfilOrder').mockResolvedValue({ order: { id: 5 } as never, issue_id: 12 });
  });

  it('shows one row per line with the server numbers and expands a parts line', async () => {
    render(<FulfilmentDialog orderId={5} onClose={() => {}} />);
    const pipe = await screen.findByTestId('fulfil-line-7');
    expect(within(pipe).getByLabelText('Assemble — Pipe')).toHaveValue(3);
    expect(within(pipe).getByLabelText('Receive — Pipe')).toHaveValue(5);
    expect(within(pipe).getByLabelText('Issue now — Pipe')).toHaveValue(10);
    expect(within(pipe).getByText('of 3')).toBeInTheDocument();
    expect(screen.getByLabelText('Receive — base')).toHaveValue(1);
    expect(screen.getByText('Issue now: 14 pcs')).toBeInTheDocument();
  });

  it('opens with nothing to issue when it only receives', async () => {
    render(<FulfilmentDialog orderId={5} mode="receive" onClose={() => {}} />);
    expect(await screen.findByLabelText('Issue now — Pipe')).toHaveValue(0);
    expect(screen.getByText('Issue now: 0 pcs')).toBeInTheDocument();
  });

  it('prefills the recipient and limits the waybill', async () => {
    render(<FulfilmentDialog orderId={5} onClose={() => {}} />);
    expect(await screen.findByLabelText('Recipient name')).toHaveValue('Ivan');
    expect(screen.getByLabelText('Phone')).toHaveValue('+380501112233');
    expect(screen.getByLabelText('Delivery method')).toHaveValue('Nova Poshta');
    expect(screen.getByLabelText('Waybill no.')).toHaveAttribute('maxLength', '24');
  });

  it('closes the order only when this issue hands over everything', async () => {
    const complete = { ...state, lines: [state.lines[0]], ordered: 10 };
    vi.spyOn(api, 'getFulfilment').mockResolvedValue(complete);
    render(<FulfilmentDialog orderId={5} onClose={() => {}} />);
    const close = await screen.findByLabelText('Close the order');
    expect(close).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Issue now — Pipe'), { target: { value: '4' } });
    expect(close).toBeDisabled();
  });

  it('posts the batch, then invalidates and closes', async () => {
    const onClose = vi.fn();
    render(<FulfilmentDialog orderId={5} onClose={onClose} />);
    fireEvent.change(await screen.findByLabelText('Issue now — Pipe'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Waybill no.'), { target: { value: ' 2045 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Execute' }));
    await waitFor(() =>
      expect(fulfil).toHaveBeenCalledWith(5, {
        lines: [
          { line_id: 7, assemble: 3, receive: 5, issue: 4 },
          {
            line_id: 8,
            parts: [
              { part_id: 31, receive: 3, issue: 3 },
              { part_id: 32, receive: 1, issue: 1 },
            ],
          },
        ],
        recipient: state.recipient,
        waybill: '2045',
        note: null,
        complete: false,
      }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('keeps the dialog with the server sentence when it refuses', async () => {
    fulfil.mockRejectedValue(new ApiError('«Pipe»: only 2 can be issued', 409));
    const onClose = vi.fn();
    render(<FulfilmentDialog orderId={5} onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Execute' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('«Pipe»: only 2 can be issued');
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('FulfilmentDialog · after a refusal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getDeliveryMethods').mockResolvedValue([]);
  });

  it('reads the state again and keeps the numbers inside it', async () => {
    const moved = {
      ...state,
      lines: [{ ...state.lines[0], can_assemble: 0, can_receive: 1 }, state.lines[1]],
    };
    const get = vi.spyOn(api, 'getFulfilment').mockResolvedValueOnce(state).mockResolvedValue(moved);
    vi.spyOn(api, 'fulfilOrder').mockRejectedValue(new ApiError('«Pipe»: only 1 can be received', 409));
    render(<FulfilmentDialog orderId={5} onClose={() => {}} />);
    fireEvent.change(await screen.findByLabelText('Waybill no.'), { target: { value: '2045' } });
    fireEvent.click(screen.getByRole('button', { name: 'Execute' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('«Pipe»: only 1 can be received');
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByLabelText('Receive — Pipe')).toHaveValue(1));
    expect(screen.getByLabelText('Assemble — Pipe')).toHaveValue(0);
    expect(screen.getByLabelText('Waybill no.')).toHaveValue('2045'); // what was typed stays
  });

  it('bounds the recipient fields as the server does', async () => {
    vi.spyOn(api, 'getFulfilment').mockResolvedValue(state);
    render(<FulfilmentDialog orderId={5} onClose={() => {}} />);
    for (const label of ['Recipient name', 'Phone', 'Delivery details']) {
      expect(await screen.findByLabelText(label)).toHaveAttribute('maxLength', '255');
    }
  });
});
