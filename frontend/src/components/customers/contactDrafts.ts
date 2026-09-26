import type { CustomerContact, CustomerContactInput } from '../../api/client';

/** One row of the form while it is being edited — strings for inputs, a local key for React. */
export interface ContactDraft {
  key: string;
  id?: number;
  ordersCount: number;
  name: string;
  role: string;
  phone: string;
  email: string;
  city: string;
  deliveryMethodId: number | null;
  deliveryDetails: string;
  note: string;
}

let seq = 0;
const nextKey = () => `draft-${++seq}`;

export function emptyDraft(): ContactDraft {
  return {
    key: nextKey(),
    ordersCount: 0,
    name: '',
    role: '',
    phone: '',
    email: '',
    city: '',
    deliveryMethodId: null,
    deliveryDetails: '',
    note: '',
  };
}

export function draftFromContact(c: CustomerContact): ContactDraft {
  return {
    key: nextKey(),
    id: c.id,
    ordersCount: c.orders_count,
    name: c.name ?? '',
    role: c.role ?? '',
    phone: c.phone ?? '',
    email: c.email ?? '',
    city: c.city ?? '',
    deliveryMethodId: c.delivery_method_id,
    deliveryDetails: c.delivery_details ?? '',
    note: c.note ?? '',
  };
}

const clean = (value: string) => (value.trim() === '' ? null : value.trim());

/** The rows as the server takes them, in order; a row with nothing in it is left out (the server drops it too). */
export function draftsToInput(drafts: ContactDraft[]): CustomerContactInput[] {
  return drafts
    .map((d) => ({
      ...(d.id != null ? { id: d.id } : {}),
      name: clean(d.name),
      role: clean(d.role),
      phone: clean(d.phone),
      email: clean(d.email),
      city: clean(d.city),
      delivery_method_id: d.deliveryMethodId,
      delivery_details: clean(d.deliveryDetails),
      note: clean(d.note),
    }))
    .filter((c) => Object.entries(c).some(([k, v]) => k !== 'id' && v != null));
}
