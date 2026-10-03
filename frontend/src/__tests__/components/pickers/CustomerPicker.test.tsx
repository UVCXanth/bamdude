import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '../../utils';
import { api, ApiError } from '../../../api/client';
import { CustomerPicker } from '../../../components/pickers/CustomerPicker';
import { createAppQueryClient } from '../../../utils/appQueryClient';

const taken = () =>
  Object.assign(new ApiError('A customer with this name already exists: CU-0003', 409, 'name_taken'), {
    refs: { customer: 3 },
  });

async function openCreate(name: string) {
  const select = await screen.findByRole('combobox');
  fireEvent.change(select, { target: { value: screen.getByRole('option', { name: /new customer/i }).getAttribute('value') } });
  fireEvent.change(screen.getByRole('textbox'), { target: { value: name } });
  fireEvent.click(screen.getByRole('button', { name: /^create$/i }));
}

const figures = { projects: 0, active: 0, completed: 0, cancelled: 0, total_price: 0 };
const customers = [
  { id: 1, code: 'CU-0001', name: 'Acme', kind: 'company' as const, notes: null, created_at: '', updated_at: '', contacts: [], figures },
];

describe('CustomerPicker', () => {
  beforeEach(() => vi.restoreAllMocks());

  describe('a namesake (WS-13 E11 F12, R01)', () => {
    const beta = { ...customers[0], id: 3, code: 'CU-0003', name: 'Beta' };

    it('says the server\'s sentence with «Choose it» and «Create another» — no toast', async () => {
      vi.spyOn(api, 'getCustomers').mockResolvedValue(customers as never);
      vi.spyOn(api, 'createCustomer').mockRejectedValue(taken());
      render(<CustomerPicker value={null} onChange={() => {}} allowCreate />);
      await openCreate('Beta');
      expect(await screen.findByText('A customer with this name already exists: CU-0003')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Choose it' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Create another' })).toBeInTheDocument();
    });

    it('«Choose it» reads the list afresh — past the app\'s minute of staleTime — and chooses the namesake', async () => {
      const read = vi
        .spyOn(api, 'getCustomers')
        .mockResolvedValueOnce(customers as never)
        .mockResolvedValue([...customers, beta] as never);
      vi.spyOn(api, 'createCustomer').mockRejectedValue(taken());
      const onChange = vi.fn();
      render(
        <QueryClientProvider client={createAppQueryClient()}>
          <CustomerPicker value={null} onChange={onChange} allowCreate />
        </QueryClientProvider>,
      );
      await openCreate('Beta');
      fireEvent.click(await screen.findByRole('button', { name: 'Choose it' }));
      await waitFor(() => expect(onChange).toHaveBeenCalledWith(3));
      expect(read).toHaveBeenCalledTimes(2);
      expect(await screen.findByRole('option', { name: 'CU-0003 · Beta' })).toBeInTheDocument();
    });

    it('a namesake deleted meanwhile says so — and «Create another» stays', async () => {
      vi.spyOn(api, 'getCustomers').mockResolvedValue(customers as never);
      vi.spyOn(api, 'createCustomer').mockRejectedValue(taken());
      const onChange = vi.fn();
      render(<CustomerPicker value={null} onChange={onChange} allowCreate />);
      await openCreate('Beta');
      fireEvent.click(await screen.findByRole('button', { name: 'Choose it' }));
      expect(await screen.findByText('This customer is gone')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Create another' })).toBeInTheDocument();
      expect(onChange).not.toHaveBeenCalled();
    });

    it('a list that could not be read says so with a retry — never a select with a hidden choice', async () => {
      vi.spyOn(api, 'getCustomers').mockResolvedValueOnce(customers as never).mockRejectedValueOnce(new Error('HTTP 500'));
      vi.spyOn(api, 'createCustomer').mockRejectedValue(taken());
      const onChange = vi.fn();
      render(<CustomerPicker value={null} onChange={onChange} allowCreate />);
      await openCreate('Beta');
      fireEvent.click(await screen.findByRole('button', { name: 'Choose it' }));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Could not read the customers');
      expect(onChange).not.toHaveBeenCalled();
      expect(screen.getByRole('textbox')).toHaveValue('Beta');
    });

    it('«Create another» sends the same name with the flag', async () => {
      vi.spyOn(api, 'getCustomers').mockResolvedValue(customers as never);
      const create = vi.spyOn(api, 'createCustomer').mockRejectedValueOnce(taken()).mockResolvedValueOnce({ id: 9 } as never);
      const onChange = vi.fn();
      render(<CustomerPicker value={null} onChange={onChange} allowCreate />);
      await openCreate('Beta');
      fireEvent.click(await screen.findByRole('button', { name: 'Create another' }));
      await waitFor(() => expect(create).toHaveBeenLastCalledWith({ name: 'Beta', allow_duplicate_name: true }));
      await waitFor(() => expect(onChange).toHaveBeenCalledWith(9));
    });

    it('changing the name takes the warning away; the next create is an ordinary one', async () => {
      vi.spyOn(api, 'getCustomers').mockResolvedValue(customers as never);
      const create = vi.spyOn(api, 'createCustomer').mockRejectedValueOnce(taken()).mockResolvedValueOnce({ id: 9 } as never);
      render(<CustomerPicker value={null} onChange={() => {}} allowCreate />);
      await openCreate('Beta');
      await screen.findByRole('button', { name: 'Choose it' });
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Gamma' } });
      expect(screen.queryByRole('button', { name: 'Choose it' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /^create$/i }));
      await waitFor(() => expect(create).toHaveBeenLastCalledWith({ name: 'Gamma' }));
    });

    it('under its request the field, Create, × and Escape do nothing — decided in the same frame', async () => {
      vi.spyOn(api, 'getCustomers').mockResolvedValue(customers as never);
      const create = vi.spyOn(api, 'createCustomer').mockReturnValue(new Promise(() => {}) as never);
      render(<CustomerPicker value={null} onChange={() => {}} allowCreate />);
      const select = await screen.findByRole('combobox');
      fireEvent.change(select, { target: { value: screen.getByRole('option', { name: /new customer/i }).getAttribute('value') } });
      const input = screen.getByRole('textbox');
      fireEvent.change(input, { target: { value: 'Beta' } });
      const button = screen.getByRole('button', { name: /^create$/i });
      const back = screen.getByRole('button', { name: /cancel/i });
      act(() => {
        button.click();
        button.click();
        fireEvent.keyDown(input, { key: 'Escape' });
        back.click();
      });
      await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      expect(screen.getByRole('textbox')).toHaveValue('Beta');
    });
  });

  it('names each customer by its code and name', async () => {
    vi.spyOn(api, 'getCustomers').mockResolvedValue(customers);
    render(<CustomerPicker value={null} onChange={() => {}} />);
    expect(await screen.findByRole('option', { name: 'CU-0001 · Acme' })).toBeInTheDocument();
  });

  it('renders "no customer" first', async () => {
    vi.spyOn(api, 'getCustomers').mockResolvedValue(customers as never);
    render(<CustomerPicker value={null} onChange={() => {}} />);
    const options = await screen.findAllByRole('option');
    expect(options[0]).toHaveTextContent('No customer');
  });

  it('choosing "new customer…" shows a name input, and submitting creates the customer', async () => {
    vi.spyOn(api, 'getCustomers').mockResolvedValue(customers as never);
    const create = vi.spyOn(api, 'createCustomer').mockResolvedValue({ id: 7, name: 'Beta' } as never);
    const onChange = vi.fn();
    render(<CustomerPicker value={null} onChange={onChange} allowCreate />);
    const select = await screen.findByRole('combobox');
    fireEvent.change(select, { target: { value: screen.getByRole('option', { name: /new customer/i }).getAttribute('value') } });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Beta' } });
    fireEvent.click(screen.getByRole('button', { name: /create/i }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ name: 'Beta' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(7));
  });

  it('honours disabled once the create-name view is showing', async () => {
    vi.spyOn(api, 'getCustomers').mockResolvedValue(customers as never);
    const create = vi.spyOn(api, 'createCustomer').mockResolvedValue({ id: 8, name: 'Gamma' } as never);
    const { rerender } = render(<CustomerPicker value={null} onChange={() => {}} allowCreate />);
    const select = await screen.findByRole('combobox');
    fireEvent.change(select, {
      target: { value: screen.getByRole('option', { name: /new customer/i }).getAttribute('value') },
    });
    rerender(<CustomerPicker value={null} onChange={() => {}} allowCreate disabled />);
    expect(screen.getByRole('textbox')).toBeDisabled();
    const createButton = screen.getByRole('button', { name: /create/i });
    expect(createButton).toBeDisabled();
    fireEvent.click(createButton);
    expect(create).not.toHaveBeenCalled();
  });

  it('Escape in the name field steps back to the select without creating anything', async () => {
    // Picking "new customer…" by accident used to be a one-way door: the only
    // way back was to create a customer nobody wanted.
    vi.spyOn(api, 'getCustomers').mockResolvedValue(customers as never);
    const create = vi.spyOn(api, 'createCustomer').mockResolvedValue({ id: 9, name: 'Delta' } as never);
    render(<CustomerPicker value={null} onChange={() => {}} allowCreate />);
    const select = await screen.findByRole('combobox');
    fireEvent.change(select, {
      target: { value: screen.getByRole('option', { name: /new customer/i }).getAttribute('value') },
    });

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Delta' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(await screen.findByRole('combobox')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });

  it('the × beside Create goes back and forgets what was typed', async () => {
    vi.spyOn(api, 'getCustomers').mockResolvedValue(customers as never);
    const create = vi.spyOn(api, 'createCustomer').mockResolvedValue({ id: 9, name: 'Delta' } as never);
    render(<CustomerPicker value={null} onChange={() => {}} allowCreate />);
    const select = await screen.findByRole('combobox');
    fireEvent.change(select, {
      target: { value: screen.getByRole('option', { name: /new customer/i }).getAttribute('value') },
    });

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Delta' } });
    fireEvent.click(screen.getByRole('button', { name: /cancel creating customer/i }));

    expect(await screen.findByRole('combobox')).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();

    // Back in again: the abandoned name is gone, so Create is not offered.
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: screen.getByRole('option', { name: /new customer/i }).getAttribute('value') },
    });
    expect(screen.getByRole('textbox')).toHaveValue('');
  });
  it('names its Cancel for what it cancels, not just "Cancel"', async () => {
    // ⚠️ The picker lives INSIDE dialogs that have a Cancel of their own. Two
    // buttons called "Cancel" in one form is a coin toss for anybody driving
    // it by accessible name — a screen reader, a keyboard user reading the
    // rotor, or a test.
    vi.spyOn(api, 'getCustomers').mockResolvedValue(customers as never);
    render(<CustomerPicker value={null} onChange={() => {}} allowCreate />);
    const select = await screen.findByRole('combobox');
    fireEvent.change(select, {
      target: { value: screen.getByRole('option', { name: /new customer/i }).getAttribute('value') },
    });

    expect(screen.getByRole('button', { name: /cancel creating customer/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^cancel$/i })).not.toBeInTheDocument();
  });
});
