import type { CustomerContact } from '../../api/client';

/** «Kyiv · Nova Poshta · branch 12» — the parts that are there. */
export function deliveryLine(contact: CustomerContact): string {
  return [contact.city, contact.delivery_method_name, contact.delivery_details].filter(Boolean).join(' · ');
}

/**
 * A `mailto:` for an address typed by hand: the server stores it as written, so its own
 * `?`, `&` or `#` would otherwise add a recipient, a subject or a body to the letter the
 * click opens (security review of WS-13 E11). The `@` stays readable.
 */
export function mailtoHref(email: string): string {
  return `mailto:${encodeURIComponent(email.trim()).replace(/%40/g, '@')}`;
}

/** A `tel:` keeps the digits and the plus only. */
export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, '')}`;
}

/** «Nova Poshta · branch 12» — the method and its details, under the city (WS-13 E11 C05). */
export function methodLine(contact: CustomerContact): string {
  return [contact.delivery_method_name, contact.delivery_details].filter(Boolean).join(' · ');
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
