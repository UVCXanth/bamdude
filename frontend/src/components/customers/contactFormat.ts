import type { CustomerContact } from '../../api/client';

/** «Kyiv · Nova Poshta · branch 12» — the parts that are there. */
export function deliveryLine(contact: CustomerContact): string {
  return [contact.city, contact.delivery_method_name, contact.delivery_details].filter(Boolean).join(' · ');
}

/**
 * What names a contact on screen: its name, else its role, else its code.
 * Structural, so an order's contact (`OrderContact`) is named the same way.
 */
export function contactTitle(contact: Pick<CustomerContact, 'name' | 'role' | 'code'>): string {
  return contact.name ?? contact.role ?? contact.code;
}

/** A contact as a choice in a list: its title, and its role when the title is the name. */
export function contactOption(contact: Pick<CustomerContact, 'name' | 'role' | 'code'>): string {
  return contact.name && contact.role ? `${contact.name} — ${contact.role}` : contactTitle(contact);
}
