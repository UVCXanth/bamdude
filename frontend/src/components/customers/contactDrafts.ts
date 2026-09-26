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

/**
 * A row with nothing in it. It is not sent, and the server drops it too — so a
 * blank row that orders name would take their contact away without the warning
 * «Remove» gives; the form refuses to save one (see `ContactRowsEditor`).
 */
export function isBlankDraft(d: ContactDraft): boolean {
  return (
    d.deliveryMethodId == null &&
    [d.name, d.role, d.phone, d.email, d.city, d.deliveryDetails, d.note].every((v) => v.trim() === '')
  );
}

/** A blank row that orders still name — it must be filled in or removed before the save. */
export const isBlankLinked = (d: ContactDraft) => d.ordersCount > 0 && isBlankDraft(d);

/** The rows as the server takes them, in order; a blank row is left out. */
export function draftsToInput(drafts: ContactDraft[]): CustomerContactInput[] {
  return drafts
    .filter((d) => !isBlankDraft(d))
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
    }));
}
