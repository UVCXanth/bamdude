/**
 * «Stock & issue» in the Workshop frame (WS-13 E6 §E): the order named in the subtitle,
 * reading states that end, the mockup's row anatomy (configuration and stock cell from
 * H04), «all N parts» for a parts line, the performer read-only, a close mark set ONCE
 * (R09), a refusal that waits for a fresh state and trims the stored draft (R04), and
 * the dispatch-note window with its units (E15).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { render } from '../../../utils';
import { api, ApiError } from '../../../../api/client';
import type { FulfilmentLineState, FulfilmentState } from '../../../../api/client';
import { FulfilmentDialog } from '../../../../components/projects/fulfilment/FulfilmentDialog';
import type { OrderRef } from '../../../../components/projects/orderActions/orderRef';
import { DispatchNoteCreated } from '../../../../components/stock/DispatchNoteCreated';

const REF: OrderRef = {
  id: 5,
  code: 'OR-0005',
  name: 'Diffusers',
  status: 'active',
  customer_name: 'ACME',
  bankable_surplus: 0,
  due_date: null,
};

const product = (over: Partial<FulfilmentLineState>): FulfilmentLineState => ({
  line_id: 7,
  product_name: 'Diffuser',
  mode: 'product',
  ordered: 10,
  from_finished: 0,
  kits_reserved: 0,
  can_assemble: 0,
  can_receive: 4,
  held: 2,
  issued: 0,
  written_off: 0,
  parts: [],
  configuration: null,
  stock_position: null,
  ...over,
});

const choice = (option: string, is_default: boolean) => ({
  group_id: 1,
  group_name: 'Colour',
  option_id: is_default ? 1 : 2,
  option_name: option,
  is_default,
});

const STATE: FulfilmentState = {
  lines: [
    product({
      line_id: 7,
      configuration: { choices: [choice('white', true)], changed_parts: [] } as never,
      stock_position: null,
    }),
    product({
      line_id: 8,
      can_assemble: 2,
      can_receive: 0,
      held: 0,
      configuration: { choices: [choice('amber', false)], changed_parts: [] } as never,
      stock_position: { id: 3, code: 'SK-0003', location: 'A-3' },
    }),
    {
      ...product({ line_id: 9, product_name: 'Diffuser', mode: 'parts', ordered: 5, can_receive: 0, held: 0 }),
      parts: [
        { part_id: 31, name: 'shade', wanted: 3, can_receive: 3, held: 0, issued: 0, written_off: 0 },
        { part_id: 32, name: 'base', wanted: 2, can_receive: 2, held: 0, issued: 0, written_off: 0 },
      ],
    },
  ],
  ordered: 25,
  issued: 0,
  held: 2,
  fully_issued: false,
  can_assemble: 2,
  can_receive: 9,
  can_issue: 13,
  closes_to_stock: false,
  can_complete: false,
  recipient: { name: 'Ivan', phone: '+380501112233', delivery_method: 'Nova Poshta', delivery_details: 'Branch 5' },
};

const grabbed = vi.hoisted(() => ({ client: null as QueryClient | null }));
function Grab() {
  const client = useQueryClient();
  useEffect(() => {
    grabbed.client = client;
  }, [client]);
  return null;
}

beforeEach(() => {
  vi.restoreAllMocks();
  grabbed.client = null;
  vi.spyOn(api, 'getDeliveryMethods').mockResolvedValue([{ id: 1, name: 'Nova Poshta', position: 0, contacts_count: 1 }]);
});

const submitButton = () => screen.getByRole('button', { name: 'Execute' });

describe('FulfilmentDialog · frame and reading (E01–E02)', () => {
  it('names the order, its customer, or says there is none', async () => {
    vi.spyOn(api, 'getFulfilment').mockResolvedValue(STATE);
    const { unmount } = render(<FulfilmentDialog order={REF} onClose={() => {}} />);
    expect(screen.getByRole('dialog', { name: 'Stock & issue' })).toHaveTextContent('OR-0005 · Diffusers · ACME');
    unmount();
    render(<FulfilmentDialog order={{ ...REF, customer_name: null }} onClose={() => {}} />);
    expect(screen.getByRole('dialog', { name: 'Stock & issue' })).toHaveTextContent('OR-0005 · Diffusers · without customer');
  });

  it('says when the state could not be read, and reads it again — never «loading» for ever', async () => {
    const get = vi.spyOn(api, 'getFulfilment').mockRejectedValueOnce(new Error('Gateway timeout')).mockResolvedValue(STATE);
    render(<FulfilmentDialog order={REF} onClose={() => {}} />);
    expect(submitButton()).toBeDisabled();
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('fulfil-line-7')).toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe('FulfilmentDialog · rows (E04–E06)', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getFulfilment').mockResolvedValue(STATE);
  });

  it('tells two lines of one product apart by their configuration, and says where the goods are', async () => {
    render(<FulfilmentDialog order={REF} onClose={() => {}} />);
    const white = await screen.findByTestId('fulfil-line-7');
    const amber = screen.getByTestId('fulfil-line-8');
    expect(white).toHaveTextContent('standard');
    expect(white).not.toHaveTextContent('cell');
    expect(amber).toHaveTextContent('Colour: amber');
    expect(amber).toHaveTextContent('cell A-3');
    // Nothing to assemble on line 7: a dash, not a dead field.
    expect(within(white).queryByLabelText('Assemble from kits — Diffuser')).not.toBeInTheDocument();
    expect(within(white).getByText('of 4')).toBeInTheDocument();
    expect(within(white).getByText('0 / 10')).toBeInTheDocument();
  });

  it('marks a configuration that differs from the standard, and a parts line, as the lines table does', async () => {
    render(<FulfilmentDialog order={REF} onClose={() => {}} />);
    const white = await screen.findByTestId('fulfil-line-7');
    const accented = (row: HTMLElement) =>
      Array.from(row.querySelectorAll('[data-config-accent]')).map((el) => el.textContent);
    expect(accented(white)).toEqual([]);
    expect(accented(screen.getByTestId('fulfil-line-8'))).toEqual(['Colour: amber']);
    expect(accented(screen.getByTestId('fulfil-line-9'))).toEqual(['parts only — through the parts book']);
  });

  it('heads the columns as the mockup does', async () => {
    render(<FulfilmentDialog order={REF} onClose={() => {}} />);
    await screen.findByTestId('fulfil-line-7');
    const heads = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(heads).toEqual(['Line / configuration', 'Ordered', 'Assemble from kits', 'Receive printed', 'On the shelf for the order', 'Issue now', 'Issued']);
  });

  it('gives a parts line «all N parts» — ticked, cleared and mixed (E06)', async () => {
    render(<FulfilmentDialog order={REF} onClose={() => {}} />);
    const line = await screen.findByTestId('fulfil-line-9');
    expect(line).toHaveTextContent('parts only — through the parts book');
    const receiveAll = within(line).getByRole('checkbox', { name: 'Receive printed — all parts of Diffuser' });
    expect(receiveAll).toBeChecked();
    expect(line).toHaveTextContent('all 5 parts');
    fireEvent.click(receiveAll);
    expect(receiveAll).not.toBeChecked();
    expect(screen.getByLabelText('Receive printed — shade')).toHaveValue(0);
    fireEvent.change(screen.getByLabelText('Receive printed — shade'), { target: { value: '3' } });
    expect((receiveAll as HTMLInputElement).indeterminate).toBe(true);
  });

  it('offers no «all» where nothing can be done', async () => {
    vi.spyOn(api, 'getFulfilment').mockResolvedValue({
      ...STATE,
      lines: [{ ...STATE.lines[2], parts: STATE.lines[2].parts.map((p) => ({ ...p, can_receive: 0 })) }],
    });
    render(<FulfilmentDialog order={REF} onClose={() => {}} />);
    const line = await screen.findByTestId('fulfil-line-9');
    expect(within(line).queryByRole('checkbox', { name: /Receive printed — all parts/ })).not.toBeInTheDocument();
  });

  it('names the write-off toggle’s state and what it controls', async () => {
    render(<FulfilmentDialog order={REF} onClose={() => {}} />);
    const toggle = await screen.findByRole('button', { name: 'Write off…' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const controlled = document.getElementById(toggle.getAttribute('aria-controls') as string);
    expect(controlled).toContainElement(screen.getByLabelText('Write-off reason'));
  });
});

describe('FulfilmentDialog · recipient, performer, close mark (E08–E09)', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getFulfilment').mockResolvedValue(STATE);
  });

  it('asks the recipient only when something is issued, and shows who performs it', async () => {
    const { unmount } = render(<FulfilmentDialog order={REF} mode="receive" onClose={() => {}} />);
    await screen.findByTestId('fulfil-line-7');
    expect(screen.queryByLabelText('Recipient name')).not.toBeInTheDocument();
    expect(screen.getByTestId('fulfil-performer')).toHaveTextContent('Done by');
    unmount();
    render(<FulfilmentDialog order={REF} onClose={() => {}} />);
    expect(await screen.findByLabelText('Recipient name')).toHaveValue('Ivan');
    expect(screen.getByRole('dialog')).toHaveTextContent('Changes only this issue, not the customer’s contact.');
  });

  it('says how far this issue goes while it cannot close the order', async () => {
    render(<FulfilmentDialog order={REF} onClose={() => {}} />);
    const close = await screen.findByRole('checkbox', { name: 'Mark the order completed' });
    expect(close).toBeDisabled();
    // Issue now: 2 held + 4 received on line 7, 2 assembled on line 8, 5 parts — 13 of 25.
    expect(screen.getByRole('dialog')).toHaveTextContent('after this issue it will be 13 of 25');
  });

  it('ticks closing once when the first full batch closes the order, and never again by itself (R09)', async () => {
    const full: FulfilmentState = { ...STATE, lines: [product({ line_id: 7, ordered: 6 })], ordered: 6 };
    vi.spyOn(api, 'getFulfilment').mockResolvedValue(full);
    render(
      <>
        <Grab />
        <FulfilmentDialog order={REF} onClose={() => {}} />
      </>,
    );
    const close = await screen.findByRole('checkbox', { name: 'Mark the order completed' });
    expect(close).toBeChecked();
    fireEvent.click(close);
    expect(close).not.toBeChecked();
    await act(async () => {
      await grabbed.client?.invalidateQueries({ queryKey: ['project-fulfilment', 5] });
    });
    expect(close).not.toBeChecked();
  });

  it('asks no closing by itself when it only receives (R09)', async () => {
    const shelf: FulfilmentState = {
      ...STATE,
      closes_to_stock: true,
      lines: [product({ line_id: 7, ordered: 6 })],
      ordered: 6,
    };
    vi.spyOn(api, 'getFulfilment').mockResolvedValue(shelf);
    render(<FulfilmentDialog order={{ ...REF, customer_name: null }} mode="receive" onClose={() => {}} />);
    const close = await screen.findByRole('checkbox', { name: 'Close to stock' });
    expect(close).not.toBeChecked();
    expect(close).toBeEnabled();
  });
});

describe('FulfilmentDialog · summary and footer (E10–E12)', () => {
  it('sums what the batch does, or says nothing is chosen', async () => {
    vi.spyOn(api, 'getFulfilment').mockResolvedValue(STATE);
    render(<FulfilmentDialog order={REF} onClose={() => {}} />);
    await screen.findByTestId('fulfil-line-7');
    expect(screen.getByRole('dialog')).toHaveTextContent('Assemble: 2 · receive: 9 · issue now: 13 pcs');
    expect(screen.getByRole('dialog')).toHaveTextContent('Order of work:');
  });

  it('says how an order without a customer closes', async () => {
    vi.spyOn(api, 'getFulfilment').mockResolvedValue({ ...STATE, closes_to_stock: true });
    render(<FulfilmentDialog order={{ ...REF, customer_name: null }} onClose={() => {}} />);
    await screen.findByTestId('fulfil-line-7');
    expect(screen.getByRole('dialog')).toHaveTextContent('No customer — nothing is issued');
    expect(screen.queryByRole('columnheader', { name: 'Issue now' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Recipient name')).not.toBeInTheDocument();
  });
});

describe('FulfilmentDialog · refusal and retry (E13, R04)', () => {
  it('waits for a fresh state after a refusal, offers to read it again, then trims the draft', async () => {
    let failRead: (e: Error) => void = () => {};
    const narrow: FulfilmentState = { ...STATE, lines: [product({ line_id: 7, can_receive: 1 })] };
    const get = vi
      .spyOn(api, 'getFulfilment')
      .mockResolvedValueOnce({ ...STATE, lines: [STATE.lines[0]] })
      .mockReturnValueOnce(new Promise((_r, reject) => (failRead = reject)))
      .mockResolvedValue(narrow);
    const post = vi.spyOn(api, 'fulfilOrder').mockRejectedValue(new ApiError('«Diffuser»: only 1 can be received', 409));
    render(<FulfilmentDialog order={REF} onClose={() => {}} />);
    await screen.findByTestId('fulfil-line-7');

    fireEvent.click(submitButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('only 1 can be received');
    expect(await screen.findByText('Reading the state again…')).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
    fireEvent.click(submitButton());
    expect(post).toHaveBeenCalledTimes(1);

    await act(async () => failRead(new Error('Gateway timeout')));
    fireEvent.click(await screen.findByRole('button', { name: 'Read again' }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
    expect(await screen.findByText('Stock changed — the numbers are limited to the new bounds.')).toBeInTheDocument();
    expect(screen.getByLabelText('Receive printed — Diffuser')).toHaveValue(1);
    expect(submitButton()).toBeEnabled();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('keeps a trimmed number trimmed when the bounds grow back (R04)', async () => {
    const at = (receive: number): FulfilmentState => ({ ...STATE, lines: [product({ line_id: 7, can_receive: receive })] });
    const get = vi.spyOn(api, 'getFulfilment').mockResolvedValueOnce(at(10)).mockResolvedValueOnce(at(6)).mockResolvedValue(at(10));
    render(
      <>
        <Grab />
        <FulfilmentDialog order={REF} onClose={() => {}} />
      </>,
    );
    const receive = await screen.findByLabelText('Receive printed — Diffuser');
    expect(receive).toHaveValue(10);
    await act(async () => {
      await grabbed.client?.invalidateQueries({ queryKey: ['project-fulfilment', 5] });
    });
    await waitFor(() => expect(receive).toHaveValue(6));
    await act(async () => {
      await grabbed.client?.invalidateQueries({ queryKey: ['project-fulfilment', 5] });
    });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
    expect(receive).toHaveValue(6);
  });
});

describe('FulfilmentDialog · first focus and success (E14–E16)', () => {
  it('puts the first focus in the first number of the table', async () => {
    vi.spyOn(api, 'getFulfilment').mockResolvedValue(STATE);
    render(<FulfilmentDialog order={REF} onClose={() => {}} />);
    const line = await screen.findByTestId('fulfil-line-7');
    // Line 7 has nothing to assemble — its first number is «Receive printed».
    await waitFor(() => expect(document.activeElement).toBe(within(line).getByLabelText('Receive printed — Diffuser')));
  });

  it('turns into the dispatch-note window with its units', async () => {
    vi.spyOn(api, 'getFulfilment').mockResolvedValue(STATE);
    vi.spyOn(api, 'fulfilOrder').mockResolvedValue({ order: { id: 5 } as never, issue_id: 12, issue_code: 'DN-0012', issue_units: 13 });
    render(<FulfilmentDialog order={REF} onClose={() => {}} />);
    await screen.findByTestId('fulfil-line-7');
    fireEvent.click(submitButton());
    const note = await screen.findByRole('dialog', { name: 'Dispatch note issued' });
    expect(note).toHaveTextContent('DN-0012 · 13 pcs');
    expect(note).toHaveTextContent('it is on the order card');
  });
});

describe('DispatchNoteCreated (E15)', () => {
  it('opens the note on the explicit button and focuses it first', async () => {
    const onClose = vi.fn();
    render(<DispatchNoteCreated id={12} code="DN-0012" units={3} onClose={onClose} />);
    const open = screen.getByRole('button', { name: 'Open and print' });
    await waitFor(() => expect(document.activeElement).toBe(open));
    fireEvent.click(open);
    expect(window.location.pathname).toBe('/stock/dispatch-notes/12');
    expect(onClose).toHaveBeenCalled();
  });

  it('names the code alone when the units are not known', () => {
    render(<DispatchNoteCreated id={12} code="DN-0012" fromOrder={false} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: 'Dispatch note issued' });
    expect(dialog).toHaveTextContent('DN-0012');
    expect(dialog).not.toHaveTextContent('pcs');
  });
});
