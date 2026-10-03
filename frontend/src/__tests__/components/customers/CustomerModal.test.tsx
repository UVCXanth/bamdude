/**
 * The customer form (WS-13 E11 F, F20): a WorkshopDialog with the mockup's fields, contact
 * rows in its grid, the server's refusals in the dialog, the namesake warning that belongs
 * to the name it was given for (R01), a PATCH of what changed since the dialog opened, the
 * method select's own read states (R04) and the delivery reference behind
 * `projects:update` (R03).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router';
import { render } from '../../utils';
import { server } from '../../mocks/server';
import { api, ApiError } from '../../../api/client';
import type { Customer } from '../../../api/client';
import { CustomerModal } from '../../../components/customers/CustomerModal';

const blank = {
  role: null,
  phone: null,
  email: null,
  city: null,
  delivery_method_id: null,
  delivery_method_name: null,
  delivery_details: null,
  note: null,
};
const acme: Customer = {
  id: 1,
  code: 'CU-0001',
  name: 'ACME',
  kind: 'company',
  notes: null,
  created_at: '',
  updated_at: '',
  contacts: [
    { ...blank, id: 10, code: 'CT-0010', name: 'Olena', orders_count: 0 },
    { ...blank, id: 11, code: 'CT-0011', name: 'Serhii', orders_count: 2 },
  ],
  figures: { projects: 0, active: 0, completed: 0, cancelled: 0, total_price: 0 },
};
const withMethod: Customer = {
  ...acme,
  contacts: [{ ...blank, id: 10, code: 'CT-0010', name: 'Olena', orders_count: 0, delivery_method_id: 7, delivery_method_name: 'Nova Poshta' }],
};

const save = () => screen.getByRole('button', { name: /^(Save customer|Save anyway|Saving…)$/ });
const nameTaken = () =>
  Object.assign(new ApiError('A customer with this name already exists: CU-0003', 409, 'name_taken'), { refs: { customer: 3 } });

function asCreator() {
  server.use(
    http.get('/api/v1/auth/me', () =>
      HttpResponse.json({
        id: 3,
        username: 'clerk',
        role: 'user',
        is_active: true,
        is_admin: false,
        groups: [{ id: 3, name: 'Clerks' }],
        permissions: ['projects:read', 'projects:create'],
        created_at: '2024-01-01T00:00:00Z',
      }),
    ),
  );
}

describe('CustomerModal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getDeliveryMethods').mockResolvedValue([{ id: 7, name: 'Nova Poshta', position: 0, contacts_count: 1 }]);
  });
  afterEach(() => window.history.pushState({}, '', '/'));

  describe('the frame and the fields (F01–F04)', () => {
    it('«New customer» with the cursor in the name; «Edit customer» names the code', async () => {
      const { unmount } = render(<CustomerModal onClose={() => {}} />);
      const dialog = screen.getByRole('dialog', { name: 'New customer' });
      await waitFor(() => expect(within(dialog).getByLabelText('Name')).toHaveFocus());
      expect(within(dialog).getByLabelText('Name')).toHaveAttribute('maxlength', '255');
      expect(within(dialog).getByLabelText('Type')).toHaveValue('company');
      expect(within(dialog).getByLabelText('Team note').tagName).toBe('TEXTAREA');
      expect(within(dialog).getByRole('button', { name: 'Save customer' })).toBeInTheDocument();
      unmount();
      render(<CustomerModal customer={acme} onClose={() => {}} />);
      expect(screen.getByRole('dialog', { name: 'Edit customer' })).toHaveAccessibleDescription('CU-0001');
    });

    it('a contact row: name, role, phone · email, city, method · details, × — the inputs capped at their columns', () => {
      render(<CustomerModal customer={acme} onClose={() => {}} />);
      const row = screen.getAllByTestId('contact-row')[0];
      for (const label of ['Contact name', 'Role', 'Phone', 'Email', 'City', 'Delivery details']) {
        expect(within(row).getByLabelText(label)).toHaveAttribute('maxlength', '255');
      }
      expect(within(row).getByLabelText('Phone')).toHaveAttribute('type', 'tel');
      expect(within(row).getByLabelText('Email')).toHaveAttribute('type', 'email');
      expect(within(row).getByRole('button', { name: 'Remove contact' })).toBeInTheDocument();
      // No note yet — the row offers one instead of an empty box.
      expect(within(row).queryByLabelText('Note')).toBeNull();
      fireEvent.click(within(row).getByRole('button', { name: '+ Note' }));
      expect(within(row).getByLabelText('Note')).toHaveFocus();
    });

    it('«Add contact» adds a row and puts the cursor in its name', async () => {
      render(<CustomerModal customer={acme} onClose={() => {}} />);
      fireEvent.click(screen.getByRole('button', { name: 'Add contact' }));
      const rows = screen.getAllByTestId('contact-row');
      expect(rows).toHaveLength(3);
      await waitFor(() => expect(within(rows[2]).getByLabelText('Contact name')).toHaveFocus());
    });

    it('an existing contact names its code beside «Contact N»; a new row has none (K.1)', () => {
      render(<CustomerModal customer={acme} onClose={() => {}} />);
      const rows = screen.getAllByTestId('contact-row');
      expect(within(rows[0]).getByText('CT-0010')).toBeInTheDocument();
      expect(within(rows[1]).getByText('CT-0011')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Add contact' }));
      expect(within(screen.getAllByTestId('contact-row')[2]).queryByText(/^CT-/)).toBeNull();
    });

    it('«Make main» is offered on a filled row below the main one — never on the main row or a blank one (F04)', () => {
      render(<CustomerModal onClose={() => {}} />);
      fireEvent.click(screen.getByRole('button', { name: 'Add contact' }));
      fireEvent.click(screen.getByRole('button', { name: 'Add contact' }));
      const rows = screen.getAllByTestId('contact-row');
      fireEvent.change(within(rows[1]).getByLabelText('Contact name'), { target: { value: 'Ira' } });
      fireEvent.change(within(rows[2]).getByLabelText('Contact name'), { target: { value: 'Oleh' } });
      expect(within(rows[0]).queryByRole('button', { name: 'Make main' })).toBeNull();
      expect(within(rows[1]).getByText('main')).toBeInTheDocument();
      expect(within(rows[1]).queryByRole('button', { name: 'Make main' })).toBeNull();
      expect(within(rows[2]).getByRole('button', { name: 'Make main' })).toBeInTheDocument();
    });

    it('a row is walked in the order it is drawn: the name first, «Remove contact» after the phone', () => {
      render(<CustomerModal customer={acme} onClose={() => {}} />);
      const row = screen.getAllByTestId('contact-row')[0];
      const order = [...row.querySelectorAll('input, select, textarea, button')].map(
        (el) => el.getAttribute('aria-label') ?? row.querySelector(`label[for="${el.id}"]`)?.textContent ?? el.textContent,
      );
      expect(order.indexOf('Contact name')).toBe(0);
      expect(order.indexOf('Remove contact')).toBe(order.indexOf('Phone') + 1);
      expect(order.indexOf('Remove contact')).toBeLessThan(order.indexOf('Email'));
    });

    it('«main» stands on the first row that will be sent, never on an empty one above it (F05)', () => {
      render(<CustomerModal onClose={() => {}} />);
      fireEvent.click(screen.getByRole('button', { name: 'Add contact' }));
      const rows = screen.getAllByTestId('contact-row');
      expect(within(rows[0]).queryByText('main')).toBeNull();
      fireEvent.change(within(rows[1]).getByLabelText('Contact name'), { target: { value: 'Ira' } });
      expect(within(rows[1]).getByText('main')).toBeInTheDocument();
      expect(within(rows[0]).queryByText('main')).toBeNull();
    });
  });

  describe('saving (F08–F11)', () => {
    it('a new customer sends kind, team note and the filled rows; it opens at once', async () => {
      const create = vi.spyOn(api, 'createCustomer').mockResolvedValue({ ...acme, id: 2 });
      window.history.pushState({}, '', '/customers');
      render(
        <Routes>
          <Route path="/customers" element={<CustomerModal onClose={() => {}} />} />
          <Route path="/customers/:id" element={<p>customer page</p>} />
        </Routes>,
      );
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Beta' } });
      fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'regular' } });
      fireEvent.change(screen.getByLabelText('Team note'), { target: { value: ' pays late ' } });
      const rows = screen.getAllByTestId('contact-row');
      expect(rows).toHaveLength(1);
      fireEvent.change(within(rows[0]).getByLabelText('Contact name'), { target: { value: ' Ira ' } });
      await within(rows[0]).findByRole('option', { name: 'Nova Poshta' });
      fireEvent.change(within(rows[0]).getByLabelText('Delivery method'), { target: { value: '7' } });
      fireEvent.change(within(rows[0]).getByLabelText('Delivery details'), { target: { value: 'branch 5' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add contact' })); // a second, left empty: not sent
      fireEvent.click(save());
      await waitFor(() =>
        expect(create).toHaveBeenCalledWith({
          name: 'Beta',
          kind: 'regular',
          notes: 'pays late',
          contacts: [
            {
              name: 'Ira',
              role: null,
              phone: null,
              email: null,
              city: null,
              delivery_method_id: 7,
              delivery_details: 'branch 5',
              note: null,
            },
          ],
        }),
      );
      expect(await screen.findByText('customer page')).toBeInTheDocument();
      expect(screen.getByText('Customer created')).toBeInTheDocument();
    });

    it('an empty name is said in the dialog with the cursor back in it — nothing is sent', async () => {
      const create = vi.spyOn(api, 'createCustomer');
      render(<CustomerModal onClose={() => {}} />);
      fireEvent.click(save());
      expect(await screen.findByRole('alert')).toHaveTextContent('Enter the customer’s name.');
      expect(screen.getByLabelText('Name')).toHaveFocus();
      expect(create).not.toHaveBeenCalled();
    });

    it('a refusal stays in the dialog — never a toast — with the focus on the button that sent it', async () => {
      vi.spyOn(api, 'updateCustomer').mockRejectedValue(new ApiError('Delivery method 7 not found', 422));
      const onClose = vi.fn();
      render(<CustomerModal customer={acme} onClose={onClose} />);
      fireEvent.change(within(screen.getAllByTestId('contact-row')[0]).getByLabelText('City'), { target: { value: 'Lviv' } });
      fireEvent.click(save());
      expect(await screen.findByRole('alert')).toHaveTextContent('Delivery method 7 not found');
      await waitFor(() => expect(save()).toHaveFocus());
      expect(onClose).not.toHaveBeenCalled();
    });

    it('an edit sends only what changed since it opened — a name alone carries no contacts', async () => {
      const update = vi.spyOn(api, 'updateCustomer').mockResolvedValue(acme);
      const onClose = vi.fn();
      render(<CustomerModal customer={acme} onClose={onClose} />);
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'ACME Ltd' } });
      fireEvent.click(save());
      await waitFor(() => expect(update).toHaveBeenCalledWith(1, { name: 'ACME Ltd' }));
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(screen.getByText('Customer saved')).toBeInTheDocument();
    });

    it('nothing changed — nothing is sent, the dialog closes', async () => {
      const update = vi.spyOn(api, 'updateCustomer');
      const onClose = vi.fn();
      render(<CustomerModal customer={acme} onClose={onClose} />);
      fireEvent.click(save());
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(update).not.toHaveBeenCalled();
    });

    it('a stored note with spaces around it is not sent by an untouched save', async () => {
      const update = vi.spyOn(api, 'updateCustomer').mockResolvedValue(acme);
      const onClose = vi.fn();
      render(<CustomerModal customer={{ ...acme, notes: '  call first\n' }} onClose={onClose} />);
      fireEvent.click(save());
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(update).not.toHaveBeenCalled();
    });

    it('under a request nothing closes it and nothing sends twice — decided in the same frame (F10)', async () => {
      const update = vi.spyOn(api, 'updateCustomer').mockReturnValue(new Promise(() => {}) as never);
      const onClose = vi.fn();
      render(<CustomerModal customer={acme} onClose={onClose} />);
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'ACME Ltd' } });
      const button = save();
      const cancel = screen.getByRole('button', { name: 'Cancel' });
      const x = screen.getByRole('button', { name: 'Close' });
      act(() => {
        button.click();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        cancel.click();
        x.click();
        button.click();
      });
      await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('a namesake (F08, R01)', () => {
    it('the warning asks; «Save anyway» sends the CURRENT draft with the flag', async () => {
      const update = vi.spyOn(api, 'updateCustomer').mockRejectedValueOnce(nameTaken()).mockResolvedValueOnce(acme);
      render(<CustomerModal customer={acme} onClose={() => {}} />);
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Beta' } });
      fireEvent.click(save());
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('A customer with this name already exists: CU-0003');
      expect(alert).toHaveTextContent('Save another customer with this name?');
      expect(save()).toHaveTextContent('Save anyway');
      // An edit made after the warning goes with the agreed save.
      fireEvent.change(within(screen.getAllByTestId('contact-row')[0]).getByLabelText('City'), { target: { value: 'Lviv' } });
      fireEvent.click(save());
      await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
      const second = update.mock.calls[1][1];
      expect(second.name).toBe('Beta');
      expect(second.allow_duplicate_name).toBe(true);
      expect(second.contacts?.[0].city).toBe('Lviv');
    });

    it('after «Save anyway» a refusal of another kind is said alone — no namesake question under it', async () => {
      vi.spyOn(api, 'updateCustomer')
        .mockRejectedValueOnce(nameTaken())
        .mockRejectedValueOnce(new ApiError('Delivery method 7 not found', 422));
      render(<CustomerModal customer={acme} onClose={() => {}} />);
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Beta' } });
      fireEvent.click(save());
      await screen.findByRole('alert');
      fireEvent.click(save());
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Delivery method 7 not found'));
      expect(screen.getByRole('alert')).not.toHaveTextContent('Save another customer with this name?');
    });

    it('a refusal that lands for a name no longer in the field agrees to nothing (R01)', async () => {
      let refuse!: (e: Error) => void;
      vi.spyOn(api, 'updateCustomer').mockReturnValueOnce(new Promise((_, reject) => { refuse = reject; }) as never);
      render(<CustomerModal customer={acme} onClose={() => {}} />);
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Beta' } });
      fireEvent.click(save());
      await waitFor(() => expect(save()).toHaveTextContent('Saving…'));
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Gamma' } });
      await act(async () => refuse(nameTaken()));
      await waitFor(() => expect(save()).not.toHaveTextContent('Saving…'));
      expect(save()).toHaveTextContent('Save customer');
      expect(screen.queryByText('Save another customer with this name?')).toBeNull();
    });

    it('changing the name takes the agreement back: the next save is an ordinary one', async () => {
      const update = vi.spyOn(api, 'updateCustomer').mockRejectedValueOnce(nameTaken()).mockResolvedValueOnce(acme);
      render(<CustomerModal customer={acme} onClose={() => {}} />);
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Beta' } });
      fireEvent.click(save());
      await screen.findByRole('alert');
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Gamma' } });
      expect(save()).toHaveTextContent('Save customer');
      expect(screen.queryByRole('alert')).toBeNull();
      fireEvent.click(save());
      await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
      expect(update.mock.calls[1][1]).toEqual({ name: 'Gamma' });
    });
  });

  describe('the delivery method (F07, F13, R03, R04)', () => {
    it('while the reference is read the chosen method keeps its own name — never «none», never «gone»', () => {
      vi.spyOn(api, 'getDeliveryMethods').mockReturnValue(new Promise(() => {}) as never);
      render(<CustomerModal customer={withMethod} onClose={() => {}} />);
      const select = within(screen.getAllByTestId('contact-row')[0]).getByLabelText('Delivery method') as HTMLSelectElement;
      expect(select.value).toBe('7');
      expect(select.selectedOptions[0].textContent).toBe('Nova Poshta');
      expect(screen.queryByText(/no longer there/)).toBeNull();
    });

    it('a reference that could not be read says so with a retry; the choice and the save stay', async () => {
      vi.spyOn(api, 'getDeliveryMethods').mockRejectedValue(new Error('HTTP 500'));
      const update = vi.spyOn(api, 'updateCustomer').mockResolvedValue(withMethod);
      render(<CustomerModal customer={withMethod} onClose={() => {}} />);
      const row = screen.getAllByTestId('contact-row')[0];
      const note = await within(row).findByRole('status');
      expect(note).toHaveTextContent('Could not read the delivery methods');
      expect(within(note).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
      expect((within(row).getByLabelText('Delivery method') as HTMLSelectElement).value).toBe('7');
      fireEvent.change(within(row).getByLabelText('City'), { target: { value: 'Lviv' } });
      fireEvent.click(save());
      await waitFor(() => expect(update.mock.calls[0][1].contacts?.[0].delivery_method_id).toBe(7));
    });

    it('a current answer without it says «no longer there» and holds a save that sends contacts', async () => {
      vi.spyOn(api, 'getDeliveryMethods').mockResolvedValue([{ id: 8, name: 'Meest', position: 0, contacts_count: 0 }]);
      const update = vi.spyOn(api, 'updateCustomer').mockResolvedValue(withMethod);
      render(<CustomerModal customer={withMethod} onClose={() => {}} />);
      const row = screen.getAllByTestId('contact-row')[0];
      expect(await within(row).findByRole('option', { name: 'Nova Poshta (no longer there)' })).toBeInTheDocument();
      expect(within(row).getByText('Choose another method or clear it')).toBeInTheDocument();
      fireEvent.change(within(row).getByLabelText('City'), { target: { value: 'Lviv' } });
      expect(save()).toBeDisabled();
      expect(update).not.toHaveBeenCalled();
    });

    it('…and does not hold a save that sends no contacts (a name only)', async () => {
      vi.spyOn(api, 'getDeliveryMethods').mockResolvedValue([{ id: 8, name: 'Meest', position: 0, contacts_count: 0 }]);
      const update = vi.spyOn(api, 'updateCustomer').mockResolvedValue(withMethod);
      render(<CustomerModal customer={withMethod} onClose={() => {}} />);
      await screen.findByRole('option', { name: 'Nova Poshta (no longer there)' });
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'ACME Ltd' } });
      fireEvent.click(save());
      await waitFor(() => expect(update).toHaveBeenCalledWith(1, { name: 'ACME Ltd' }));
    });

    it('a method renamed in the reference adds no contacts to a PATCH (Codex note 2)', async () => {
      vi.spyOn(api, 'getDeliveryMethods').mockResolvedValue([{ id: 7, name: 'NP renamed', position: 0, contacts_count: 1 }]);
      const update = vi.spyOn(api, 'updateCustomer').mockResolvedValue(withMethod);
      render(<CustomerModal customer={withMethod} onClose={() => {}} />);
      await screen.findByRole('option', { name: 'NP renamed' });
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'ACME Ltd' } });
      fireEvent.click(save());
      await waitFor(() => expect(update).toHaveBeenCalledWith(1, { name: 'ACME Ltd' }));
    });

    it('a failed re-read of the methods is said ONCE, beside the contacts, with a retry (Codex E11-V04)', async () => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
      client.setQueryData(['delivery-methods'], [{ id: 7, name: 'Nova Poshta', position: 0, contacts_count: 1 }]);
      const read = vi.spyOn(api, 'getDeliveryMethods').mockRejectedValue(new Error('offline'));
      render(
        <QueryClientProvider client={client}>
          <CustomerModal customer={acme} onClose={() => {}} />
        </QueryClientProvider>,
      );
      await act(async () => {
        await client.refetchQueries({ queryKey: ['delivery-methods'] });
      });
      await waitFor(() => expect(client.getQueryState(['delivery-methods'])?.status).toBe('error'));
      const retries = await screen.findAllByRole('button', { name: 'Retry' });
      expect(retries).toHaveLength(1);
      for (const row of screen.getAllByTestId('contact-row')) expect(within(row).queryByRole('button', { name: 'Retry' })).toBeNull();
      // The options stay; nothing is said to be gone.
      expect(within(screen.getAllByTestId('contact-row')[0]).getByRole('option', { name: 'Nova Poshta' })).toBeInTheDocument();
      const before = read.mock.calls.length;
      fireEvent.click(retries[0]);
      await waitFor(() => expect(read.mock.calls.length).toBe(before + 1));
    });

    it('…an empty reference that could not be refreshed says so too', async () => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
      client.setQueryData(['delivery-methods'], []);
      vi.spyOn(api, 'getDeliveryMethods').mockRejectedValue(new Error('offline'));
      render(
        <QueryClientProvider client={client}>
          <CustomerModal onClose={() => {}} />
        </QueryClientProvider>,
      );
      await act(async () => {
        await client.refetchQueries({ queryKey: ['delivery-methods'] });
      });
      await waitFor(() => expect(client.getQueryState(['delivery-methods'])?.status).toBe('error'));
      expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    });

    it('a method made in the reference is offered even when the reference was never read (Codex E11-V03)', async () => {
      vi.spyOn(api, 'getDeliveryMethods').mockRejectedValue(new Error('offline'));
      vi.spyOn(api, 'createDeliveryMethod').mockResolvedValue({ id: 9, name: 'New method', position: 9, contacts_count: 0 });
      render(<CustomerModal onClose={() => {}} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Manage methods…' }));
      const field = await screen.findByRole('textbox', { name: 'New delivery method' });
      fireEvent.change(field, { target: { value: 'New method' } });
      fireEvent.click(screen.getByRole('button', { name: /^add$/i }));
      await waitFor(() => expect(field).toHaveValue(''));
      fireEvent.click(screen.getByRole('button', { name: 'Done' }));
      await waitFor(() => expect(screen.getByRole('option', { name: 'New method' })).toBeInTheDocument());
    });

    it('…and the method a contact already has is not called gone by that partial list; the failure and its retry stay', async () => {
      vi.spyOn(api, 'getDeliveryMethods').mockRejectedValue(new Error('offline'));
      vi.spyOn(api, 'createDeliveryMethod').mockResolvedValue({ id: 9, name: 'New method', position: 9, contacts_count: 0 });
      render(<CustomerModal customer={withMethod} onClose={() => {}} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Manage methods…' }));
      const field = await screen.findByRole('textbox', { name: 'New delivery method' });
      fireEvent.change(field, { target: { value: 'New method' } });
      fireEvent.click(screen.getByRole('button', { name: /^add$/i }));
      await waitFor(() => expect(field).toHaveValue(''));
      fireEvent.click(screen.getByRole('button', { name: 'Done' }));
      const row = screen.getAllByTestId('contact-row')[0];
      await within(row).findByRole('option', { name: 'New method' });
      const select = within(row).getByLabelText('Delivery method') as HTMLSelectElement;
      expect(select.value).toBe('7');
      expect(select.selectedOptions[0].textContent).toBe('Nova Poshta');
      expect(within(row).queryByText(/no longer there/)).toBeNull();
      expect(within(row).getByText('Could not read the delivery methods')).toBeInTheDocument();
    });

    it('a failed re-read keeps the methods it had in the select — no «could not read» in every row', async () => {
      vi.spyOn(api, 'getDeliveryMethods')
        .mockResolvedValueOnce([{ id: 7, name: 'Nova Poshta', position: 0, contacts_count: 1 }])
        .mockRejectedValue(new Error('HTTP 500'));
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={client}>
          <CustomerModal customer={withMethod} onClose={() => {}} />
        </QueryClientProvider>,
      );
      const row = screen.getAllByTestId('contact-row')[0];
      await within(row).findByRole('option', { name: 'Nova Poshta' });
      await act(async () => {
        await client.refetchQueries({ queryKey: ['delivery-methods'] });
      });
      await waitFor(() => expect(client.getQueryState(['delivery-methods'])?.status).toBe('error'));
      expect(within(row).queryByText('Could not read the delivery methods')).toBeNull();
      expect(within(row).getByRole('option', { name: 'Nova Poshta' })).toBeInTheDocument();
    });

    it('somebody who may create but not update customers chooses a method and is not offered to manage them', async () => {
      asCreator();
      render(<CustomerModal onClose={() => {}} />);
      const row = screen.getAllByTestId('contact-row')[0];
      await within(row).findByRole('option', { name: 'Nova Poshta' });
      await waitFor(() => expect(within(row).queryByRole('button', { name: 'Manage methods…' })).toBeNull());
    });

    it('a method made in the reference is offered at once; a failed re-read of the list loses nothing typed', async () => {
      const methods = vi
        .spyOn(api, 'getDeliveryMethods')
        .mockResolvedValueOnce([{ id: 7, name: 'Nova Poshta', position: 0, contacts_count: 1 }])
        .mockRejectedValue(new Error('HTTP 500'));
      vi.spyOn(api, 'createDeliveryMethod').mockResolvedValue({ id: 8, name: 'Meest', position: 1, contacts_count: 0 });
      render(<CustomerModal customer={acme} onClose={() => {}} />);
      const row = screen.getAllByTestId('contact-row')[0];
      fireEvent.change(within(row).getByLabelText('City'), { target: { value: 'Lviv' } });
      fireEvent.click(await within(row).findByRole('button', { name: 'Manage methods…' }));
      const reference = await screen.findByRole('dialog', { name: 'Delivery methods' });
      fireEvent.change(within(reference).getByLabelText('New delivery method'), { target: { value: 'Meest' } });
      fireEvent.click(within(reference).getByRole('button', { name: 'Add' }));
      await waitFor(() => expect(methods.mock.calls.length).toBeGreaterThan(1));
      expect(within(row).getByRole('option', { name: 'Meest' })).toBeInTheDocument();
      expect(within(row).getByLabelText('City')).toHaveValue('Lviv');
      expect(screen.getByRole('dialog', { name: 'Edit customer' })).toBeInTheDocument();
    });
  });

  it('«Make main» moves a row to the top and the save keeps ids in the new order', async () => {
    const update = vi.spyOn(api, 'updateCustomer').mockResolvedValue(acme);
    render(<CustomerModal customer={acme} onClose={() => {}} />);
    const second = screen.getAllByTestId('contact-row')[1];
    fireEvent.click(within(second).getByRole('button', { name: 'Make main' }));
    expect(within(screen.getAllByTestId('contact-row')[0]).getByLabelText('Contact name')).toHaveValue('Serhii');
    fireEvent.click(save());
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][1].contacts!.map((c) => c.id)).toEqual([11, 10]);
  });

  it('removing a contact orders name asks first and warns what happens', async () => {
    const update = vi.spyOn(api, 'updateCustomer').mockResolvedValue(acme);
    render(<CustomerModal customer={acme} onClose={() => {}} />);
    const linked = screen.getAllByTestId('contact-row')[1];
    fireEvent.click(within(linked).getByRole('button', { name: 'Remove contact' }));
    expect(within(linked).getByText('Linked to 2 orders — they will lose their contact')).toBeInTheDocument();
    fireEvent.click(within(linked).getByRole('button', { name: 'Remove anyway' }));
    expect(screen.getAllByTestId('contact-row')).toHaveLength(1);
    const free = screen.getAllByTestId('contact-row')[0];
    fireEvent.click(within(free).getByRole('button', { name: 'Remove contact' })); // unlinked: at once
    expect(screen.queryAllByTestId('contact-row')).toHaveLength(0);
    fireEvent.click(save());
    await waitFor(() => expect(update.mock.calls[0][1].contacts).toEqual([]));
  });

  it('each contact row is a group named by its place, so its buttons are told apart', () => {
    render(<CustomerModal customer={acme} onClose={() => {}} />);
    const second = screen.getByRole('group', { name: 'Contact 2' });
    expect(within(second).getByRole('button', { name: 'Make main' })).toBeInTheDocument();
    const first = screen.getByRole('group', { name: 'Contact 1' });
    expect(within(first).queryByRole('button', { name: 'Make main' })).not.toBeInTheDocument();
  });

  it('warns in the singular about one linked order', () => {
    const one = { ...acme, contacts: [{ ...acme.contacts[1], orders_count: 1 }] };
    render(<CustomerModal customer={one} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove contact' }));
    expect(screen.getByText('Linked to 1 order — it will lose its contact')).toBeInTheDocument();
  });

  it('a contact note keeps its line breaks', async () => {
    const update = vi.spyOn(api, 'updateCustomer').mockResolvedValue(acme);
    render(<CustomerModal customer={acme} onClose={() => {}} />);
    const row = screen.getAllByTestId('contact-row')[0];
    fireEvent.click(within(row).getByRole('button', { name: '+ Note' }));
    const note = within(row).getByLabelText('Note');
    expect(note.tagName).toBe('TEXTAREA');
    fireEvent.change(note, { target: { value: 'line one\nline two' } });
    fireEvent.click(save());
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][1].contacts![0].note).toBe('line one\nline two');
  });

  it('a linked contact emptied of every field must be filled in or removed before the save', () => {
    const update = vi.spyOn(api, 'updateCustomer').mockResolvedValue(acme);
    render(<CustomerModal customer={acme} onClose={() => {}} />);
    const linked = screen.getAllByTestId('contact-row')[1];
    // Serhii has only a name: clearing it would drop the row — and, silently, the contact of his 2 orders.
    fireEvent.change(within(linked).getByLabelText('Contact name'), { target: { value: '' } });
    expect(within(linked).getByText('Linked to 2 orders — fill it in or remove it')).toBeInTheDocument();
    expect(save()).toBeDisabled();
    fireEvent.submit(save().closest('form') ?? document.getElementById(save().getAttribute('form') ?? '')!);
    expect(update).not.toHaveBeenCalled();
  });

  it('adding a method in the reference never submits the customer form around it', async () => {
    const create = vi
      .spyOn(api, 'createDeliveryMethod')
      .mockResolvedValue({ id: 8, name: 'Meest', position: 1, contacts_count: 0 });
    const update = vi.spyOn(api, 'updateCustomer').mockResolvedValue(acme);
    const onClose = vi.fn();
    render(<CustomerModal customer={acme} onClose={onClose} />);
    fireEvent.click(await within(screen.getAllByTestId('contact-row')[0]).findByRole('button', { name: 'Manage methods…' }));
    const reference = await screen.findByRole('dialog', { name: 'Delivery methods' });
    fireEvent.change(within(reference).getByLabelText('New delivery method'), { target: { value: 'Meest' } });
    fireEvent.click(within(reference).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('Meest'));
    expect(update).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Edit customer' })).toBeInTheDocument();
  });
});
