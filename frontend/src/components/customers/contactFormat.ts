import type { CustomerContact } from '../../api/client';

/** «Kyiv · Nova Poshta · branch 12» — the parts that are there. */
export function deliveryLine(contact: CustomerContact): string {
  return [contact.city, contact.delivery_method_name, contact.delivery_details].filter(Boolean).join(' · ');
}

/** What names a contact on screen: its name, else its role, else its code. */
export function contactTitle(contact: CustomerContact): string {
  return contact.name ?? contact.role ?? contact.code;
}
