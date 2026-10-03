import type { CustomerContact } from '../../api/client';
import { mailtoHref, telHref } from './contactFormat';

/** A contact's phone and e-mail as links, «phone · email», nothing when neither is there. */
export function ContactReach({ contact, className = '' }: { contact: CustomerContact; className?: string }) {
  if (!contact.phone && !contact.email) return null;
  return (
    <span className={className}>
      {contact.phone && (
        <a href={telHref(contact.phone)} className="hover:text-white">
          {contact.phone}
        </a>
      )}
      {contact.phone && contact.email && ' · '}
      {contact.email && (
        <a href={mailtoHref(contact.email)} className="hover:text-white">
          {contact.email}
        </a>
      )}
    </span>
  );
}
